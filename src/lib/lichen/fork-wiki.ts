import type { Agent } from '@atproto/api'
import {
  deleteWikiRecord,
  updateWikiTheme,
  writeMembershipRecord,
  writeNoteRecord,
  writeRevisionRecord,
  writeWikiRecord,
} from '@/lib/atproto/lichen'
import type { PublicWikiCacheEntry } from '@/lib/lichen/load-public-wiki'
import type { ForkNoteBaseline, ForkRecord } from '@/lib/lichen/fork'
import type { LichenWikiRecord } from '@/types/lichen'

export interface ForkProgress {
  phase: 'wiki' | 'notes' | 'done'
  total: number
  done: number
  currentSlug?: string
}

export interface ForkWikiResult {
  wiki: LichenWikiRecord
  baselines: Record<string, ForkNoteBaseline>
}

export interface ForkWikiOptions {
  /** Target slug on the user's PDS (must be unique among their wikis). */
  slug: string
  /** Optional override for the forked wiki's display name. */
  name?: string
  /**
   * Visibility for the fork. Defaults to the source's own visibility so that
   * forking a private wiki cannot quietly republish it.
   */
  visibility?: LichenWikiRecord['visibility']
  onProgress?: (progress: ForkProgress) => void
}

/**
 * Copy a public source wiki (metadata + every note + current content) into the
 * signed-in user's repository. Returns the new wiki and the per-note sync baselines.
 */
export async function forkWiki(
  agent: Agent,
  source: PublicWikiCacheEntry,
  options: ForkWikiOptions,
): Promise<ForkWikiResult> {
  if (!source.wiki) throw new Error('Source wiki is not available to fork')

  const sourceNotes = source.notesWithContent
  const attribution = `Forked from @${source.handle}/${source.slug}`
  const onProgress = options.onProgress
  const total = sourceNotes.length

  onProgress?.({ phase: 'wiki', total, done: 0 })

  const forkedAt = new Date().toISOString()
  // Never widen access as a side effect of forking: a private source yields a
  // private fork unless the caller explicitly asks otherwise.
  const visibility = options.visibility ?? source.wiki.visibility ?? 'public'

  const wiki = await writeWikiRecord(
    agent,
    options.slug,
    options.name?.trim() || source.wiki.name,
    visibility,
    source.wiki.language,
    source.wiki.description,
    source.wiki.uri,
    forkedAt,
  )

  const sourceTheme = {
    theme: source.wiki.theme,
    accentColor: source.wiki.accentColor,
    bgColor: source.wiki.bgColor,
    cardColor: source.wiki.cardColor,
    sidebarColor: source.wiki.sidebarColor,
    headerColor: source.wiki.headerColor,
    fontFamily: source.wiki.fontFamily,
    layoutWidth: source.wiki.layoutWidth,
  }
  if (Object.values(sourceTheme).some(Boolean)) {
    await updateWikiTheme(agent, wiki, sourceTheme).catch(() => {})
    Object.assign(wiki, sourceTheme)
  }

  let membershipUri: string | null = null
  const baselines: Record<string, ForkNoteBaseline> = {}

  try {
    const membership = await writeMembershipRecord(agent, agent.accountDid, wiki.uri, 'admin')
    membershipUri = membership.uri

    onProgress?.({ phase: 'notes', total, done: 0 })

    let done = 0
    for (const sourceNote of sourceNotes) {
      onProgress?.({ phase: 'notes', total, done, currentSlug: sourceNote.slug })
      const note = await writeNoteRecord(agent, sourceNote.slug, sourceNote.title, wiki.uri)
      await writeRevisionRecord(agent, note.uri, '', sourceNote.content, null, attribution)
      baselines[sourceNote.slug] = {
        sourceContent: sourceNote.content,
        sourceRevisionUri: sourceNote.latestRevisionUri,
      }
      done += 1
      onProgress?.({ phase: 'notes', total, done, currentSlug: sourceNote.slug })
    }

    onProgress?.({ phase: 'done', total, done })
    return { wiki, baselines }
  } catch (err) {
    // Best-effort rollback of the wiki shell if note import fails midway.
    if (membershipUri) {
      await deleteWikiRecord(agent, wiki).catch(() => {})
    }
    throw err
  }
}

export function buildForkRecord(params: {
  wiki: LichenWikiRecord
  forkHandle: string
  source: PublicWikiCacheEntry
  baselines: Record<string, ForkNoteBaseline>
  autoSync: boolean
}): ForkRecord {
  return {
    forkWikiUri: params.wiki.uri,
    forkSlug: params.wiki.slug,
    forkHandle: params.forkHandle,
    sourceDid: params.source.did,
    sourceHandle: params.source.handle,
    sourceSlug: params.source.slug,
    sourceWikiUri: params.source.wiki?.uri ?? '',
    createdAt: new Date().toISOString(),
    autoSync: params.autoSync,
    lastCheckedAt: new Date().toISOString(),
    baselines: params.baselines,
  }
}

/**
 * Remix a wiki from anywhere (browse cards, the "wikis like this" webring):
 * load the source, fork it under a fresh slug, and register the fork locally
 * so sync works from the first open. Returns the new wiki record.
 */
export async function remixWiki(
  agent: Agent,
  sourceHandle: string,
  sourceSlug: string,
  options: { name?: string; forkHandle: string } = { forkHandle: '' },
): Promise<LichenWikiRecord> {
  const { loadPublicWikiData } = await import('@/lib/lichen/load-public-wiki')
  const source = await loadPublicWikiData(sourceHandle, sourceSlug, { force: true })
  if (!source.wiki) throw new Error('That wiki could not be loaded for remixing')

  const { uniqueSlug } = await import('@/lib/atproto/lichen')
  const slug = uniqueSlug(options.name?.trim() || source.wiki.name, [])
  const { wiki, baselines } = await forkWiki(agent, source, {
    slug,
    name: options.name?.trim() || `${source.wiki.name} remix`,
    onProgress: () => {},
  })
  const { saveFork } = await import('@/lib/lichen/fork')
  saveFork(
    buildForkRecord({
      wiki,
      forkHandle: options.forkHandle,
      source,
      baselines,
      autoSync: false,
    }),
  )
  return wiki
}
