import type { Agent } from '@atproto/api'
import * as TID from '@atcute/tid'
import { getRecord, listRecords, parseAtUri } from '@/lib/atproto/lichen'
import { fetchBacklinks } from '@/lib/constellation/client'
import { COLLECTIONS } from '@/lib/lichen/collections'
import { resolvePdsUrl as resolvePds } from '@/lib/atproto/pds'
import { buildBlobUrl } from '@/lib/atproto/blobs'
import type { LichenBlobRef } from '@/types/lichen'

// ---------------------------------------------------------------------------
// Shared dock buttons (wiki.pckt.dockButton + wiki.pckt.dockItem)
// ---------------------------------------------------------------------------

export interface DockButtonRecord {
  uri: string
  cid: string
  creatorDid: string
  label: string
  /** Wiki path (/@handle/wiki/slug) or absolute URL the button leads to. */
  href: string
  /** at-uri of the note the button was built from, for provenance. */
  target?: string
  art: LichenBlobRef
  wikiRef: string
  createdAt: string
}

export interface DockItemRecord {
  uri: string
  cid: string
  wikiRef: string
  /** Linked shape: the shared wiki.pckt.dockButton this item follows. */
  buttonRef?: string
  /** Forked shape: a self-contained copy editable by this wiki. */
  label?: string
  href?: string
  art?: LichenBlobRef
  createdAt: string
}

export interface DockButtonInput {
  label: string
  href: string
  target?: string
  art: Record<string, unknown>
  wikiRef: string
}

export async function createDockButton(
  agent: Agent,
  input: DockButtonInput,
): Promise<DockButtonRecord> {
  const createdAt = new Date().toISOString()
  const record = {
    $type: COLLECTIONS.dockButton,
    label: input.label,
    href: input.href,
    ...(input.target ? { target: input.target } : {}),
    art: input.art,
    wikiRef: input.wikiRef,
    createdAt,
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.dockButton,
    rkey: TID.now().toString(),
    record,
  })
  return {
    uri: response.data.uri,
    cid: response.data.cid,
    creatorDid: agent.accountDid,
    label: input.label,
    href: input.href,
    target: input.target,
    art: input.art as LichenBlobRef,
    wikiRef: input.wikiRef,
    createdAt,
  }
}

/** Link a shared button to a wiki (stays live from the creator's repo). */
export async function linkDockItem(
  agent: Agent,
  wikiRef: string,
  buttonUri: string,
): Promise<DockItemRecord> {
  const createdAt = new Date().toISOString()
  const record = {
    $type: COLLECTIONS.dockItem,
    wikiRef,
    buttonRef: buttonUri,
    createdAt,
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.dockItem,
    rkey: TID.now().toString(),
    record,
  })
  return {
    uri: response.data.uri,
    cid: response.data.cid,
    wikiRef,
    buttonRef: buttonUri,
    createdAt,
  }
}

export async function deleteRecord(
  agent: Agent,
  recordUri: string,
): Promise<void> {
  const parsed = parseAtUri(recordUri)
  if (!parsed) return
  await agent.com.atproto.repo.deleteRecord({
    repo: parsed.did,
    collection: parsed.collection,
    rkey: parsed.rkey,
  })
}

