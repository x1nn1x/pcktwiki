import type { Agent } from '@atproto/api'
import * as TID from '@atcute/tid'
import { blobRefToJson } from '@/lib/atproto/blobs'
import { COLLECTIONS } from '@/lib/lichen/collections'
import { createDiff } from '@/lib/lichen/diff'
import type {
  LichenHeaderLink,
  LichenMemberRequestRecord,
  LichenMembershipRecord,
  LichenNavLink,
  LichenNoteRecord,
  LichenRevisionRecord,
  LichenWikiRecord,
  MemberRole,
  WikiVisibility,
} from '@/types/lichen'

type RecordValue = Record<string, unknown>

function typedRecord(collection: string, fields: RecordValue): RecordValue {
  return { $type: collection, ...fields }
}

function resolveRepoDid(agent: Agent, repoDid?: string): string {
  return repoDid ?? agent.accountDid
}

function repoDidFromUri(uri: string, fallback: string): string {
  return parseAtUri(uri)?.did ?? fallback
}

export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/)
  if (!match) return null
  return { did: match[1], collection: match[2], rkey: match[3] }
}

function mapHeaderLinks(value: unknown): LichenHeaderLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  const links = value
    .map((raw) => {
      const item = raw as RecordValue
      return {
        label: String(item?.label ?? '').trim(),
        url: String(item?.url ?? '').trim(),
        image: item?.image,
      }
    })
    // A label is the minimum; url may be empty because a link can be created as
    // a label and image before its destination is decided.
    .filter((link) => link.label)
  return links.length ? links : undefined
}

function mapNavLinks(value: unknown): LichenNavLink[] | undefined {
  if (!Array.isArray(value)) return undefined
  const links = value
    .map((raw) => {
      const item = raw as RecordValue
      return {
        label: String(item?.label ?? '').trim(),
        url: String(item?.url ?? '').trim(),
      }
    })
    .filter((link) => link.label)
  return links.length ? links : undefined
}

function mapSidebarOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const slugs: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const slug = raw.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    slugs.push(slug)
  }
  // Empty array is meaningful: customized sidebar with nothing listed.
  return slugs
}

function headerLinksToRecord(links: LichenHeaderLink[] | undefined): RecordValue[] | undefined {
  if (!links?.length) return undefined
  const mapped = links
    .filter((link) => link.label.trim())
    .map((link) => {
      const image = link.image ? blobRefToJson(link.image) : null
      const url = link.url.trim()
      return {
        label: link.label.trim(),
        // Omit rather than store "" — an absent url reads as "no destination
        // yet", where an empty string would look like a link to nowhere.
        ...(url ? { url } : {}),
        ...(image ? { image } : {}),
      }
    })
  return mapped.length ? mapped : undefined
}

function navLinksToRecord(links: LichenNavLink[] | undefined): RecordValue[] | undefined {
  if (!links?.length) return undefined
  const mapped = links
    .filter((link) => link.label.trim())
    .map((link) => {
      const url = link.url.trim()
      return {
        label: link.label.trim(),
        ...(url ? { url } : {}),
      }
    })
  return mapped.length ? mapped : undefined
}

function mapWikiRecordFields(
  uri: string,
  cid: string,
  slug: string,
  ownerDid: string,
  value: RecordValue,
): LichenWikiRecord {
  return {
    uri,
    cid,
    slug,
    ownerDid,
    name: String(value.name ?? slug),
    visibility: (value.visibility as WikiVisibility) ?? 'public',
    language: String(value.language ?? 'en'),
    description: value.description as string | undefined,
    theme: value.theme as LichenWikiRecord['theme'],
    accentColor: value.accentColor as string | undefined,
    bgColor: value.bgColor as string | undefined,
    cardColor: value.cardColor as string | undefined,
    sidebarColor: value.sidebarColor as string | undefined,
    headerColor: value.headerColor as string | undefined,
    fontFamily: value.fontFamily as string | undefined,
    layoutWidth: value.layoutWidth as LichenWikiRecord['layoutWidth'],
    createdAt: String(value.createdAt ?? new Date().toISOString()),
    forkedFrom: value.forkedFrom as string | undefined,
    forkedAt: value.forkedAt as string | undefined,
    headerLinks: mapHeaderLinks(value.headerLinks),
    navbarLinks: mapNavLinks(value.navbarLinks),
    sidebarOrder: mapSidebarOrder(value.sidebarOrder),
    headerImage: value.headerImage,
    deletedAt: value.deletedAt as string | undefined,
    deletedFromVisibility: value.deletedFromVisibility as WikiVisibility | undefined,
    redirectSlug: value.redirectSlug as string | undefined,
  }
}

