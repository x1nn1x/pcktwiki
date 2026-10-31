import { Agent } from '@atproto/api'
import { listWikis } from '@/lib/atproto/lichen'
import { resolveDidDoc } from '@/lib/atproto/pds'
import { listReposByCollection } from '@/lib/atproto/relay'
import { WIKI_DIRECTORY_CONCURRENCY, WIKI_DIRECTORY_TTL_MS } from '@/lib/cache-constants'
import { runSettledWithConcurrency } from '@/lib/concurrency'
import { accentColorForSlug, listFeaturedWikiReferences } from '@/lib/lichen/featured-wiki-loader'
import { COLLECTIONS } from '@/lib/lichen/collections'
import { createRetryFetch } from '@/lib/http-retry'
import type { LichenWikiRecord } from '@/types/lichen'

/**
 * Every public wiki on the network, as far as the relay knows about it. This is
 * deliberately metadata-only: names and descriptions are small enough to hold
 * for the whole network at once, where article bodies are not.
 */
export interface DirectoryWiki {
  did: string
  /** Handle when the DID document declares one, otherwise the DID itself. */
  handle: string
  slug: string
  name: string
  description: string
  /** Domain the wiki is published under — shown to distinguish same-named wikis. */
  pdsHost: string
  accentColor: string
  createdAt: string
}

const STORAGE_KEY = 'pckt.wiki.wiki-directory'

interface StoredDirectory {
  wikis: DirectoryWiki[]
  fetchedAt: number
}

let memoryCache: StoredDirectory | null = null
let inflight: Promise<DirectoryWiki[]> | null = null

export function pdsHostFromHandle(handle: string): string {
  const labels = handle.split('.')
  // A two-label handle is already its own domain — dropping the first label
  // would leave a bare TLD ("j3s.sh" shown as "sh"). Longer handles are a
  // subdomain of the host that issued them, which is the part worth showing.
  if (labels.length <= 2) return handle
  return labels.slice(1).join('.')
}

export function directoryKey(handle: string, slug: string): string {
  return `${handle.toLowerCase()}:${slug}`
}

function readStored(): StoredDirectory | null {
  if (memoryCache) return memoryCache
  if (typeof localStorage === 'undefined') return null

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredDirectory
    if (!Array.isArray(parsed?.wikis) || typeof parsed.fetchedAt !== 'number') return null
    memoryCache = parsed
    return parsed
  } catch {
    return null
  }
}

function writeStored(wikis: DirectoryWiki[]): void {
  const entry: StoredDirectory = { wikis, fetchedAt: Date.now() }
  memoryCache = entry

  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // localStorage full or unavailable — the memory cache still serves this session.
  }
}

function isPublishedWiki(wiki: LichenWikiRecord): boolean {
  // Same rules loadPublicWikiData applies, so the directory never advertises a
  // wiki that would then refuse to open.
  return wiki.visibility === 'public' && !wiki.deletedAt && !wiki.redirectSlug
}

function toDirectoryWiki(wiki: LichenWikiRecord, did: string, handle: string): DirectoryWiki {
  return {
    did,
    handle,
    slug: wiki.slug,
    name: wiki.name,
    description: wiki.description ?? '',
    pdsHost: pdsHostFromHandle(handle),
    accentColor: wiki.accentColor ?? accentColorForSlug(wiki.slug),
    createdAt: wiki.createdAt,
  }
}

async function loadRepoWikis(did: string): Promise<DirectoryWiki[]> {
  const { pdsUrl, handle } = await resolveDidDoc(did)
  const agent = new Agent({ service: pdsUrl, fetch: createRetryFetch() })
  const wikis = await listWikis(agent, did)

  return wikis.filter(isPublishedWiki).map((wiki) => toDirectoryWiki(wiki, did, handle ?? did))
}

/**
 * Featured entries are merged in by handle rather than crawled, so a wiki stays
 * findable even if its PDS is not federated with the relay we query.
 */
function mergeFeaturedPlaceholders(wikis: DirectoryWiki[]): DirectoryWiki[] {
  const byKey = new Map(wikis.map((wiki) => [directoryKey(wiki.handle, wiki.slug), wiki]))

  for (const ref of listFeaturedWikiReferences()) {
    const key = directoryKey(ref.handle, ref.slug)
    if (byKey.has(key)) continue

    byKey.set(key, {
      did: '',
      handle: ref.handle,
      slug: ref.slug,
      name: ref.slug,
      description: '',
      pdsHost: pdsHostFromHandle(ref.handle),
      accentColor: accentColorForSlug(ref.slug),
      createdAt: '',
    })
  }

  return [...byKey.values()]
}

