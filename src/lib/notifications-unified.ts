/**
 * Unified, Bluesky-style notifications: every source (Bluesky social, wiki
 * watch updates, forum replies, review/mod queues) collapses into one stacked
 * feed with chip filters — All / People I follow / Replies / Follows /
 * Post alerts — mirroring the reference notifications UI.
 *
 * Stacking rules (same visual language as the reference):
 *  - like/repost/quote on one subject → one row, avatar cluster, "+N others"
 *  - replies to one subject → one row with "View all"
 *  - follows → one stacked row with per-account follow-back
 *  - subscribed-post (post alerts) → one row per author ("New posts from X")
 *  - wiki changes from one wiki → one stacked row per wiki burst
 */

import type { Agent } from '@atproto/api'

export type NotificationFilter =
  | 'all'
  | 'following'
  | 'replies'
  | 'follows'
  | 'alerts'

export type NotificationKind =
  | 'follow'
  | 'like'
  | 'repost'
  | 'reply'
  | 'mention'
  | 'quote'
  | 'post-alert'
  | 'wiki-change'
  | 'forum-reply'
  | 'review'
  | 'other'

export type NotificationSource = 'bluesky' | 'wiki' | 'forum' | 'review'

export interface NotificationActor {
  did: string
  handle: string
  displayName?: string
  avatar?: string
}

export interface UnifiedNotification {
  id: string
  source: NotificationSource
  kind: NotificationKind
  createdAt: string
  /** Newest representative time for the stack. */
  headline: string
  detail?: string
  meta?: string
  actors: NotificationActor[]
  additionalCount: number
  /** In-app route for the whole stack. */
  href: string | null
  /** Out-of-app link (bsky.app) when the subject lives there. */
  externalHref?: string
  /** "View all" target for tall stacks. */
  viewAllHref?: string
  read: boolean
  /** Set for `follow` stacks so rows can offer Follow back. */
  followBackDids?: string[]
  /** Post thumbnail (bluesky embed) when available. */
  thumbnail?: string
  /** Handles the filter "people I follow" without extra fetches. */
  followedAuthors?: Set<string>
}

/* ----------------------------- Bluesky fetching ---------------------------- */

interface BskyNotification {
  uri: string
  cid: string
  author: { did: string; handle: string; displayName?: string; avatar?: string }
  reason: string
  reasonSubject?: string
  record: Record<string, unknown>
  isRead: boolean
  indexedAt: string
  labels?: unknown[]
}

function bskyPostUrlFromUri(uri: string): string {
  const parts = uri.split('/')
  return `https://bsky.app/profile/${parts[2]}/post/${parts[4] ?? ''}`
}

function reasonHeadline(reason: string, authors: NotificationActor[], additional: number): string {
  const first = authors[0]?.displayName || authors[0]?.handle || 'Someone'
  const others = additional > 0 ? ` and ${additional} other${additional === 1 ? '' : 's'}` : ''
  switch (reason) {
    case 'like':
      return `${first}${others} liked your post`
    case 'repost':
      return `${first}${others} reposted your post`
    case 'quote':
      return `${first}${others} quoted your post`
    case 'reply':
      return `${first} replied`
    case 'mention':
      return `${first} mentioned you`
    case 'follow':
      return additional > 0 ? `${first}${others} followed you` : `${first} followed you`
    case 'subscribed-post': {
      const names = authors
        .slice(0, 2)
        .map((author) => author.displayName || author.handle)
        .join(' and ')
      return `New posts from ${names || first}${additional > 0 ? ` and ${additional} more` : ''}`
    }
    default:
      return `${first}${others} · ${reason.replace(/-/g, ' ')}`
  }
}

/** Group key: likes/reposts/quotes stack per subject, follows stack together. */
function stackKey(notification: BskyNotification): string {
  switch (notification.reason) {
    case 'like':
    case 'repost':
    case 'quote':
    case 'reply':
      return `${notification.reason}:${notification.reasonSubject ?? notification.uri}`
    case 'follow':
      return 'follow'
    case 'subscribed-post':
      return `post-alert:${notification.author.did}`
    default:
      return `${notification.reason}:${notification.uri}`
  }
}

