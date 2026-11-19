import { FEATURED_SPOTLIGHT_HANDLES, FEATURED_WIKI_HANDLES } from '@/data/featured-wiki-catalog'
import { assetUrl } from '@/lib/base-url'
import { WIKI_FETCH_CONCURRENCY } from '@/lib/cache-constants'
import { runSettledWithConcurrency } from '@/lib/concurrency'
import { isBranchSlug } from '@/lib/lichen/branches'
import { parseNoteContent } from '@/lib/lichen/content-meta'
import { loadPublicWikiData } from '@/lib/lichen/load-public-wiki'
import type { PublicWikiCacheEntry } from '@/lib/lichen/load-public-wiki'
import type { LichenNoteWithContent } from '@/types/lichen'

export interface FeaturedWiki {
  handle: string
  slug: string
  name: string
  description: string
  language: string
  noteCount: number
  accentColor: string
  /** When the wiki record was created, ISO 8601. */
  createdAt?: string
  /** Most recent revision across the wiki's notes, ISO 8601. */
  updatedAt?: string
}

/** One article surfaced inside the featured-wiki card. */
export interface FeaturedWikiHighlight {
  slug: string
  title: string
  excerpt: string
}

/** Everything the "Featured wiki" box shows about the wiki it picked. */
export interface FeaturedWikiDetail {
  wiki: FeaturedWiki
  /** Opening sentences from the wiki's home page, when it has one. */
  intro: string
  /** A few articles to preview, longest first. */
  highlights: FeaturedWikiHighlight[]
  /** Article titles beyond the highlights, for the "also covers" line. */
  moreTitles: string[]
}

export interface DidYouKnowItem {
  wiki: FeaturedWiki
  before: string
  highlight: string
  after: string
  /** When set, the highlight links to this article instead of the wiki home. */
  noteSlug?: string
}

export interface WikiPortalStats {
  wikiCount: number
  noteCount: number
  contributorCount: number
}

export interface FeaturedWikiReference {
  handle: string
  slug: string
}

const BRAND_COLORS = ['#58a7ff', '#ff5d5b', '#21dc66', '#ffca46'] as const

const DEFAULT_DESCRIPTION = 'A public wiki on Lichen.'
const MIN_FACT_BODY_CHARS = 40
const FACT_SNIPPET_MAX = 180
const INTRO_MAX = 260
const HIGHLIGHT_COUNT = 3
const HIGHLIGHT_EXCERPT_MAX = 120
const MORE_TITLE_COUNT = 6

let cachedWikis: FeaturedWiki[] | null = null
let cachedNotesByWiki = new Map<string, LichenNoteWithContent[]>()
let loadPromise: Promise<FeaturedWiki[]> | null = null

/**
 * Build-time snapshot: the landing page cannot wait on one PDS round-trip per
 * featured wiki before it can paint previews, so a committed JSON file carries
 * the same data the network path produces. Loaded instantly, refreshed behind
 * the scenes when it is old.
 */
export interface FeaturedWikiSnapshotNote {
  slug: string
  title: string
  /** Body text, already stripped of markdown and clipped for card previews. */
  text: string
}

export interface FeaturedWikiSnapshot {
  fetchedAt: string
  wikis: FeaturedWiki[]
  /** Keyed by `handle:slug`. */
  notes: Record<string, FeaturedWikiSnapshotNote[]>
}

const FEATURED_SNAPSHOT_URL = 'featured-wikis-snapshot.json'
const FEATURED_SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SNAPSHOT_NOTE_TEXT_MAX = 600

let featuredSnapshot: FeaturedWikiSnapshot | null = null
let featuredSnapshotLoaded = false

function snapshotNoteToNote(
  key: string,
  note: FeaturedWikiSnapshotNote,
): LichenNoteWithContent {
  return {
    uri: `at://snapshot/${key}/${note.slug}`,
    cid: '',
    slug: note.slug,
    title: note.title,
    wikiRef: `at://snapshot/${key}`,
    createdAt: '',
    content: note.text,
    latestRevisionUri: null,
  }
}

