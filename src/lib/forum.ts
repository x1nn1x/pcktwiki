import type { Agent } from '@atproto/api'

/**
 * The wiki forum runs on plain Bluesky posts: a long topic is split into a
 * reply chain at paragraph boundaries, so it reads as a native Bluesky thread
 * and every reply is a real Bluesky reply. Nothing here needs anything but
 * the standard lexicons.
 */

/** Bluesky's post limit is 300 graphemes (emoji count as one). */
export const BSKY_POST_LIMIT = 300

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/** Grapheme count — the number Bluesky actually enforces. */
export function graphemeCount(text: string): number {
  if (!segmenter) return [...text].length
  let count = 0
  for (const _ of segmenter.segment(text)) count += 1
  return count
}

interface Paragraph {
  /** The paragraph text including its trailing blank line. */
  text: string
  /** Grapheme length of the trimmed paragraph content. */
  length: number
}

function paragraphsOf(text: string): Paragraph[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  return normalized.split(/\n{2,}/).map((part) => ({
    text: part,
    length: graphemeCount(part),
  }))
}

export interface PostChunk {
  text: string
  length: number
  /** True when the chunk was cut mid-paragraph because one paragraph alone overflowed. */
  forced: boolean
}

/**
 * Split composer text into Bluesky-sized chunks, preferring paragraph
 * boundaries: paragraphs fill the current chunk until the next one would not
 * fit. A single paragraph longer than the limit is cut at the last sentence
 * (then word) boundary so nothing is lost.
 */