export interface BlueskyNotificationResult {
  rows: UnifiedNotification[]
  /** Newest notification time — passed to updateSeen on "mark all read". */
  newestSeenAt: string | null
}

/** Fetch and stack the signed-in account's Bluesky notifications. */
export async function fetchBlueskyNotifications(
  agent: Agent,
  followedDids: Set<string> | null,
  limit = 50,
): Promise<BlueskyNotificationResult> {
  const response = await agent.app.bsky.notification.listNotifications({ limit })
  const notifications = (response.data.notifications ?? []) as BskyNotification[]

  // Actor lookups for "people I follow" filtering.
  const follows = followedDids ?? null

  interface Stack {
    key: string
    items: BskyNotification[]
  }
  const stacks = new Map<string, Stack>()
  for (const item of notifications) {
    const key = stackKey(item)
    const stack = stacks.get(key)
    if (stack) stack.items.push(item)
    else stacks.set(key, { key, items: [item] })
  }

  // Batch-fetch subject posts for stack detail + thumbnails (25 max per call).
  const subjectUris = [
    ...new Set(
      [...stacks.values()]
        .map((stack) => stack.items[0]?.reasonSubject)
        .filter((uri): uri is string => !!uri && uri.includes('app.bsky.feed.post')),
    ),
  ].slice(0, 25)

  const postsByUri = new Map<
    string,
    { text?: string; thumb?: string; authorDid?: string; rkey?: string }
  >()
  if (subjectUris.length) {
    try {
      const posts = await agent.app.bsky.feed.getPosts({ uris: subjectUris })
      for (const post of posts.data.posts) {
        const embed = post.embed as
          | { images?: Array<{ thumb?: string; fullsize?: string; alt?: string }> }
          | { external?: { thumb?: string; title?: string } }
          | undefined
        let thumb: string | undefined
        if (embed && 'images' in embed && embed.images?.length) {
          thumb = embed.images[0]?.thumb ?? embed.images[0]?.fullsize
        } else if (embed && 'external' in embed && embed.external) {
          thumb = embed.external.thumb
        }
        postsByUri.set(post.uri, {
          text: typeof post.record?.text === 'string' ? post.record.text : undefined,
          thumb,
          authorDid: post.author?.did,
          rkey: post.uri.split('/').pop(),
        })
      }
    } catch {
      // Thumbnails/details are best-effort.
    }
  }

  const rows: UnifiedNotification[] = []
  let newestSeenAt: string | null = null

  for (const stack of stacks.values()) {
    const items = stack.items
    const newest = items[0]!
    const reason = newest.reason
    const actors: NotificationActor[] = items
      .slice(0, 3)
      .map((item) => ({
        did: item.author.did,
        handle: item.author.handle,
        displayName: item.author.displayName,
        avatar: item.author.avatar,
      }))
    const additionalCount = Math.max(0, items.length - actors.length)
    const subject = newest.reasonSubject
    const post = subject ? postsByUri.get(subject) : undefined
    const kind: NotificationKind = ((): NotificationKind => {
      switch (reason) {
        case 'like':
        case 'repost':
        case 'quote':
        case 'reply':
        case 'mention':
        case 'follow':
          return reason as NotificationKind
        case 'subscribed-post':
          return 'post-alert'
        default:
          return 'other'
      }
    })()

    const detail =
      post?.text ??
      (typeof newest.record?.text === 'string' ? (newest.record.text as string) : undefined)

    const followedAuthors = new Set(
      actors.filter((actor) => follows?.has(actor.did)).map((actor) => actor.did),
    )

    rows.push({
      id: `bsky:${stack.key}:${newest.uri}`,
      source: 'bluesky',
      kind,
      createdAt: newest.indexedAt,
      headline: reasonHeadline(reason, actors, additionalCount),
      detail,
      actors,
      additionalCount,
      href: null,
      externalHref:
        kind === 'post-alert'
          ? bskyPostUrlFromUri(newest.uri)
          : subject && post?.rkey
            ? `https://bsky.app/profile/${post.authorDid ?? newest.author.did}/post/${post.rkey}`
            : bskyPostUrlFromUri(newest.uri),
      viewAllHref:
        items.length > 1 && subject && post?.rkey
          ? `https://bsky.app/profile/${post.authorDid ?? newest.author.did}/post/${post.rkey}`
          : undefined,
      read: items.every((item) => item.isRead),
      followBackDids:
        kind === 'follow' ? items.map((item) => item.author.did) : undefined,
      thumbnail: post?.thumb,
      followedAuthors,
    })
    if (!newestSeenAt || newest.indexedAt > newestSeenAt) newestSeenAt = newest.indexedAt
  }

  return { rows, newestSeenAt }
}