export function getCachedWikiDirectory(): DirectoryWiki[] | null {
  const stored = readStored()
  if (!stored) return null
  if (Date.now() - stored.fetchedAt > WIKI_DIRECTORY_TTL_MS) return null
  return stored.wikis
}

export async function loadWikiDirectory(options?: { force?: boolean }): Promise<DirectoryWiki[]> {
  if (!options?.force) {
    const cached = getCachedWikiDirectory()
    if (cached) return cached
    if (inflight) return inflight
  }

  const run = (async () => {
    const dids = await listReposByCollection(COLLECTIONS.wiki)

    const results = await runSettledWithConcurrency(dids, WIKI_DIRECTORY_CONCURRENCY, (did) =>
      loadRepoWikis(did),
    )

    const wikis: DirectoryWiki[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') wikis.push(...result.value)
    }

    const merged = mergeFeaturedPlaceholders(wikis)
    writeStored(merged)
    return merged
  })()

  inflight = run
  try {
    return await run
  } catch (err) {
    // A failed crawl falls back to whatever is on disk, however stale, rather
    // than collapsing search back to nothing.
    const stale = readStored()
    if (stale?.wikis.length) return stale.wikis
    throw err
  } finally {
    if (inflight === run) inflight = null
  }
}

// ---------------------------------------------------------------------------
// Live stats — article counts and last activity per owner DID, powering the
// directory's live cards. One pass per owner (not per wiki), cached an hour.
// ---------------------------------------------------------------------------

export interface DirectoryStats {
  notes: number
  lastActivity: string | null
}

const STATS_KEY = 'pckt.wiki.wiki-directory-stats'
const STATS_TTL_MS = 60 * 60 * 1000

let statsMemory: { values: Record<string, DirectoryStats>; fetchedAt: Record<string, number> } | null =
  null

function readStats() {
  if (statsMemory) return statsMemory
  if (typeof localStorage === 'undefined') {
    statsMemory = { values: {}, fetchedAt: {} }
    return statsMemory
  }
  try {
    statsMemory = {
      values: JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}'),
      fetchedAt: JSON.parse(localStorage.getItem(`${STATS_KEY}.at`) ?? '{}'),
    }
  } catch {
    statsMemory = { values: {}, fetchedAt: {} }
  }
  return statsMemory
}

function writeStats(entry: { values: Record<string, DirectoryStats>; fetchedAt: Record<string, number> }) {
  statsMemory = entry
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(entry.values))
    localStorage.setItem(`${STATS_KEY}.at`, JSON.stringify(entry.fetchedAt))
  } catch {
    // quota — the memory cache still serves this session
  }
}

async function loadRepoStats(did: string): Promise<DirectoryStats> {
  const { pdsUrl } = await resolveDidDoc(did)
  const agent = new Agent({ service: pdsUrl, fetch: createRetryFetch() })
  const { listNotes } = await import('@/lib/atproto/lichen')
  const notes = await listNotes(agent, did)
  let lastActivity: string | null = null
  try {
    // reverse=true returns the newest revision first — one record is enough
    // to date the wiki's last activity without listing its whole history.
    const response = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: COLLECTIONS.noteRevision,
      limit: 1,
      reverse: true,
    })
    const newest = response.data.records[0]
    if (newest) lastActivity = String((newest.value as Record<string, unknown>).createdAt ?? '')
  } catch {
    // no revisions reachable — activity stays null
  }
  return { notes: notes.length, lastActivity }
}

/** Article counts + last activity for each owner DID, cached for an hour. */
export async function loadDirectoryStats(
  dids: string[],
): Promise<Record<string, DirectoryStats>> {
  const entry = readStats()
  const stale = dids.filter((did) => Date.now() - (entry.fetchedAt[did] ?? 0) > STATS_TTL_MS)

  if (stale.length) {
    const results = await runSettledWithConcurrency(stale, WIKI_DIRECTORY_CONCURRENCY, (did) =>
      loadRepoStats(did),
    )
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') entry.values[stale[index]] = result.value
      entry.fetchedAt[stale[index]] = Date.now()
    })
    writeStats(entry)
  }

  const out: Record<string, DirectoryStats> = {}
  for (const did of dids) out[did] = entry.values[did] ?? { notes: 0, lastActivity: null }
  return out
}