export async function listRecords<T>(
  agent: Agent,
  did: string,
  collection: string,
  map: (uri: string, cid: string, rkey: string, value: RecordValue) => T,
): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined

  do {
    const response = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection,
      limit: 100,
      cursor,
    })

    for (const record of response.data.records) {
      items.push(
        map(record.uri, record.cid ?? '', record.uri.split('/').pop() ?? '', record.value as RecordValue),
      )
    }

    cursor = response.data.cursor
  } while (cursor)

  return items
}

export async function listWikis(agent: Agent, did: string): Promise<LichenWikiRecord[]> {
  return listRecords(agent, did, COLLECTIONS.wiki, (uri, cid, slug, value) =>
    mapWikiRecordFields(uri, cid, slug, did, value),
  )
}

export async function getWikiBySlug(
  agent: Agent,
  did: string,
  slug: string,
): Promise<LichenWikiRecord | null> {
  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: COLLECTIONS.wiki,
      rkey: slug,
    })
    const value = response.data.value as RecordValue
    return mapWikiRecordFields(response.data.uri, response.data.cid ?? '', slug, did, value)
  } catch {
    return null
  }
}

export async function listNotes(agent: Agent, did: string): Promise<LichenNoteRecord[]> {
  return listRecords(agent, did, COLLECTIONS.note, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    slug: String(value.slug ?? ''),
    title: String(value.title ?? 'Untitled'),
    ...(typeof value.navTitle === 'string' && value.navTitle.trim()
      ? { navTitle: value.navTitle.trim() }
      : {}),
    wikiRef: String(value.wikiRef ?? ''),
    createdAt: String(value.createdAt ?? new Date().toISOString()),
    // Prefer subheaderLinks; fall back to briefly-used headerLinks on notes.
    subheaderLinks: mapHeaderLinks(value.subheaderLinks ?? value.headerLinks),
  }))
}

export async function listRevisions(agent: Agent, did: string): Promise<LichenRevisionRecord[]> {
  return listRecords(agent, did, COLLECTIONS.noteRevision, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    noteRef: String(value.noteRef ?? ''),
    parentRevision: value.parentRevision as string | undefined,
    diff: String(value.diff ?? ''),
    diffFormat: String(value.diffFormat ?? 'diff-match-patch'),
    message: value.message as string | undefined,
    snapshot: typeof value.snapshot === 'string' ? value.snapshot : undefined,
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  }))
}

/**
 * Newest-first revision loading for page views.
 *
 * Snapshots re-anchor replay every few revisions, so a page only needs the
 * newest records: this walks newest→older and stops as soon as every note
 * seen so far has a snapshot (or its chain root) inside the window. Big wikis
 * load tens of records instead of their entire history; `complete` reports
 * whether the window happens to cover everything, so callers that need full
 * history (page history, merges, rewind) can fetch the rest on demand.
 */