/** Create a follow record (the "Follow back" button). */
export async function followAccount(agent: Agent, did: string): Promise<void> {
  await agent.app.bsky.graph.follow.create(
    { repo: agent.assertDid },
    { subject: did, createdAt: new Date().toISOString() },
  )
}

/* ------------------------------- Wiki sources ------------------------------ */

export interface WikiNotificationRow {
  id: string
  source: 'wiki' | 'forum' | 'review'
  kind: NotificationKind
  createdAt: string
  headline: string
  detail?: string
  meta?: string
  href: string | null
  externalHref?: string
  read: boolean
  actorName?: string
}

/** Map the app's existing sources into the unified row shape. */
export function unifyWikiRows(rows: WikiNotificationRow[]): UnifiedNotification[] {
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    kind: row.kind,
    createdAt: row.createdAt,
    headline: row.headline,
    detail: row.detail,
    meta: row.meta,
    actors: [],
    additionalCount: 0,
    href: row.href,
    externalHref: row.externalHref,
    read: row.read,
  }))
}

/** Stack wiki-change rows per wiki burst, like post alerts. */
export function stackWikiChangeRows(rows: UnifiedNotification[]): UnifiedNotification[] {
  const bursts = new Map<string, UnifiedNotification[]>()
  const others: UnifiedNotification[] = []
  for (const row of rows) {
    if (row.kind !== 'wiki-change' || !row.meta) {
      others.push(row)
      continue
    }
    const key = row.meta
    const burst = bursts.get(key)
    if (burst) burst.push(row)
    else bursts.set(key, [row])
  }

  const stacked: UnifiedNotification[] = []
  for (const [wikiName, burst] of bursts) {
    const newest = burst[0]!
    if (burst.length < 3) {
      stacked.push(...burst)
      continue
    }
    stacked.push({
      ...newest,
      headline: `New activity in ${wikiName}`,
      detail: burst
        .slice(0, 3)
        .map((row) => row.headline)
        .join(' · '),
      additionalCount: burst.length - 1,
      viewAllHref: burst[0]!.viewAllHref,
    })
  }
  return [...stacked, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* --------------------------------- Filters -------------------------------- */

export function matchesFilter(
  row: UnifiedNotification,
  filter: NotificationFilter,
  followedDids: Set<string> | null,
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'follows':
      return row.kind === 'follow'
    case 'replies':
      return row.kind === 'reply' || row.kind === 'mention' || row.kind === 'forum-reply'
    case 'alerts':
      return row.kind === 'post-alert' || row.kind === 'wiki-change'
    case 'following': {
      if (row.kind === 'wiki-change' || row.kind === 'forum-reply') return true
      if (row.followedAuthors?.size) return true
      if (row.source === 'bluesky') {
        return !!followedDids && row.actors.some((actor) => followedDids.has(actor.did))
      }
      return false
    }
  }
  return true
}

export function sortUnified(rows: UnifiedNotification[]): UnifiedNotification[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