/** A wiki's linked buttons: wiki.pckt.dockItem records in the wiki owner's repo. */
export async function listDockItems(wikiOwnerDid: string): Promise<DockItemRecord[]> {
  const pdsUrl = await resolvePds(wikiOwnerDid)
  const out: DockItemRecord[] = []
  let cursor: string | undefined
  do {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`)
    url.searchParams.set('repo', wikiOwnerDid)
    url.searchParams.set('collection', COLLECTIONS.dockItem)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const page = await api(url.toString())
    for (const record of page.records ?? []) {
      out.push({
        uri: record.uri,
        cid: record.cid ?? '',
        wikiRef: String(record.value?.wikiRef ?? ''),
        buttonRef:
          typeof record.value?.buttonRef === 'string' ? record.value.buttonRef : undefined,
        label: typeof record.value?.label === 'string' ? record.value.label : undefined,
        href: typeof record.value?.href === 'string' ? record.value.href : undefined,
        art: record.value?.art as LichenBlobRef | undefined,
        createdAt: String(record.value?.createdAt ?? ''),
      })
    }
    cursor = page.cursor
  } while (cursor)
  return out
}

/**
 * Fork a shared button into a wiki: the art blob is copied from the creator's
 * repo into the wiki owner's, so the fork is fully owned and editable.
 */
export async function forkDockButton(
  agent: Agent,
  wikiRef: string,
  button: DockButtonRecord,
): Promise<DockItemRecord> {
  const { transferBlob } = await import('@/lib/atproto/collab')
  const { imageCid, blob } = await transferBlob(
    agent,
    button.creatorDid,
    button.art,
    (button.art as { ref?: { $link?: string } })?.ref?.$link,
  )
  const art = {
    $type: 'blob',
    ref: { $link: imageCid },
    mimeType: (blob as { mimeType?: string }).mimeType ?? 'image/webp',
    size: (blob as { size?: number }).size ?? 0,
  }
  const createdAt = new Date().toISOString()
  const record = {
    $type: COLLECTIONS.dockItem,
    wikiRef,
    label: button.label,
    href: button.href,
    art,
    createdAt,
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.dockItem,
    rkey: TID.now().toString(),
    record,
  })
  return {
    uri: response.data.uri,
    cid: response.data.cid,
    wikiRef,
    label: button.label,
    href: button.href,
    art: art as LichenBlobRef,
    createdAt,
  }
}

async function api(url: string) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`listRecords ${response.status}`)
  return response.json()
}

/** Resolve one shared button record from its at-uri (creator's repo, public). */
export async function getDockButton(
  agent: Agent,
  buttonUri: string,
): Promise<DockButtonRecord | null> {
  const parsed = parseAtUri(buttonUri)
  if (!parsed || parsed.collection !== COLLECTIONS.dockButton) return null
  const value = await getRecord(agent, parsed.did, COLLECTIONS.dockButton, parsed.rkey)
  if (!value) return null
  return {
    uri: buttonUri,
    cid: '',
    creatorDid: parsed.did,
    label: String(value.label ?? ''),
    href: String(value.href ?? ''),
    target: typeof value.target === 'string' ? value.target : undefined,
    art: value.art as LichenBlobRef,
    wikiRef: String(value.wikiRef ?? ''),
    createdAt: String(value.createdAt ?? ''),
  }
}

/** A fetched button plus a resolvable art URL for <img>. */
export interface ResolvedDockButton extends DockButtonRecord {
  artUrl: string | null
}

export async function resolveDockButtonArt(
  button: DockButtonRecord,
): Promise<ResolvedDockButton> {
  let artUrl: string | null = null
  const cid = (button.art as { ref?: { $link?: string } })?.ref?.$link
  if (cid) {
    try {
      const pdsUrl = await resolvePds(button.creatorDid)
      artUrl = buildBlobUrl(pdsUrl, button.creatorDid, cid)
    } catch {
      artUrl = null
    }
  }
  return { ...button, artUrl }
}

/** Buttons shared by a given wiki's owner (their repo, their wikiRef). */
export async function listDockButtonsForWiki(
  agent: Agent,
  ownerDid: string,
  wikiRef: string,
): Promise<DockButtonRecord[]> {
  const records = await listRecords(
    agent,
    ownerDid,
    COLLECTIONS.dockButton,
    (uri, cid, _rkey, value) => ({
      uri,
      cid,
      creatorDid: ownerDid,
      label: String(value.label ?? ''),
      href: String(value.href ?? ''),
      target: typeof value.target === 'string' ? value.target : undefined,
      art: value.art as LichenBlobRef,
      wikiRef: String(value.wikiRef ?? ''),
      createdAt: String(value.createdAt ?? new Date().toISOString()),
    }),
  )
  return records.filter((r) => r.wikiRef === wikiRef)
}

/** Buttons from wikis the viewer follows — the discovery feed for the picker. */
export async function listFollowedWikisButtons(
  agent: Agent,
  followedOwners: Array<{ did: string; label: string }>,
  ownDid: string,
): Promise<Array<{ owner: string; button: DockButtonRecord }>> {
  const out: Array<{ owner: string; button: DockButtonRecord }> = []
  for (const owner of followedOwners) {
    if (owner.did === ownDid) continue
    try {
      const wikis = await listRecords(
        agent,
        owner.did,
        COLLECTIONS.wiki,
        (uri, cid, _rkey, value) => ({ uri, cid, value }),
      )
      for (const w of wikis) {
        if (w.value.deletedAt || w.value.redirectSlug) continue
        const buttons = await listDockButtonsForWiki(agent, owner.did, w.uri)
        for (const button of buttons) out.push({ owner: owner.label, button })
      }
    } catch {
      // skip unreachable owners
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Forum topics (wiki.pckt.forumTopic anchored to Bluesky threads)
// ---------------------------------------------------------------------------

export interface ForumTopicRecord {
  uri: string
  cid: string
  authorDid: string
  wikiRef: string
  rootPost: string
  noteSlug?: string
  createdAt: string
}

export async function createForumTopic(
  agent: Agent,
  input: { wikiRef: string; rootPost: string; noteSlug?: string },
): Promise<ForumTopicRecord> {
  const createdAt = new Date().toISOString()
  const record = {
    $type: COLLECTIONS.forumTopic,
    wikiRef: input.wikiRef,
    rootPost: input.rootPost,
    ...(input.noteSlug ? { noteSlug: input.noteSlug } : {}),
    createdAt,
  }
  const response = await agent.com.atproto.repo.putRecord({
    repo: agent.accountDid,
    collection: COLLECTIONS.forumTopic,
    rkey: TID.now().toString(),
    record,
  })
  return {
    uri: response.data.uri,
    cid: response.data.cid,
    authorDid: agent.accountDid,
    wikiRef: input.wikiRef,
    rootPost: input.rootPost,
    noteSlug: input.noteSlug,
    createdAt,
  }
}

/** Topics for a wiki via Constellation backlinks on .wikiRef (any author's repo). */
export async function listForumTopics(
  agent: Agent,
  wikiRef: string,
): Promise<ForumTopicRecord[]> {
  const linking = await fetchBacklinks({
    target: wikiRef,
    collection: COLLECTIONS.forumTopic,
    path: '.wikiRef',
    limit: 100,
  }).catch(() => ({ linking_records: [], total: 0, cursor: null }))

  const out: ForumTopicRecord[] = []
  for (const record of linking.linking_records) {
    const uri = `at://${record.did}/${record.collection}/${record.rkey}`
    try {
      const value = await getRecord(agent, record.did, COLLECTIONS.forumTopic, record.rkey)
      if (!value) continue
      if (String(value.wikiRef ?? '') !== wikiRef) continue
      out.push({
        uri,
        cid: '',
        authorDid: record.did,
        wikiRef,
        rootPost: String(value.rootPost ?? ''),
        noteSlug: typeof value.noteSlug === 'string' ? value.noteSlug : undefined,
        createdAt: String(value.createdAt ?? ''),
      })
    } catch {
      // skip unreachable authors
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