export async function listRecentRevisions(
  agent: Agent,
  did: string,
  options: { max?: number } = {},
): Promise<{ records: LichenRevisionRecord[]; complete: boolean }> {
  const max = options.max ?? 400
  const records: LichenRevisionRecord[] = []
  const snapshotSeen = new Set<string>()
  let cursor: string | undefined
  let exhausted = false

  while (records.length < max) {
    const response = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: COLLECTIONS.noteRevision,
      limit: 100,
      reverse: true,
      cursor,
    })
    for (const record of response.data.records) {
      const value = record.value as RecordValue
      const noteRef = String(value.noteRef ?? '')
      const mapped: LichenRevisionRecord = {
        uri: record.uri,
        cid: record.cid ?? '',
        noteRef,
        parentRevision: value.parentRevision as string | undefined,
        diff: String(value.diff ?? ''),
        diffFormat: String(value.diffFormat ?? 'diff-match-patch'),
        message: value.message as string | undefined,
        snapshot: typeof value.snapshot === 'string' ? value.snapshot : undefined,
        createdAt: String(value.createdAt ?? new Date().toISOString()),
      }
      records.push(mapped)
      if (mapped.snapshot !== undefined || !mapped.parentRevision) snapshotSeen.add(noteRef)
    }
    cursor = response.data.cursor
    if (!cursor) {
      exhausted = true
      break
    }
    // Every note touched in the window is anchored → older records cannot
    // change how any page renders, so stop here.
    if (records.length > 0 && snapshotSeen.size > 0) {
      const pending = new Set(records.map((r) => r.noteRef))
      let anchored = true
      for (const noteRef of pending) {
        if (!snapshotSeen.has(noteRef)) {
          anchored = false
          break
        }
      }
      if (anchored) break
    }
  }

  return { records, complete: exhausted || records.length < max }
}

export async function listMemberships(agent: Agent, did: string): Promise<LichenMembershipRecord[]> {
  return listRecords(agent, did, COLLECTIONS.membership, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    memberDid: String(value.memberDid ?? ''),
    wikiRef: String(value.wikiRef ?? ''),
    role: (value.role as MemberRole) ?? 'contributor',
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  }))
}

export async function listMemberRequests(
  agent: Agent,
  did: string,
): Promise<LichenMemberRequestRecord[]> {
  return listRecords(agent, did, COLLECTIONS.memberRequest, (uri, cid, _rkey, value) => ({
    uri,
    cid,
    requesterDid: did,
    wikiRef: String(value.wikiRef ?? ''),
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  }))
}

export async function getRecord(
  agent: Agent,
  did: string,
  collection: string,
  rkey: string,
): Promise<RecordValue | null> {
  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection,
      rkey,
    })
    return (response.data.value ?? null) as RecordValue | null
  } catch {
    return null
  }
}

export async function writeMemberRequestRecord(
  agent: Agent,
  wikiRef: string,
  rkey = TID.now().toString(),
): Promise<LichenMemberRequestRecord> {
  const createdAt = new Date().toISOString()
  const record = typedRecord(COLLECTIONS.memberRequest, {
    wikiRef,
    createdAt,
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.memberRequest,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    requesterDid: agent.accountDid,
    wikiRef,
    createdAt,
  }
}

export async function deleteMemberRequestRecord(
  agent: Agent,
  requestUri: string,
): Promise<void> {
  const parsed = parseAtUri(requestUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.memberRequest,
    rkey: parsed.rkey,
  })
}