/** Serializable form of whatever the network load just produced. */
export function buildFeaturedWikiSnapshot(
  wikis: FeaturedWiki[] = getCachedFeaturedWikis(),
): FeaturedWikiSnapshot {
  const notes: Record<string, FeaturedWikiSnapshotNote[]> = {}
  for (const wiki of wikis) {
    notes[wikiKey(wiki)] = getCachedNotes(wiki).map((note) => ({
      slug: note.slug,
      title: note.title,
      text: noteBodyText(note).slice(0, SNAPSHOT_NOTE_TEXT_MAX),
    }))
  }
  return { fetchedAt: new Date().toISOString(), wikis, notes }
}

function applyFeaturedWikiSnapshot(snapshot: FeaturedWikiSnapshot): FeaturedWiki[] {
  cachedWikis = snapshot.wikis
  cachedNotesByWiki = new Map()
  for (const [key, notes] of Object.entries(snapshot.notes ?? {})) {
    cachedNotesByWiki.set(key, notes.map((note) => snapshotNoteToNote(key, note)))
  }
  return snapshot.wikis
}

export function getFeaturedWikiSnapshot(): FeaturedWikiSnapshot | null {
  return featuredSnapshot
}

/** Loads the committed snapshot once per session; safe to call repeatedly. */
export async function loadFeaturedWikiSnapshot(): Promise<FeaturedWikiSnapshot | null> {
  if (featuredSnapshotLoaded) return featuredSnapshot
  featuredSnapshotLoaded = true
  try {
    const response = await fetch(assetUrl(FEATURED_SNAPSHOT_URL))
    if (!response.ok) return null
    const snapshot = (await response.json()) as FeaturedWikiSnapshot
    if (!Array.isArray(snapshot?.wikis) || !snapshot.wikis.length) return null
    const age = Date.now() - Date.parse(snapshot.fetchedAt)
    if (Number.isNaN(age) || age > FEATURED_SNAPSHOT_TTL_MS) return null
    featuredSnapshot = snapshot
    return snapshot
  } catch {
    return null
  }
}

/** Snapshot age in ms, or Infinity when no snapshot is loaded. */
export function featuredSnapshotAgeMs(): number {
  if (!featuredSnapshot) return Infinity
  const age = Date.now() - Date.parse(featuredSnapshot.fetchedAt)
  return Number.isNaN(age) ? Infinity : age
}

export function wikiPath(handle: string, wikiSlug: string): string {
  return `/@${encodeURIComponent(handle)}/${encodeURIComponent(wikiSlug)}`
}

export function notePath(handle: string, wikiSlug: string, noteSlug: string): string {
  return `${wikiPath(handle, wikiSlug)}/${encodeURIComponent(noteSlug)}`
}

export function parseFeaturedWikiHandle(ref: string): FeaturedWikiReference {
  const normalized = ref.trim().replace(/^@/, '')
  const slash = normalized.indexOf('/')
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new Error(`Invalid featured wiki handle "${ref}" — expected handle/slug`)
  }

  return {
    handle: normalized.slice(0, slash),
    slug: normalized.slice(slash + 1),
  }
}

export function listFeaturedWikiReferences(): FeaturedWikiReference[] {
  const seen = new Set<string>()
  const refs: FeaturedWikiReference[] = []

  for (const handle of [...FEATURED_WIKI_HANDLES, ...FEATURED_SPOTLIGHT_HANDLES]) {
    const ref = parseFeaturedWikiHandle(handle)
    const key = wikiKeyFromParts(ref.handle, ref.slug)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }

  return refs
}

/** The `handle/slug` entries eligible for the "Featured wiki" box. */
export function listSpotlightReferences(): FeaturedWikiReference[] {
  return FEATURED_SPOTLIGHT_HANDLES.map(parseFeaturedWikiHandle)
}

export function accentColorForSlug(slug: string, index = 0): string {
  let hash = 0
  for (let i = 0; i < slug.length; i++) {
    hash = (hash << 5) - hash + slug.charCodeAt(i)
    hash |= 0
  }
  return BRAND_COLORS[Math.abs(hash) % BRAND_COLORS.length] ?? BRAND_COLORS[index % BRAND_COLORS.length]
}

