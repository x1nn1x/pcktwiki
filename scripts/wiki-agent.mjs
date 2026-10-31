#!/usr/bin/env node
/**
 * wiki-agent — maintain a Lichen wiki on an AT Protocol PDS from the command line.
 *
 * Built for agent-driven wiki maintenance (and manual ops): reads are public;
 * writes authenticate with a Bluesky APP PASSWORD (never your account password).
 *
 * Credentials live in `.env.agent` (gitignored):
 *   AGENT_HANDLE=oseanstudio.bsky.social
 *   AGENT_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
 *   AGENT_WIKI_REF=at://did:plc:…/wiki.lichen.wiki/oseanworld   (optional; resolved from handle otherwise)
 *
 * Commands:
 *   node scripts/wiki-agent.mjs whoami
 *   node scripts/wiki-agent.mjs list <collection>            e.g. wiki.lichen.note
 *   node scripts/wiki-agent.mjs content <slug>               reconstructed article text
 *   node scripts/wiki-agent.mjs optimize-images [--dry-run]  re-encode images to display size
 *   node scripts/wiki-agent.mjs upload-blob <file>           stage a blob, print its ref JSON
 *   node scripts/wiki-agent.mjs put-record <collection> <rkey> <json-file>
 *
 * Writes require AGENT_APP_PASSWORD; every read works without one.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { diff_match_patch: DiffMatchPatch } = require('diff-match-patch')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = resolve(ROOT, '.env.agent')
const PUBLIC_BSKY = 'https://public.api.bsky.app'
const PLC = 'https://plc.directory'

// TIDs match the atproto spec: 41 bits of microseconds + 22 bits of clock,
// base32-sortable. The app writes them via @atcute/tid; this is the same shape.
const TID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
function newTid() {
  const us = BigInt(Date.now()) * 1000n
  const clock = BigInt(Math.floor(Math.random() * (1 << 22)))
  let value = (us << 22n) | clock
  if (value >> 63n) value &= (1n << 63n) - 1n
  let out = ''
  for (let i = 0; i < 13; i++) {
    out = TID_ALPHABET[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}

function loadEnv() {
  // The repo's home wiki is the default target; .env.agent overrides or adds
  // the app password for writes.
  const env = { AGENT_HANDLE: 'oseanstudio.bsky.social' }
  if (!existsSync(ENV_FILE)) return env
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

async function api(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) {
    const detail =
      typeof body === 'object' && body !== null
        ? JSON.stringify(body).slice(0, 300)
        : String(body).slice(0, 300)
    throw new Error(`${response.status} ${new URL(url).pathname}: ${detail}`)
  }
  return body
}

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra })

async function resolveIdentity(handleOrDid) {
  let did = handleOrDid
  if (!did.startsWith('did:')) {
    const r = await api(`${PUBLIC_BSKY}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handleOrDid)}`)
    did = r.did
  }
  const doc = await api(`${PLC}/${did}`)
  const pds = doc.service?.find((s) => s.id.endsWith('#atproto_pds'))?.serviceEndpoint
  const handle = doc.alsoKnownAs?.[0]?.replace('at://', '') ?? did
  if (!pds) throw new Error(`No PDS in DID document for ${did}`)
  return { did, pds, handle }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

async function listAll(pds, repo, collection) {
  const out = []
  let cursor
  do {
    const url = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`)
    url.searchParams.set('repo', repo)
    url.searchParams.set('collection', collection)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const page = await api(url)
    out.push(...page.records)
    cursor = page.cursor
  } while (cursor)
  return out
}

const normalizeLF = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

const dmp = new DiffMatchPatch()
function createDiff(oldText, newText) {
  return dmp.patch_toText(dmp.patch_make(oldText, newText))
}
function tryApplyDiff(text, patchText) {
  if (!patchText.trim()) return text
  try {
    const patches = dmp.patch_fromText(patchText)
    const [result, applied] = dmp.patch_apply(patches, text)
    return applied.every((ok) => ok) ? result : null
  } catch {
    return null
  }
}

/** Mirror of the app's revision ordering: root first, then parent chain, then rest by time. */
const createdAt = (r) => r.value.createdAt ?? ''
function orderRevisions(revisions) {
  const byUri = new Map(revisions.map((r) => [r.uri, r]))
  const roots = revisions.filter((r) => !r.parentRevision)
  if (roots.length === 0) {
    return [...revisions].sort((a, b) => createdAt(a).localeCompare(createdAt(b)))
  }
  const ordered = []
  const visited = new Set()
  let current = [...roots].sort((a, b) => createdAt(a).localeCompare(createdAt(b)))[0]
  while (current && !visited.has(current.uri)) {
    ordered.push(current)
    visited.add(current.uri)
    current = [...byUri.values()].find((r) => r.parentRevision === current.uri)
  }
  for (const r of revisions) if (!visited.has(r.uri)) ordered.push(r)
  return ordered.sort((a, b) => createdAt(a).localeCompare(createdAt(b)))
}

