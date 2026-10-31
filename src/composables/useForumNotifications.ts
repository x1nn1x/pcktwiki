import { ref } from 'vue'
import type { Agent } from '@atproto/api'
import { listRecords } from '@/lib/atproto/lichen'
import { COLLECTIONS } from '@/lib/lichen/collections'
import { fetchThread } from '@/lib/forum'

/**
 * Forum reply notifications: Bluesky threads the user started through wiki
 * forums, with unseen replies counted against the last time they looked.
 * Seen-state lives in localStorage (root post uri → reply count seen).
 */
const SEEN_KEY = 'pckt.wiki.forum.notif.seen'

export interface ForumNotificationRow {
  rootPost: string
  wikiRef: string
  excerpt: string
  author: string
  replies: number
  seen: number
  bskyUrl: string
}

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // private mode
  }
}

export function bskyPostUrl(uri: string): string {
  const m = /at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri)
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : 'https://bsky.app'
}

export function useForumNotifications() {
  const rows = ref<ForumNotificationRow[]>([])
  const unreadCount = ref(0)
  const loading = ref(false)

  async function load(agent: Agent): Promise<void> {
    loading.value = true
    try {
      const topics = await listRecords(agent, agent.accountDid, COLLECTIONS.forumTopic, (uri, cid, _rkey, value) => ({
        uri,
        cid,
        value: value as Record<string, unknown>,
      }))
      const seen = readSeen()
      const rowsOut: ForumNotificationRow[] = []
      let unread = 0
      for (const topic of topics) {
        const rootPost = String(topic.value.rootPost ?? '')
        if (!rootPost) continue
        const tree = await fetchThread(rootPost, 0)
        if (!tree) continue
        const replies = tree.post.replyCount
        const seenCount = seen[rootPost] ?? 0
        const row: ForumNotificationRow = {
          rootPost,
          wikiRef: String(topic.value.wikiRef ?? ''),
          excerpt: tree.post.text.slice(0, 90),
          author: tree.post.author.handle,
          replies,
          seen: seenCount,
          bskyUrl: bskyPostUrl(rootPost),
        }
        rowsOut.push(row)
        if (replies > seenCount) unread += replies - seenCount
      }
      rowsOut.sort((a, b) => b.replies - b.seen - (a.replies - a.seen))
      rows.value = rowsOut
      unreadCount.value = unread
    } catch {
      rows.value = []
      unreadCount.value = 0
    } finally {
      loading.value = false
    }
  }

  function markAllRead(): void {
    const seen = readSeen()
    for (const row of rows.value) seen[row.rootPost] = row.replies
    writeSeen(seen)
    unreadCount.value = 0
    for (const row of rows.value) row.seen = row.replies
  }

  return { rows, unreadCount, loading, load, markAllRead }
}
