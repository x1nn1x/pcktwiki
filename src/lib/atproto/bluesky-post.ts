import { RichText, type Agent } from '@atproto/api'
import DiffMatchPatch from 'diff-match-patch'

import {
  blobCid,
  blobRefToJson,
  buildBlobUrl,
  isBlobUrl,
  uploadBlob,
} from '@/lib/atproto/blobs'
import { resolvePdsUrl } from '@/lib/atproto/pds'
import { findMarkdownImages } from '@/lib/editor/image-align'

const HTML_IMAGE_RE = /<img[^>]+src=["']([^"']+)["']/gi
const MAX_IMAGES_PER_POST = 4
/** Edits smaller than this (inserted+deleted characters) do not post. */
const MEANINGFUL_EDIT_CHARS = 280

export function toHashtag(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The one tag every wiki post carries, derived from the deployment host:
 * allour.wiki → `allourwiki`, pckt.wiki → `pcktwiki`. Forks get their own
 * aggregation tag without changing code, and readers can follow it to see
 * pages from every author on the same instance.
 */
export function siteHashtag(): string {
  try {
    const host = new URL(__SITE_URL__).hostname.replace(/^www\./, '')
    const labels = host.split('.').filter(Boolean)
    const name = labels.length >= 2 ? labels[labels.length - 2] : labels[0]
    return toHashtag(name || host) || 'wiki'
  } catch {
    return 'wiki'
  }
}

/** Site tag first, then wiki slug and categories. Deduped; empty tags dropped. */
export function buildPublishHashtags(wikiSlug: string, categories: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const label of [siteHashtag(), wikiSlug, ...categories]) {
    const tag = toHashtag(label)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

export function extractImageUrls(markdown: string): string[] {
  const urls: string[] = []
  const seen = new Set<string>()

  const add = (url: string | null | undefined) => {
    const trimmed = url?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    urls.push(trimmed)
  }

  for (const image of findMarkdownImages(markdown)) {
    add(image.url)
    add(image.thumbUrl)
  }

  HTML_IMAGE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HTML_IMAGE_RE.exec(markdown)) !== null) {
    add(match[1])
  }

  return urls
}

export function diffNewImageUrls(before: string, after: string): string[] {
  const prev = new Set(extractImageUrls(before))
  return extractImageUrls(after).filter((url) => !prev.has(url))
}

function cidFromImageUrl(url: string): string | null {
  const fromBlob = blobCid(url)
  if (fromBlob) return fromBlob
  try {
    const parsed = new URL(url)
    if (parsed.pathname.includes('getBlob')) {
      return parsed.searchParams.get('cid')
    }
  } catch {
    // not a URL
  }
  return null
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function fetchImageBytes(
  agent: Agent,
  url: string,
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
  const did = agent.accountDid
  const cid = cidFromImageUrl(url)

  if (cid && did) {
    const pdsUrl = await resolvePdsUrl(did)
    const blobUrl = buildBlobUrl(pdsUrl, did, cid)
    const response = await fetch(blobUrl)
    if (!response.ok) throw new Error(`Failed to fetch blob ${cid}`)
    return {
      buffer: await response.arrayBuffer(),
      mimeType: response.headers.get('content-type') || 'image/jpeg',
    }
  }

  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch image ${url}`)
    return {
      buffer: await response.arrayBuffer(),
      mimeType: response.headers.get('content-type') || 'image/jpeg',
    }
  }

  throw new Error(`Unsupported image URL: ${url}`)
}

export type SessionBlobMap = Map<string, unknown>

/**
 * Blob refs from this editing session that appear in markdown — attach these
 * on the note revision so PDS getBlob can serve them after save.
 */
export function collectSessionBlobsForContent(
  content: string,
  sessionBlobs: SessionBlobMap,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const url of extractImageUrls(content)) {
    const cached = sessionBlobs.get(url)
    const json = cached ? blobRefToJson(cached) : null
    if (!json) continue
    const cid = blobCid(json)
    if (!cid || seen.has(cid)) continue
    seen.add(cid)
    out.push(json)
  }
  return out
}

export async function resolveImageBlobsForPost(
  agent: Agent,
  urls: string[],
  sessionBlobs: SessionBlobMap,
): Promise<Array<{ blob: Record<string, unknown>; alt: string }>> {
  const images: Array<{ blob: Record<string, unknown>; alt: string }> = []

  for (const url of urls) {
    if (!isBlobUrl(url) && !/^https?:\/\//i.test(url)) continue

    const cached = sessionBlobs.get(url)
    const fromSession = cached ? blobRefToJson(cached) : null
    if (fromSession) {
      images.push({ blob: fromSession, alt: '' })
      continue
    }

    const { buffer, mimeType } = await fetchImageBytes(agent, url)
    const file = new File([buffer], 'image', { type: mimeType })
    const { blob } = await uploadBlob(agent, file)
    const json = blobRefToJson(blob)
    if (!json) throw new Error('Failed to encode uploaded image blob')
    images.push({ blob: json, alt: '' })
  }

  return images
}

export function buildPostText(title: string, noteUrl: string, hashtags: string[]): string {
  const lines = [title.trim(), noteUrl.trim()]
  if (hashtags.length) {
    lines.push(hashtags.map((tag) => `#${tag}`).join(' '))
  }
  return lines.filter(Boolean).join('\n')
}