/**
 * Counts readable articles: no home page, talk pages, or branches, and a slug
 * that exists as several note records still counts once.
 */
function countArticles(entry: PublicWikiCacheEntry): number {
  const slugs = new Set(
    entry.notesWithContent.filter(isArticleNote).map((note) => note.slug),
  )
  return slugs.size
}

function latestRevisionAt(entry: PublicWikiCacheEntry): string | undefined {
  let latest: string | undefined
  for (const revision of entry.revisionRecords) {
    if (!latest || revision.createdAt > latest) latest = revision.createdAt
  }
  return latest
}

function entryToFeaturedWiki(
  handle: string,
  slug: string,
  entry: PublicWikiCacheEntry,
  index: number,
): FeaturedWiki | null {
  if (!entry.wiki || entry.wiki.visibility !== 'public') return null

  const description = entry.wiki.description?.trim() || DEFAULT_DESCRIPTION

  return {
    handle,
    slug,
    name: entry.wiki.name,
    description,
    language: entry.wiki.language || 'EN',
    noteCount: countArticles(entry),
    accentColor: accentColorForSlug(slug, index),
    createdAt: entry.wiki.createdAt,
    updatedAt: latestRevisionAt(entry),
  }
}

export function getCachedFeaturedWikis(): FeaturedWiki[] {
  return cachedWikis ?? []
}

export function findCachedFeaturedWiki(handle: string, slug: string): FeaturedWiki | undefined {
  const key = `${handle.toLowerCase()}:${slug}`
  return getCachedFeaturedWikis().find(
    (wiki) => `${wiki.handle.toLowerCase()}:${wiki.slug}` === key,
  )
}