function replayNote(revisions) {
  let content = ''
  let latest = null
  for (const rev of orderRevisions(revisions)) {
    if (rev.value.diffFormat !== 'diff-match-patch') {
      if (typeof rev.value.snapshot === 'string') {
        content = normalizeLF(rev.value.snapshot)
        latest = rev.uri
      }
      continue
    }
    const next = tryApplyDiff(content, rev.value.diff ?? '')
    if (next !== null) content = normalizeLF(next)
    if (typeof rev.value.snapshot === 'string') content = normalizeLF(rev.value.snapshot)
    latest = rev.uri
  }
  return { content, latestRevisionUri: latest }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let session = null
async function getSession(env) {
  if (session) return session
  if (!env.AGENT_HANDLE || !env.AGENT_APP_PASSWORD) {
    throw new Error(
      'Writes need AGENT_HANDLE and AGENT_APP_PASSWORD in .env.agent — create an app password at bsky.app/settings/app-passwords',
    )
  }
  const { pds } = await resolveIdentity(env.AGENT_HANDLE)
  const result = await api(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ identifier: env.AGENT_HANDLE, password: env.AGENT_APP_PASSWORD }),
  })
  session = { ...result, pds }
  return session
}

async function authenticatedApi(jwt, pds, path, body, method = 'POST') {
  return api(`${pds}/xrpc/${path}`, {
    method,
    headers: jsonHeaders({ Authorization: `Bearer ${jwt}` }),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function putRecord(env, collection, rkey, record) {
  const s = await getSession(env)
  return authenticatedApi(s.accessJwt, s.pds, 'com.atproto.repo.putRecord', {
    repo: s.did,
    collection,
    rkey,
    record,
  })
}

async function uploadBlob(env, bytes, mimeType) {
  const s = await getSession(env)
  const response = await fetch(`${s.pds}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.accessJwt}`, 'Content-Type': mimeType },
    body: bytes,
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`uploadBlob: ${response.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body.blob
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

/** Read pixel dimensions from PNG/JPEG/GIF/WEBP headers. */
function imageDimensions(bytes) {
  const b = bytes
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i += 1; continue }
      const marker = b[i + 1]
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
  }
  // WEBP (VP8 / VP8L / VP8X)
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
      return { width: w, height: h, hasAnimation: (b[20] & 0x02) !== 0 }
    }
  }
  return { width: 0, height: 0 }
}

/** Animated GIFs/WebPs carry multiple frames; keep their animation on re-encode. */
function isAnimated(bytes, mime) {
  if (mime === 'image/gif') {
    let frames = 0
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) frames += 1
    }
    return frames > 1
  }
  if (mime === 'image/webp') return imageDimensions(bytes).hasAnimation ?? false
  return false
}

function encodeWebp(inputPath, outputPath, { width, lossless, animated }) {
  if (animated) {
    execFileSync('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', `scale=${width}:-2:flags=lanczos`,
      '-c:v', 'libwebp_anim', '-lossless', lossless ? '1' : '0', '-q:v', '100',
      '-loop', '0', outputPath,
    ], { stdio: 'pipe' })
    return
  }
  execFileSync('cwebp', [
    inputPath,
    '-resize', String(width), '0',
    lossless ? '-lossless' : '-q', ...(lossless ? [] : ['100']),
    '-m', '6', '-o', outputPath,
  ], { stdio: 'pipe' })
}

const BLOB_RE = /blob:(bafkrei[a-z0-9]+)/g
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }

function blobJson(cid, size) {
  return { $type: 'blob', ref: { $link: cid }, mimeType: 'image/webp', size }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function resolveWiki(env) {
  if (env.AGENT_WIKI_REF) {
    const [did, , rkey] = env.AGENT_WIKI_REF.replace('at://', '').split('/')
    const { pds } = await resolveIdentity(did)
    return { did, pds, rkey }
  }
  const { did, pds, handle } = await resolveIdentity(env.AGENT_HANDLE)
  const wikis = await listAll(pds, did, 'wiki.lichen.wiki')
  const active = wikis.filter((r) => !r.value.deletedAt && !r.value.redirectSlug)
  if (active.length !== 1) {
    throw new Error(
      `${handle} has ${active.length} active wikis — set AGENT_WIKI_REF in .env.agent to pick one`,
    )
  }
  return { did, pds, rkey: active[0].uri.split('/').pop() }
}

async function cmdWhoami(env) {
  if (!env.AGENT_HANDLE) return console.log('No AGENT_HANDLE configured in .env.agent')
  const { did, pds, handle } = await resolveIdentity(env.AGENT_HANDLE)
  let auth = 'read-only (no app password configured)'
  if (env.AGENT_APP_PASSWORD) {
    try {
      const s = await getSession(env)
      auth = `write access as ${s.handle ?? handle}`
    } catch (err) {
      auth = `write FAILED: ${err.message.slice(0, 120)}`
    }
  }
  console.log(`identity : ${handle} (${did})`)
  console.log(`pds      : ${pds}`)
  console.log(`auth     : ${auth}`)
}

async function cmdList(env, collection) {
  const wiki = await resolveWiki(env)
  const records = await listAll(wiki.pds, wiki.did, collection)
  for (const r of records) {
    const v = r.value
    const label = v.slug ?? v.title ?? v.name ?? v.memberDid ?? ''
    console.log(`${r.uri.split('/').pop().slice(0, 24).padEnd(24)} ${label}`)
  }
  console.log(`— ${records.length} ${collection}`)
}

async function cmdContent(env, slug) {
  const wiki = await resolveWiki(env)
  const notes = await listAll(wiki.pds, wiki.did, 'wiki.lichen.note')
  const note = notes.find((n) => n.value.slug === slug)
  if (!note) throw new Error(`No note with slug "${slug}"`)
  const revisions = await listAll(wiki.pds, wiki.did, 'wiki.lichen.noteRevision')
  const { content } = replayNote(revisions.filter((r) => r.value.noteRef === note.uri))
  process.stdout.write(content)
}

/** The optimization pass: right-size every image to its display role, re-encode WebP. */
async function cmdOptimizeImages(env, dryRun) {
  const wiki = await resolveWiki(env)
  const [wikiRecords, notes, revisions] = await Promise.all([
    listAll(wiki.pds, wiki.did, 'wiki.lichen.wiki'),
    listAll(wiki.pds, wiki.did, 'wiki.lichen.note'),
    listAll(wiki.pds, wiki.did, 'wiki.lichen.noteRevision'),
  ])
  const wikiRec = wikiRecords.find((r) => r.uri.endsWith(`/${wiki.rkey}`))
  const contents = new Map(notes.map((n) => [n.uri, replayNote(revisions.filter((r) => r.value.noteRef === n.uri))]))

  // cid → { mime, size, blob (original record JSON), role }
  const images = new Map()
  function see(cid, mime, size, blob, role) {
    const entry = images.get(cid) ?? { mime, size, blob, role, where: [] }
    entry.role = role === 'content' ? entry.role : role // fixed roles win over content
    entry.where.push(role)
    images.set(cid, entry)
  }
  const fromJson = (blob, role, where) => {
    const cid = blob?.ref?.$link
    if (cid) see(cid, blob.mimeType, blob.size ?? 0, blob, role, where)
  }
  fromJson(wikiRec.value.headerImage, 'header', 'wiki.headerImage')
  for (const l of wikiRec.value.headerLinks ?? []) fromJson(l.image, 'nav', `headerLink:${l.label}`)
  for (const n of notes)
    for (const l of n.value.subheaderLinks ?? []) fromJson(l.image, 'nav', `${n.value.slug}:${l.label}`)
  for (const r of revisions)
    for (const b of r.value.blobs ?? [])
      fromJson(b, 'content', `rev:${r.uri.split('/').pop().slice(0, 8)}`)
  for (const [uri, state] of contents)
    for (const m of state.content.matchAll(BLOB_RE)) see(m[1], null, 0, null, 'content')

  const TARGET = { header: 128, nav: 240, content: 1388 }
  const plan = []
  for (const [cid, info] of images) {
    const bytes = Buffer.from(
      await (await fetch(`${wiki.pds}/xrpc/com.atproto.sync.getBlob?did=${wiki.did}&cid=${cid}`)).arrayBuffer(),
    )
    const dims = imageDimensions(bytes)
    if (!dims.width) {
      console.warn(`? skip (unreadable header): ${cid.slice(0, 16)}`)
      continue
    }
    const targetWidth = Math.min(dims.width, TARGET[info.role] ?? TARGET.content)
    const animated = isAnimated(bytes, info.mime ?? '')
    const needsShrink = targetWidth < dims.width
    const needsFormat = info.mime !== 'image/webp'
    if (!needsShrink && !needsFormat && !animated) {
      console.log(`= keep  ${cid.slice(0, 16)}  ${dims.width}x${dims.height} ${(bytes.length / 1024).toFixed(0)}KB (already optimal)`)
      continue
    }
    plan.push({ cid, info, bytes, dims, targetWidth, animated })
  }

  if (dryRun) {
    console.log(`\nDRY RUN — ${plan.length} images would be re-encoded:`)
    for (const p of plan) {
      console.log(
        `  ${(p.bytes.length / 1024).toFixed(0).padStart(6)}KB  ${p.dims.width}x${p.dims.height} ${p.info.mime} → ${p.targetWidth}px webp${p.animated ? ' (animated)' : ''}  [${p.info.role}] ${[...new Set(p.info.where)].join(', ').slice(0, 60)}`,
      )
    }
    return
  }

  // Encode + upload
  const uploads = new Map() // oldCid → { cid, size }
  const tmp = `/tmp/wiki-agent-${Date.now()}`
  execFileSync('mkdir', ['-p', tmp])
  try {
    for (const p of plan) {
      const src = `${tmp}/${p.cid}${EXT[p.info.mime] ?? '.bin'}`
      writeFileSync(src, p.bytes)
      const out = `${tmp}/${p.cid}.webp`
      const lossless = p.info.mime !== 'image/jpeg' // illustrations stay pixel-exact
      try {
        encodeWebp(src, out, { width: p.targetWidth, lossless, animated: p.animated })
      } catch (err) {
        console.warn(`! encode failed for ${p.cid.slice(0, 16)}: ${String(err.message).slice(0, 100)}`)
        continue
      }
      const outBytes = readFileSync(out)
      if (outBytes.length >= p.bytes.length) {
        console.log(`= no gain for ${p.cid.slice(0, 16)} (${(outBytes.length / 1024).toFixed(0)}KB ≥ ${(p.bytes.length / 1024).toFixed(0)}KB) — keeping original`)
        continue
      }
      const blob = await uploadBlob(env, outBytes, 'image/webp')
      uploads.set(p.cid, {
        cid: blob.ref.$link,
        size: blob.size,
        original: p.info.blob,
        originalMime: p.info.mime,
      })
      console.log(
        `✓ ${p.cid.slice(0, 16)}  ${(p.bytes.length / 1024).toFixed(0).padStart(5)}KB → ${(outBytes.length / 1024).toFixed(0).padStart(4)}KB webp  ${p.dims.width}→${p.targetWidth}px${p.animated ? ' animated' : ''}`,
      )
    }
  } finally {
    execFileSync('rm', ['-rf', tmp])
  }
  if (!uploads.size) return console.log('Nothing to update.')

  const newRef = (oldCid) => {
    const u = uploads.get(oldCid)
    if (!u) return null
    return blobJson(u.cid, u.size)
  }
  const swapRefs = (list) =>
    list?.map((l) => {
      const ref = newRef(l.image?.ref?.$link)
      return ref ? { ...l, image: ref } : l
    })

  // 1. Wiki record (header image + header links)
  const wv = wikiRec.value
  const nextWiki = { ...wv }
  let wikiDirty = false
  if (wv.headerImage?.ref?.$link && uploads.has(wv.headerImage.ref.$link)) {
    nextWiki.headerImage = newRef(wv.headerImage.ref.$link)
    wikiDirty = true
  }
  const nextLinks = swapRefs(wv.headerLinks)
  if (nextLinks && JSON.stringify(nextLinks) !== JSON.stringify(wv.headerLinks)) {
    nextWiki.headerLinks = nextLinks
    wikiDirty = true
  }
  if (wikiDirty) {
    await putRecord(env, 'wiki.lichen.wiki', wiki.rkey, nextWiki)
    console.log(`✓ wiki record updated (${wiki.rkey})`)
  }

  // 2. Note records (subheader link images)
  for (const n of notes) {
    const nextSubs = swapRefs(n.value.subheaderLinks)
    if (nextSubs && JSON.stringify(nextSubs) !== JSON.stringify(n.value.subheaderLinks)) {
      await putRecord(env, 'wiki.lichen.note', n.uri.split('/').pop(), { ...n.value, subheaderLinks: nextSubs })
      console.log(`✓ note record updated (${n.value.slug})`)
    }
  }

  // 3. Article content — one new revision per changed note
  for (const [noteUri, state] of contents) {
    const note = notes.find((n) => n.uri === noteUri)
    let next = state.content
    for (const [oldCid, u] of uploads) {
      if (next.includes(`blob:${oldCid}`)) next = next.split(`blob:${oldCid}`).join(`blob:${u.cid}`)
    }
    if (next === state.content) continue
    const diff = createDiff(state.content, next)
    if (!diff.trim()) continue
    // Attach refs for every blob the new content references so getBlob keeps working.
    const refs = []
    for (const m of next.matchAll(BLOB_RE)) {
      const cid = m[1]
      if (uploads.has(cid)) refs.push(blobJson(uploads.get(cid).cid, uploads.get(cid).size))
      else if (images.get(cid)?.blob) refs.push(images.get(cid).blob)
    }
    const record = {
      $type: 'wiki.lichen.noteRevision',
      noteRef: noteUri,
      diff,
      diffFormat: 'diff-match-patch',
      createdAt: new Date().toISOString(),
      message: 'Optimize images: resize to display size, re-encode as WebP',
      ...(state.latestRevisionUri ? { parentRevision: state.latestRevisionUri } : {}),
      ...(refs.length ? { blobs: refs } : {}),
    }
    await putRecord(env, 'wiki.lichen.noteRevision', newTid(), record)
    console.log(`✓ revision written (${note.value.slug})`)
  }
  console.log('Done.')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const env = loadEnv()
const [command, ...args] = process.argv.slice(2)
const commands = {
  whoami: () => cmdWhoami(env),
  list: () => cmdList(env, args[0]),
  content: () => cmdContent(env, args[0]),
  'optimize-images': () => cmdOptimizeImages(env, args.includes('--dry-run')),
  'upload-blob': async () => {
    const file = resolve(args[0])
    const mime = args[1] ?? 'image/webp'
    const blob = await uploadBlob(env, readFileSync(file), mime)
    console.log(JSON.stringify(blob))
  },
  'put-record': async () => {
    const [, collection, rkey, file] = args
    const record = JSON.parse(readFileSync(resolve(file), 'utf8'))
    const result = await putRecord(env, collection, rkey, record)
    console.log(JSON.stringify(result, null, 2))
  },
}

if (!commands[command]) {
  console.log('Commands: whoami | list <collection> | content <slug> | optimize-images [--dry-run] | upload-blob <file> | put-record <collection> <rkey> <json-file>')
  process.exit(1)
}
commands[command]().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