export async function writeWikiRecord(
  agent: Agent,
  slug: string,
  name: string,
  visibility: WikiVisibility,
  language: string,
  description?: string,
  forkedFrom?: string,
  forkedAt?: string,
): Promise<LichenWikiRecord> {
  const createdAt = new Date().toISOString()
  const record = typedRecord(COLLECTIONS.wiki, {
    name,
    visibility,
    language,
    createdAt,
    ...(description ? { description } : {}),
    ...(forkedFrom ? { forkedFrom } : {}),
    ...(forkedAt ? { forkedAt } : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.wiki,
    rkey: slug,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    slug,
    ownerDid: agent.accountDid,
    name,
    visibility,
    language,
    description,
    createdAt,
    forkedFrom,
    forkedAt,
  }
}

export async function writeMembershipRecord(
  agent: Agent,
  memberDid: string,
  wikiRef: string,
  role: MemberRole,
  rkey = TID.now().toString(),
  repoDid?: string,
): Promise<LichenMembershipRecord> {
  const createdAt = new Date().toISOString()
  const record = typedRecord(COLLECTIONS.membership, {
    memberDid,
    wikiRef,
    role,
    createdAt,
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: resolveRepoDid(agent, repoDid),
    collection: COLLECTIONS.membership,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    memberDid,
    wikiRef,
    role,
    createdAt,
  }
}

export async function writeNoteRecord(
  agent: Agent,
  slug: string,
  title: string,
  wikiRef: string,
  rkey = TID.now().toString(),
  repoDid?: string,
  /** Preserve the original creation time when restoring from a backup. */
  createdAtOverride?: string,
): Promise<LichenNoteRecord> {
  const createdAt = createdAtOverride ?? new Date().toISOString()
  const record = typedRecord(COLLECTIONS.note, {
    slug,
    title,
    wikiRef,
    createdAt,
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: resolveRepoDid(agent, repoDid),
    collection: COLLECTIONS.note,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    slug,
    title,
    wikiRef,
    createdAt,
  }
}

export async function writeRevisionRecord(
  agent: Agent,
  noteRef: string,
  oldContent: string,
  newContent: string,
  parentRevision: string | null,
  message?: string,
  rkey = TID.now().toString(),
  repoDid?: string,
  /** Store `newContent` verbatim so replay can re-anchor here. */
  withSnapshot = false,
  /** Blobs referenced by this revision's markdown (keeps getBlob working). */
  blobs?: Array<Record<string, unknown>>,
): Promise<LichenRevisionRecord> {
  const createdAt = new Date().toISOString()
  const diff = createDiff(oldContent, newContent)
  const snapshot = withSnapshot ? newContent : undefined
  const blobRecords = (blobs ?? [])
    .map((item) => blobRefToJson(item))
    .filter((item): item is Record<string, unknown> => !!item)
  const record = typedRecord(COLLECTIONS.noteRevision, {
    noteRef,
    diff,
    diffFormat: 'diff-match-patch',
    createdAt,
    ...(parentRevision ? { parentRevision } : {}),
    ...(message ? { message } : {}),
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(blobRecords.length ? { blobs: blobRecords } : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: resolveRepoDid(agent, repoDid),
    collection: COLLECTIONS.noteRevision,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    noteRef,
    parentRevision: parentRevision ?? undefined,
    diff,
    diffFormat: 'diff-match-patch',
    message,
    snapshot,
    createdAt,
  }
}

/**
 * Write a revision exactly as it was captured, rather than deriving a fresh
 * diff and timestamp. Used when restoring history from a backup so the replayed
 * chain reproduces the original edits instead of collapsing to a single import.
 */
export async function writeVerbatimRevision(
  agent: Agent,
  revision: Pick<
    LichenRevisionRecord,
    'noteRef' | 'diff' | 'diffFormat' | 'createdAt'
  > &
    Partial<Pick<LichenRevisionRecord, 'parentRevision' | 'message' | 'snapshot'>>,
  rkey = TID.now().toString(),
  repoDid?: string,
): Promise<LichenRevisionRecord> {
  const record = typedRecord(COLLECTIONS.noteRevision, {
    noteRef: revision.noteRef,
    diff: revision.diff,
    diffFormat: revision.diffFormat,
    createdAt: revision.createdAt,
    ...(revision.parentRevision ? { parentRevision: revision.parentRevision } : {}),
    ...(revision.message ? { message: revision.message } : {}),
    ...(revision.snapshot !== undefined ? { snapshot: revision.snapshot } : {}),
  })

  const response = await agent.com.atproto.repo.putRecord({
    repo: resolveRepoDid(agent, repoDid),
    collection: COLLECTIONS.noteRevision,
    rkey,
    record: record as RecordValue,
  })

  return {
    uri: response.data.uri,
    cid: response.data.cid,
    noteRef: revision.noteRef,
    parentRevision: revision.parentRevision,
    diff: revision.diff,
    diffFormat: revision.diffFormat,
    message: revision.message,
    snapshot: revision.snapshot,
    createdAt: revision.createdAt,
  }
}

function noteRecordFields(
  note: Pick<
    LichenNoteRecord,
    'slug' | 'title' | 'navTitle' | 'wikiRef' | 'createdAt' | 'subheaderLinks'
  >,
): RecordValue {
  const navTitle = note.navTitle?.trim()
  return typedRecord(COLLECTIONS.note, {
    slug: note.slug,
    title: note.title,
    wikiRef: note.wikiRef,
    createdAt: note.createdAt,
    ...(navTitle ? { navTitle } : {}),
    ...(headerLinksToRecord(note.subheaderLinks)
      ? { subheaderLinks: headerLinksToRecord(note.subheaderLinks) }
      : {}),
  })
}

/**
 * Restore a note's original creation time. Used when a backup is imported onto
 * a note the create flow already made, so the restore is not backdated to now.
 */
export async function updateNoteCreatedAt(
  agent: Agent,
  note: LichenNoteRecord,
  createdAt: string,
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, createdAt }) as RecordValue,
  })
}

export async function updateNoteTitle(
  agent: Agent,
  note: LichenNoteRecord,
  title: string,
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, title }) as RecordValue,
  })
}