export function splitIntoPosts(text: string, limit = BSKY_POST_LIMIT): PostChunk[] {
  const paragraphs = paragraphsOf(text)
  if (paragraphs.length === 0) return []

  const chunks: PostChunk[] = []
  let current = ''
  let currentLength = 0

  const push = (text: string, forced = false) => {
    const trimmed = text.trim()
    if (trimmed) chunks.push({ text: trimmed, length: graphemeCount(trimmed), forced })
  }

  const breakInside = (paragraph: string): string[] => {
    // Sentence boundaries first, then words, so the cut never orphans a fragment.
    const sentences = paragraph.match(/[^.!?…]+[.!?…]+["')\]]*\s*/g) ?? [paragraph]
    const parts: string[] = []
    let part = ''
    for (const sentence of sentences) {
      if (graphemeCount(part + sentence) > limit && part) {
        parts.push(part)
        part = sentence
      } else {
        part += sentence
      }
    }
    if (part.trim()) parts.push(part)
    // A sentence longer than the limit falls back to word wrapping.
    const safe: string[] = []
    for (const piece of parts) {
      if (graphemeCount(piece) <= limit) {
        safe.push(piece)
        continue
      }
      let line = ''
      for (const word of piece.split(/\s+/)) {
        if (graphemeCount(line + ' ' + word) > limit && line) {
          safe.push(line)
          line = word
        } else {
          line = line ? `${line} ${word}` : word
        }
      }
      if (line.trim()) safe.push(line)
    }
    return safe
  }

  for (const paragraph of paragraphs) {
    const joiner = current ? '\n\n' : ''
    if (currentLength + (joiner ? 2 : 0) + paragraph.length <= limit) {
      current += joiner + paragraph.text
      currentLength += (joiner ? 2 : 0) + paragraph.length
      continue
    }
    if (current) push(current)
    if (paragraph.length <= limit) {
      current = paragraph.text
      currentLength = paragraph.length
    } else {
      const pieces = breakInside(paragraph.text)
      pieces.slice(0, -1).forEach((piece) => push(piece, true))
      current = pieces[pieces.length - 1] ?? ''
      currentLength = graphemeCount(current)
    }
  }
  push(current)
  return chunks
}

export interface ThreadPost {
  uri: string
  cid: string
  text: string
  createdAt: string
  author: { did: string; handle: string; displayName?: string; avatar?: string }
  replyCount: number
  /** at-uri of the post this chunk replies to, when part of a chain. */
  parentUri?: string
}

export interface ThreadTree {
  post: ThreadPost
  replies: ThreadTree[]
}

function atUriToKey(uri: string): { did: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri)
  return m ? { did: m[1], rkey: m[2] } : null
}

function mapPost(value: Record<string, unknown>, uri: string, cid: string): ThreadPost {
  const author = (value.author ?? {}) as Record<string, unknown>
  const record = (value.record ?? {}) as Record<string, unknown>
  const parent = (value.record as { reply?: { parent?: { uri?: string } } })?.reply?.parent?.uri
  return {
    uri,
    cid,
    text: String(record.text ?? ''),
    createdAt: String(record.createdAt ?? ''),
    author: {
      did: String(author.did ?? ''),
      handle: String(author.handle ?? ''),
      displayName: typeof author.displayName === 'string' ? author.displayName : undefined,
      avatar: typeof author.avatar === 'string' ? author.avatar : undefined,
    },
    replyCount: Number(value.replyCount ?? 0),
    parentUri: parent,
  }
}

/**
 * Fetch a Bluesky thread through the public AppView. `depth` controls how
 * many reply levels come back (0 = just the post).
 */
export async function fetchThread(
  threadUri: string,
  depth = 6,
): Promise<ThreadTree | null> {
  const key = atUriToKey(threadUri)
  if (!key) return null
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(threadUri)}&depth=${depth}`
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) return null
  const body = await response.json()
  const thread = body.thread
  if (!thread || thread.$type === 'app.bsky.feed.defs#notFoundPost') return null

  const mapTree = (node: Record<string, unknown>): ThreadTree => ({
    post: mapPost(node, String(node.uri ?? ''), String(node.cid ?? '')),
    replies: ((node.replies ?? []) as Record<string, unknown>[])
      .filter((r) => r.$type !== 'app.bsky.feed.defs#notFoundPost')
      .map(mapTree)
      .sort(
        (a, b) =>
          a.post.createdAt.localeCompare(b.post.createdAt) ||
          a.post.uri.localeCompare(b.post.uri),
      ),
  })
  return mapTree(thread)
}

/** Flatten a chain (root + its continuation replies) into ordered chunks. */
export function threadChunks(tree: ThreadTree): ThreadPost[] {
  const chunks: ThreadPost[] = [tree.post]
  let level = tree.replies
  while (level.length) {
    // The author's own continuation is the thread body; other replies hang
    // off the same post and are shown as forum replies instead.
    const continuation = level.find((r) => r.post.author.did === tree.post.author.did)
    if (!continuation) break
    chunks.push(continuation.post)
    level = continuation.replies
  }
  return chunks
}

export interface PublishThreadResult {
  root: { uri: string; cid: string }
  leaf: { uri: string; cid: string }
  chunks: number
}

/**
 * Publish composer text as a Bluesky thread: chunk 0 is the root, every
 * further chunk replies to the previous one with the thread's root set.
 * `linkUrl` is appended to the first chunk so Bluesky readers can reach the
 * wiki without knowing anything about ATProto.
 */
export async function publishThread(
  agent: Agent,
  text: string,
  options: {
    linkUrl?: string
    replyTo?: { uri: string; cid: string }
    replyRoot?: { uri: string; cid: string }
    /** Called after each chunk posts, for progress UI. */
    onProgress?: (posted: number, total: number) => void
  } = {},
): Promise<PublishThreadResult> {
  let body = text.trim()
  if (options.linkUrl && !body.includes(options.linkUrl)) {
    body = `${body}\n\n${options.linkUrl}`
  }
  const chunks = splitIntoPosts(body)
  if (!chunks.length) throw new Error('Nothing to post yet.')

  let parent = options.replyTo ?? null
  let root = options.replyRoot ?? options.replyTo ?? null
  let rootRef: { uri: string; cid: string } | null = root
  let leaf: { uri: string; cid: string } | null = null
  let index = 0

  for (const chunk of chunks) {
    index += 1
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: chunk.text,
      createdAt: new Date().toISOString(),
      ...(parent && rootRef
        ? { reply: { root: rootRef, parent } }
        : {}),
    }
    const created = await agent.com.atproto.repo.createRecord({
      repo: agent.accountDid,
      collection: 'app.bsky.feed.post',
      record,
    })
    const ref = { uri: created.data.uri, cid: created.data.cid }
    if (!rootRef) rootRef = ref
    parent = ref
    leaf = ref
    options.onProgress?.(index, chunks.length)
  }

  if (!rootRef || !leaf) throw new Error('Nothing to post yet.')
  return { root: rootRef, leaf, chunks: chunks.length }
}