/**
 * True when an edit is big enough to be worth a Bluesky post. Character-level
 * diff, so moving a paragraph around (same text, new order) still counts but a
 * typo fix does not.
 */
export function hasMeaningfulContentChange(previous: string, next: string): boolean {
  if (previous === next) return false
  if (!previous.trim()) return !!next.trim()

  const dmp = new DiffMatchPatch()
  const diffs = dmp.diff_main(previous, next)
  let changed = 0
  for (const [operation, text] of diffs) {
    if (operation !== 0) changed += text.length
  }
  return changed >= MEANINGFUL_EDIT_CHARS
}

/** Plain-text excerpt for the Bluesky link card. */
export function postDescription(markdown: string, max = 180): string {
  const text = markdown
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text
  const clipped = text.slice(0, max)
  const lastSpace = clipped.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim()}…`
}

/**
 * Post a wiki page to Bluesky: title, canonical link, and the shared hashtag
 * scheme. New images from the edit ride along when there are any; otherwise the
 * page becomes a link card.
 */
export async function postWikiPageToBluesky(
  agent: Agent,
  opts: {
    title: string
    noteUrl: string
    wikiSlug: string
    categories: string[]
    previousContent: string
    nextContent: string
    sessionBlobs: SessionBlobMap
  },
): Promise<{ uris: string[]; skipped: boolean }> {
  const hashtags = buildPublishHashtags(opts.wikiSlug, opts.categories)
  const newUrls = diffNewImageUrls(opts.previousContent, opts.nextContent)
  const images = newUrls.length
    ? await resolveImageBlobsForPost(agent, newUrls, opts.sessionBlobs).catch(() => [])
    : []
  if (!images.length && !hasMeaningfulContentChange(opts.previousContent, opts.nextContent)) {
    return { uris: [], skipped: true }
  }

  const text = buildPostText(opts.title, opts.noteUrl, hashtags)
  const rt = new RichText({ text })
  rt.detectFacetsWithoutResolution()

  const uris: string[] = []
  if (images.length) {
    for (const chunk of chunkArray(images, MAX_IMAGES_PER_POST)) {
      const result = await agent.post({
        text: rt.text,
        facets: rt.facets,
        embed: {
          $type: 'app.bsky.embed.images',
          images: chunk.map((image) => ({
            alt: image.alt,
            image: image.blob as never,
          })),
        },
      })
      uris.push(result.uri)
    }
    return { uris, skipped: false }
  }

  const result = await agent.post({
    text: rt.text,
    facets: rt.facets,
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: opts.noteUrl,
        title: opts.title,
        description: postDescription(opts.nextContent),
      },
    },
  })
  uris.push(result.uri)
  return { uris, skipped: false }
}

export async function createImagePosts(
  agent: Agent,
  opts: {
    title: string
    noteUrl: string
    hashtags: string[]
    images: Array<{ blob: Record<string, unknown>; alt: string }>
  },
): Promise<{ uris: string[] }> {
  if (!opts.images.length) return { uris: [] }

  const text = buildPostText(opts.title, opts.noteUrl, opts.hashtags)
  const rt = new RichText({ text })
  rt.detectFacetsWithoutResolution()

  const uris: string[] = []
  for (const chunk of chunkArray(opts.images, MAX_IMAGES_PER_POST)) {
    const result = await agent.post({
      text: rt.text,
      facets: rt.facets,
      embed: {
        $type: 'app.bsky.embed.images',
        images: chunk.map((image) => ({
          alt: image.alt,
          image: image.blob as never,
        })),
      },
    })
    uris.push(result.uri)
  }
  return { uris }
}

export async function postNewWikiImagesToBluesky(
  agent: Agent,
  opts: {
    title: string
    noteUrl: string
    wikiSlug: string
    categories: string[]
    previousContent: string
    nextContent: string
    sessionBlobs: SessionBlobMap
  },
): Promise<{ uris: string[]; skipped: boolean }> {
  const newUrls = diffNewImageUrls(opts.previousContent, opts.nextContent)
  if (!newUrls.length) return { uris: [], skipped: true }

  const hashtags = buildPublishHashtags(opts.wikiSlug, opts.categories)
  const images = await resolveImageBlobsForPost(agent, newUrls, opts.sessionBlobs)
  if (!images.length) return { uris: [], skipped: true }

  const { uris } = await createImagePosts(agent, {
    title: opts.title,
    noteUrl: opts.noteUrl,
    hashtags,
    images,
  })
  return { uris, skipped: false }
}