export async function loadFeaturedWikis(options?: { force?: boolean }): Promise<FeaturedWiki[]> {
  if (!options?.force && cachedWikis) return cachedWikis
  if (!options?.force && loadPromise) return loadPromise

  // Static snapshot first: previews paint immediately, then the caller can
  // refresh from the network in the background.
  if (!options?.force) {
    const snapshot = await loadFeaturedWikiSnapshot()
    if (snapshot) return applyFeaturedWikiSnapshot(snapshot)
  }

  loadPromise = (async () => {
    const refs = listFeaturedWikiReferences()
    cachedNotesByWiki = new Map()

    const results = await runSettledWithConcurrency(
      refs,
      WIKI_FETCH_CONCURRENCY,
      async (ref, index) => {
        try {
          const data = await loadPublicWikiData(ref.handle, ref.slug)
          cachedNotesByWiki.set(wikiKeyFromParts(ref.handle, ref.slug), data.notesWithContent)
          return entryToFeaturedWiki(ref.handle, ref.slug, data, index)
        } catch {
          cachedNotesByWiki.set(wikiKeyFromParts(ref.handle, ref.slug), [])
          return null
        }
      },
    )

    const wikis = results.flatMap((result, index) => {
      if (result.status !== 'fulfilled') return []
      const wiki = result.value
      if (wiki) return [wiki]

      const ref = refs[index]!
      return [{
        handle: ref.handle,
        slug: ref.slug,
        name: ref.slug.replace(/-/g, ' '),
        description: DEFAULT_DESCRIPTION,
        language: 'EN',
        noteCount: 0,
        accentColor: accentColorForSlug(ref.slug, index),
      }]
    })

    cachedWikis = wikis
    return wikis
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

export function shuffledCopy<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = copy[i]!
    copy[i] = copy[j]!
    copy[j] = temp
  }
  return copy
}

function wikiKey(wiki: FeaturedWiki): string {
  return `${wiki.handle.toLowerCase()}:${wiki.slug}`
}

function wikiKeyFromParts(handle: string, slug: string): string {
  return `${handle.toLowerCase()}:${slug}`
}

function stripMarkup(body: string): string {
  return body
    .replace(/\{\{infobox[\s\S]*?\}\}/gi, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\[\[([^|\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, label) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function noteBodyText(note: LichenNoteWithContent): string {
  const parsed = parseNoteContent(note.content)
  if (parsed.redirect) return ''
  return stripMarkup(parsed.body)
}

function isFactNote(note: LichenNoteWithContent): boolean {
  if (note.slug.startsWith('talk:')) return false
  return noteBodyText(note).length >= MIN_FACT_BODY_CHARS
}

function pickFactNote(notes: LichenNoteWithContent[]): LichenNoteWithContent | null {
  const pool = notes.filter((note) => !note.slug.startsWith('talk:') && isFactNote(note))
  if (pool.length === 0) return null
  return shuffledCopy(pool)[0]!
}

function firstFactSentence(text: string): string {
  const sentenceMatch = text.match(/(.{30,220}?[.!?])(?:\s|$)/)
  if (sentenceMatch) return sentenceMatch[1]!.trim()

  if (text.length <= FACT_SNIPPET_MAX) return text

  const truncated = text.slice(0, FACT_SNIPPET_MAX).trim()
  const lastSpace = truncated.lastIndexOf(' ')
  const clip = lastSpace > 60 ? truncated.slice(0, lastSpace) : truncated
  return `${clip.trim()}…`
}

function sentenceAfterTitle(sentence: string, title: string): string {
  const trimmed = sentence.trim()
  if (!trimmed.toLowerCase().startsWith(title.trim().toLowerCase())) return trimmed

  let rest = trimmed.slice(title.length).trim()
  if (rest.startsWith(':') || rest.startsWith('—') || rest.startsWith('-')) {
    rest = rest.slice(1).trim()
  }
  return rest || trimmed
}

function ensureQuestion(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed.endsWith('?') ? trimmed : `${trimmed}?`
}

function lowercaseStart(text: string): string {
  if (!text) return text
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function getCachedNotes(wiki: FeaturedWiki): LichenNoteWithContent[] {
  return cachedNotesByWiki.get(wikiKey(wiki)) ?? []
}

export function getWikiPortalStats(wikis: FeaturedWiki[]): WikiPortalStats {
  return {
    wikiCount: wikis.length,
    noteCount: wikis.reduce((sum, wiki) => sum + wiki.noteCount, 0),
    contributorCount: new Set(wikis.map((wiki) => wiki.handle)).size,
  }
}

/**
 * Picks the wiki for the "Featured wiki" box: a random entry from the spotlight
 * pool, so it cycles on every load. Falls back to the wider catalog when none of
 * the spotlight wikis loaded.
 */
export function getFeaturedWiki(wikis: FeaturedWiki[]): FeaturedWiki | null {
  const spotlightKeys = new Set(
    listSpotlightReferences().map((ref) => wikiKeyFromParts(ref.handle, ref.slug)),
  )
  const pool = wikis.filter((wiki) => spotlightKeys.has(wikiKey(wiki)))
  const candidates = pool.length > 0 ? pool : wikis

  return candidates.length > 0 ? shuffledCopy(candidates)[0]! : null
}

function excerptFrom(text: string, max: number): string {
  if (text.length <= max) return text

  const truncated = text.slice(0, max).trim()
  const lastSpace = truncated.lastIndexOf(' ')
  const clip = lastSpace > max / 2 ? truncated.slice(0, lastSpace) : truncated
  return `${clip.trim()}…`
}

function isArticleNote(note: LichenNoteWithContent): boolean {
  return note.slug !== 'home' && !note.slug.startsWith('talk:') && !isBranchSlug(note.slug)
}

export function buildFeaturedWikiDetail(
  wiki: FeaturedWiki,
  notes: LichenNoteWithContent[] = getCachedNotes(wiki),
): FeaturedWikiDetail {
  const home = notes.find((note) => note.slug === 'home')
  const homeText = home ? noteBodyText(home) : ''
  const intro = homeText ? excerptFrom(homeText, INTRO_MAX) : ''

  // A slug can appear more than once when a note was re-created; keep the copy
  // that actually has text so previews do not land on an empty duplicate.
  const bySlug = new Map<string, { note: LichenNoteWithContent; text: string }>()
  for (const note of notes.filter(isArticleNote)) {
    const candidate = { note, text: noteBodyText(note) }
    const existing = bySlug.get(note.slug)
    if (!existing || candidate.text.length > existing.text.length) {
      bySlug.set(note.slug, candidate)
    }
  }

  const articles = [...bySlug.values()].sort((a, b) => b.text.length - a.text.length)

  const highlights = articles.slice(0, HIGHLIGHT_COUNT).map(({ note, text }) => {
    const body = sentenceAfterTitle(text, note.title)
    return {
      slug: note.slug,
      title: note.title,
      // Stubs and one-word bodies repeat the title, so only preview real prose.
      excerpt: body.length >= MIN_FACT_BODY_CHARS ? excerptFrom(body, HIGHLIGHT_EXCERPT_MAX) : '',
    }
  })

  const moreTitles = articles
    .slice(HIGHLIGHT_COUNT, HIGHLIGHT_COUNT + MORE_TITLE_COUNT)
    .map(({ note }) => note.title)

  return { wiki, intro, highlights, moreTitles }
}

export function getSpotlightWikis(
  wikis: FeaturedWiki[],
  count = 3,
  exclude?: FeaturedWiki,
): FeaturedWiki[] {
  const excludeKey = exclude ? wikiKey(exclude) : null
  return shuffledCopy(wikis)
    .filter((wiki) => wikiKey(wiki) !== excludeKey)
    .slice(0, count)
}

export function buildDidYouKnowItem(
  wiki: FeaturedWiki,
  notes: LichenNoteWithContent[] = getCachedNotes(wiki),
): DidYouKnowItem {
  const note = pickFactNote(notes)
  if (note) {
    const sentence = firstFactSentence(noteBodyText(note))

    if (note.slug === 'home') {
      return {
        wiki,
        before: '… that ',
        highlight: wiki.name,
        after: `: ${ensureQuestion(sentence)}`,
      }
    }

    const continuation = lowercaseStart(sentenceAfterTitle(sentence, note.title))
    return {
      wiki,
      before: '… that ',
      highlight: note.title,
      noteSlug: note.slug,
      after: ` ${ensureQuestion(continuation)}`,
    }
  }

  return buildDidYouKnowFallback(wiki)
}

function buildDidYouKnowFallback(wiki: FeaturedWiki): DidYouKnowItem {
  const description = wiki.description.trim()
  let after: string

  if (description && description !== DEFAULT_DESCRIPTION) {
    const sentence = description.endsWith('.') ? description.slice(0, -1) : description
    after = ` ${sentence}?`
  } else if (wiki.noteCount === 1) {
    after = ` is a public wiki with 1 article on @${wiki.handle}?`
  } else if (wiki.noteCount > 1) {
    after = ` has ${wiki.noteCount} articles on @${wiki.handle}?`
  } else {
    after = ` is a public wiki hosted on @${wiki.handle}?`
  }

  return {
    wiki,
    before: '… that ',
    highlight: wiki.name,
    after,
  }
}

export function getDidYouKnowItems(wikis: FeaturedWiki[], count = 4): DidYouKnowItem[] {
  return shuffledCopy(wikis.map((wiki) => buildDidYouKnowItem(wiki))).slice(0, count)
}

export function sortWikisByNoteCount(wikis: FeaturedWiki[]): FeaturedWiki[] {
  return [...wikis].sort((a, b) => b.noteCount - a.noteCount)
}

export function growingWikis(wikis: FeaturedWiki[], count = 3): FeaturedWiki[] {
  return [...wikis].sort((a, b) => a.noteCount - b.noteCount).slice(0, count)
}

export interface PortalWikiSelection {
  featuredWiki: FeaturedWiki
  featuredDetail: FeaturedWikiDetail
  spotlightWikis: FeaturedWiki[]
  didYouKnowItems: DidYouKnowItem[]
  growingWikis: FeaturedWiki[]
}

export function buildPortalWikiSelection(wikis: FeaturedWiki[]): PortalWikiSelection | null {
  const featuredWiki = getFeaturedWiki(wikis)
  if (!featuredWiki) return null

  return {
    featuredWiki,
    featuredDetail: buildFeaturedWikiDetail(featuredWiki),
    spotlightWikis: getSpotlightWikis(wikis, 3, featuredWiki),
    didYouKnowItems: getDidYouKnowItems(wikis, 4),
    growingWikis: growingWikis(wikis, 3),
  }
}