/** Set or clear the sidebar/quick-nav label (`navTitle`). Empty clears it. */
export async function updateNoteNavTitle(
  agent: Agent,
  note: LichenNoteRecord,
  navTitle: string | undefined,
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  const trimmed = navTitle?.trim() || undefined
  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, navTitle: trimmed }) as RecordValue,
  })
}

/**
 * Rewrite a note's slug on the existing record. Unlike the rename flow, which
 * creates a new note and leaves a redirect behind, this keeps the record — and
 * so the revision history hanging off its URI — exactly where it is.
 */
export async function updateNoteSlug(
  agent: Agent,
  note: LichenNoteRecord,
  slug: string,
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, slug }) as RecordValue,
  })
}

export async function updateNoteSubheaderLinks(
  agent: Agent,
  note: LichenNoteRecord,
  subheaderLinks: LichenHeaderLink[],
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, subheaderLinks }) as RecordValue,
  })
}

export async function deleteNoteRecord(agent: Agent, noteUri: string): Promise<void> {
  const parsed = parseAtUri(noteUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
  })
}

export async function deleteRevisionRecord(agent: Agent, revisionUri: string): Promise<void> {
  const parsed = parseAtUri(revisionUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.noteRevision,
    rkey: parsed.rkey,
  })
}

/**
 * PDS implementations cap how many operations one applyWrites call may carry.
 * The lexicon in this SDK version states no limit, so chunk defensively.
 */
const APPLY_WRITES_MAX = 200

type RepoDelete = {
  $type: 'com.atproto.repo.applyWrites#delete'
  collection: string
  rkey: string
}

function deleteOp(collection: string, rkey: string): RepoDelete {
  return { $type: 'com.atproto.repo.applyWrites#delete', collection, rkey }
}

/**
 * Delete a note together with its revisions.
 *
 * A note record carries no body — the text exists only as diffs inside its
 * revision records — so dropping the note alone leaves the content of a
 * "deleted" page publicly readable via listRecords. Batched through applyWrites
 * so the whole set goes in one request rather than a loop that can strand half
 * the records, and the note is deleted last so a failed batch leaves a note that
 * still resolves and can be retried.
 */
export async function deleteNoteWithRevisions(
  agent: Agent,
  noteUri: string,
  revisionUris: string[],
  repoDid?: string,
): Promise<void> {
  const note = parseAtUri(noteUri)
  if (!note) return

  const writes: RepoDelete[] = []
  for (const uri of revisionUris) {
    const parsed = parseAtUri(uri)
    if (parsed) writes.push(deleteOp(COLLECTIONS.noteRevision, parsed.rkey))
  }
  writes.push(deleteOp(COLLECTIONS.note, note.rkey))

  const repo = repoDid ?? repoDidFromUri(noteUri, agent.accountDid)
  for (let i = 0; i < writes.length; i += APPLY_WRITES_MAX) {
    await agent.com.atproto.repo.applyWrites({
      repo,
      writes: writes.slice(i, i + APPLY_WRITES_MAX),
    })
  }
}

function wikiRecordFields(wiki: LichenWikiRecord): RecordValue {
  return typedRecord(COLLECTIONS.wiki, {
    name: wiki.name,
    visibility: wiki.visibility,
    language: wiki.language,
    createdAt: wiki.createdAt,
    ...(wiki.description ? { description: wiki.description } : {}),
    ...(wiki.theme ? { theme: wiki.theme } : {}),
    ...(wiki.accentColor ? { accentColor: wiki.accentColor } : {}),
    ...(wiki.bgColor ? { bgColor: wiki.bgColor } : {}),
    ...(wiki.cardColor ? { cardColor: wiki.cardColor } : {}),
    ...(wiki.sidebarColor ? { sidebarColor: wiki.sidebarColor } : {}),
    ...(wiki.headerColor ? { headerColor: wiki.headerColor } : {}),
    ...(wiki.fontFamily ? { fontFamily: wiki.fontFamily } : {}),
    ...(wiki.layoutWidth ? { layoutWidth: wiki.layoutWidth } : {}),
    ...(wiki.forkedFrom ? { forkedFrom: wiki.forkedFrom } : {}),
    ...(wiki.forkedAt ? { forkedAt: wiki.forkedAt } : {}),
    ...(headerLinksToRecord(wiki.headerLinks)
      ? { headerLinks: headerLinksToRecord(wiki.headerLinks) }
      : {}),
    ...(navLinksToRecord(wiki.navbarLinks)
      ? { navbarLinks: navLinksToRecord(wiki.navbarLinks) }
      : {}),
    ...(wiki.sidebarOrder !== undefined ? { sidebarOrder: [...wiki.sidebarOrder] } : {}),
    ...(blobRefToJson(wiki.headerImage)
      ? { headerImage: blobRefToJson(wiki.headerImage) }
      : {}),
    ...(wiki.deletedAt ? { deletedAt: wiki.deletedAt } : {}),
    ...(wiki.deletedFromVisibility
      ? { deletedFromVisibility: wiki.deletedFromVisibility }
      : {}),
    ...(wiki.redirectSlug ? { redirectSlug: wiki.redirectSlug } : {}),
  })
}

export async function putWikiAtSlug(
  agent: Agent,
  slug: string,
  wiki: LichenWikiRecord,
): Promise<LichenWikiRecord> {
  const ownerDid = wiki.ownerDid || agent.accountDid
  const payload: LichenWikiRecord = {
    ...wiki,
    slug,
    ownerDid,
    uri: wiki.uri,
    cid: wiki.cid,
    redirectSlug: undefined,
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: slug,
    record: wikiRecordFields(payload) as RecordValue,
  })
  return {
    ...payload,
    uri: response.data.uri,
    cid: response.data.cid,
    slug,
    ownerDid,
  }
}

export async function updateNoteWikiRef(
  agent: Agent,
  note: LichenNoteRecord,
  wikiRef: string,
): Promise<void> {
  const parsed = parseAtUri(note.uri)
  if (!parsed) return

  await agent.com.atproto.repo.putRecord({
    repo: repoDidFromUri(note.uri, agent.accountDid),
    collection: COLLECTIONS.note,
    rkey: parsed.rkey,
    record: noteRecordFields({ ...note, wikiRef }) as RecordValue,
  })
}

export async function updateWikiRecord(
  agent: Agent,
  wiki: LichenWikiRecord,
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields(wiki) as RecordValue,
  })
}

export async function updateWikiName(
  agent: Agent,
  wiki: LichenWikiRecord,
  name: string,
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, name }) as RecordValue,
  })
}

export async function updateWikiVisibility(
  agent: Agent,
  wiki: LichenWikiRecord,
  visibility: WikiVisibility,
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, visibility }) as RecordValue,
  })
}

/** Wiki-level presentation fields the owner controls. */
export type WikiThemeFields = Pick<
  LichenWikiRecord,
  | 'theme'
  | 'accentColor'
  | 'bgColor'
  | 'cardColor'
  | 'sidebarColor'
  | 'headerColor'
  | 'fontFamily'
  | 'layoutWidth'
>

export async function updateWikiTheme(
  agent: Agent,
  wiki: LichenWikiRecord,
  theme: LichenWikiRecord['theme'] | WikiThemeFields,
): Promise<void> {
  const fields: WikiThemeFields =
    theme === undefined || typeof theme === 'string' ? { theme } : theme
  // Always honour keys present on `fields`, including explicit `undefined` clears.
  const merged: LichenWikiRecord = {
    ...wiki,
    ...('theme' in fields ? { theme: fields.theme } : {}),
    ...('accentColor' in fields ? { accentColor: fields.accentColor } : {}),
    ...('bgColor' in fields ? { bgColor: fields.bgColor } : {}),
    ...('cardColor' in fields ? { cardColor: fields.cardColor } : {}),
    ...('sidebarColor' in fields ? { sidebarColor: fields.sidebarColor } : {}),
    ...('headerColor' in fields ? { headerColor: fields.headerColor } : {}),
    ...('fontFamily' in fields ? { fontFamily: fields.fontFamily } : {}),
    ...('layoutWidth' in fields ? { layoutWidth: fields.layoutWidth } : {}),
  }
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields(merged) as RecordValue,
  })
}

export async function updateWikiHeaderLinks(
  agent: Agent,
  wiki: LichenWikiRecord,
  headerLinks: LichenHeaderLink[],
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, headerLinks }) as RecordValue,
  })
}

export async function updateWikiNavbarLinks(
  agent: Agent,
  wiki: LichenWikiRecord,
  navbarLinks: LichenNavLink[],
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, navbarLinks }) as RecordValue,
  })
}

export async function updateWikiSidebarOrder(
  agent: Agent,
  wiki: LichenWikiRecord,
  sidebarOrder: string[],
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, sidebarOrder }) as RecordValue,
  })
}

export async function updateWikiHeaderImage(
  agent: Agent,
  wiki: LichenWikiRecord,
  headerImage: LichenWikiRecord['headerImage'] | undefined,
): Promise<void> {
  await agent.com.atproto.repo.putRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
    record: wikiRecordFields({ ...wiki, headerImage }) as RecordValue,
  })
}

export async function deleteWikiRecord(agent: Agent, wiki: LichenWikiRecord): Promise<void> {
  await agent.com.atproto.repo.deleteRecord({
    repo: wiki.ownerDid,
    collection: COLLECTIONS.wiki,
    rkey: wiki.slug,
  })
}

export async function deleteMembershipRecord(agent: Agent, membershipUri: string): Promise<void> {
  const parsed = parseAtUri(membershipUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: COLLECTIONS.membership,
    rkey: parsed.rkey,
  })
}

export async function updateMembershipRole(
  agent: Agent,
  membership: LichenMembershipRecord,
  role: MemberRole,
): Promise<LichenMembershipRecord> {
  const parsed = parseAtUri(membership.uri)
  if (!parsed) throw new Error('Invalid membership URI')
  return writeMembershipRecord(
    agent,
    membership.memberDid,
    membership.wikiRef,
    role,
    parsed.rkey,
    parsed.did,
  )
}

export function uniqueSlug(base: string, existing: string[]): string {
  const normalized = base
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)

  let candidate = normalized || 'wiki'
  let counter = 2
  while (existing.includes(candidate)) {
    candidate = `${normalized || 'wiki'}-${counter}`
    counter += 1
  }
  return candidate
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

/**
 * Turn a URL/path segment into a storable article slug.
 * Lowercases, strips punctuation, and collapses spaces/underscores to hyphens.
 * Preserves typed prefixes (`talk:`, `Category:`, `branch:`).
 */
export function normalizeArticleSlug(slug: string): string {
  const trimmed = slug.trim()
  if (!trimmed) return ''
  if (isValidSlug(trimmed)) return trimmed

  const colonIdx = trimmed.indexOf(':')
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx)
    const rest = trimmed.slice(colonIdx + 1)
    const prefixLower = prefix.toLowerCase()
    const restSlug = rest
      .toLowerCase()
      .trim()
      .replace(/[^\w\s:-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

    if (!restSlug) return ''
    if (prefixLower === 'category') return `Category:${restSlug}`
    if (prefixLower === 'talk') return `talk:${restSlug}`
    if (prefixLower === 'branch') return `branch:${restSlug}`
    return `${prefixLower}:${restSlug}`
  }

  return trimmed
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}
