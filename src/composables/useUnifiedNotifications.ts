import { computed, ref } from 'vue'
import type { Router } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { useWatchNotifications } from '@/composables/useWatchNotifications'
import { useForumNotifications } from '@/composables/useForumNotifications'
import { useMemberRequestNotifications } from '@/composables/useMemberRequestNotifications'
import { listIncomingSuggestions } from '@/lib/lichen/suggestions-remote'
import { notificationHeadline, notificationPath } from '@/lib/notifications'
import {
  fetchBlueskyNotifications,
  followAccount,
  matchesFilter,
  sortUnified,
  stackWikiChangeRows,
  type NotificationFilter,
  type UnifiedNotification,
  type WikiNotificationRow,
} from '@/lib/notifications-unified'

const FOLLOWS_CACHE_KEY = 'pckt.wiki.notif.follows'

function readFollowsCache(): Set<string> | null {
  try {
    const raw = sessionStorage.getItem(FOLLOWS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { dids?: string[] }
    return new Set(Array.isArray(parsed.dids) ? parsed.dids : [])
  } catch {
    return null
  }
}

function writeFollowsCache(dids: Set<string>): void {
  try {
    sessionStorage.setItem(FOLLOWS_CACHE_KEY, JSON.stringify({ dids: [...dids] }))
  } catch {
    // private mode
  }
}

/**
 * One stacked, filterable feed out of every notification source:
 * Bluesky social (the signed-in account), wiki watch updates, forum replies,
 * and the review queue (join requests + suggested edits). Sources beyond these
 * plug into the same row shape as they come online.
 */
export function useUnifiedNotifications(router: Router) {
  const auth = useAuthStore()
  const lichen = useLichenStore()

  const watch = useWatchNotifications()
  const forum = useForumNotifications()
  const reviews = useMemberRequestNotifications()

  const rows = ref<UnifiedNotification[]>([])
  const loading = ref(false)
  const filter = ref<NotificationFilter>('all')
  const followedDids = ref<Set<string> | null>(readFollowsCache())
  const followBackDone = ref<Set<string>>(new Set())
  const followBackPending = ref<Set<string>>(new Set())
  const showReadingList = ref(false)
  let newestSeenAt: string | null = null

  const filteredRows = computed(() =>
    sortUnified(rows.value.filter((row) => matchesFilter(row, filter.value, followedDids.value))),
  )

  const unreadCount = computed(() => rows.value.filter((row) => !row.read).length)

  const unreadByFilter = computed(() => {
    const counts: Record<NotificationFilter, number> = {
      all: 0,
      following: 0,
      replies: 0,
      follows: 0,
      alerts: 0,
    }
    for (const row of rows.value) {
      if (row.read) continue
      for (const key of Object.keys(counts) as NotificationFilter[]) {
        if (matchesFilter(row, key, followedDids.value)) counts[key] += 1
      }
    }
    return counts
  })

  async function loadFollows(): Promise<void> {
    if (!auth.agent || followedDids.value) return
    try {
      const dids = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < 3; page += 1) {
        const response = await auth.agent.app.bsky.graph.getFollows({
          actor: auth.did!,
          limit: 100,
          cursor,
        })
        for (const follow of response.data.follows) dids.add(follow.did)
        cursor = response.data.cursor
        if (!cursor || dids.size >= 300) break
      }
      followedDids.value = dids
      writeFollowsCache(dids)
    } catch {
      // Filtering falls back to "not followed" without the graph read.
    }
  }

  async function load() {
    loading.value = true
    try {
      const wikiRows: UnifiedNotification[] = []
      // Wiki watch updates (works signed out — public reads).
      void watch.loadNotifications()
      for (const notification of watch.notifications.value) {
        const row: WikiNotificationRow = {
          id: notification.id,
          source: 'wiki',
          kind: 'wiki-change',
          createdAt: notification.createdAt,
          headline: notificationHeadline(notification),
          detail: notification.detail,
          meta: notification.wikiName,
          href: notificationPath(notification),
          read: watch.isRead(notification.id),
        }
        wikiRows.push(...unifyWikiRowsLocal([row]))
      }

      // Forum replies (Bluesky threads started from wiki forums).
      if (auth.agent) void forum.load(auth.agent)
      for (const row of forum.rows.value) {
        wikiRows.push({
          id: `forum:${row.rootPost}`,
          source: 'forum',
          kind: 'forum-reply',
          createdAt: row.bskyUrl.includes('/post/') ? '' : '',
          headline: `${row.replies} repl${row.replies === 1 ? 'y' : 'ies'}${
            row.replies > row.seen ? ` (${row.replies - row.seen} new)` : ''
          }`,
          detail: `${row.excerpt}…`,
          meta: `on Bluesky · @${row.author}`,
          actors: [],
          additionalCount: 0,
          href: null,
          externalHref: row.bskyUrl,
          read: row.replies <= row.seen,
        })
      }

      // Review queue: join requests + suggested edits on owned wikis.
      if (auth.agent) {
        if (!lichen.activeWikis.length) {
          await lichen.loadOwnerWikis(auth.agent).catch(() => {})
        }
        const owned = lichen.activeWikis.filter((wiki) => wiki.ownerDid === auth.did)
        if (owned.length) {
          void reviews.loadForWikis(auth.agent, owned)
        }
        for (const wiki of owned) {
          const pending = reviews.pendingByWiki.value[wiki.uri]?.length ?? 0
          if (pending) {
            wikiRows.push({
              id: `review:join:${wiki.slug}`,
              source: 'review',
              kind: 'review',
              createdAt: new Date().toISOString(),
              headline: `${pending} join request${pending === 1 ? '' : 's'}`,
              meta: wiki.name,
              actors: [],
              additionalCount: 0,
              href: auth.handle ? `/@${auth.handle}/${wiki.slug}/settings` : null,
              read: false,
            })
          }
          try {
            const suggestions = await listIncomingSuggestions(auth.agent, wiki.uri)
            if (suggestions.length) {
              wikiRows.push({
                id: `review:sugg:${wiki.slug}`,
                source: 'review',
                kind: 'review',
                createdAt: new Date().toISOString(),
                headline: `${suggestions.length} suggested edit${suggestions.length === 1 ? '' : 's'}`,
                meta: wiki.name,
                actors: [],
                additionalCount: 0,
                href: auth.handle ? `/@${auth.handle}/${wiki.slug}/suggestions` : null,
                read: false,
              })
            }
          } catch {
            // skip unreachable wikis
          }
        }
      }

      // Bluesky social notifications for the signed-in account.
      if (auth.agent) {
        await loadFollows()
        try {
          const result = await fetchBlueskyNotifications(
            auth.agent,
            followedDids.value,
          )
          newestSeenAt = result.newestSeenAt
          wikiRows.push(...result.rows)
        } catch {
          // Bluesky appview unreachable — wiki sources still render.
        }
      }

      rows.value = stackWikiChangeRows(wikiRows)
    } finally {
      loading.value = false
    }
  }

  function unifyWikiRowsLocal(rowsIn: WikiNotificationRow[]): UnifiedNotification[] {
    return rowsIn.map((row) => ({
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

  async function markAllRead(): Promise<void> {
    watch.markAllRead()
    forum.markAllRead()
    if (auth.agent && newestSeenAt) {
      try {
        await auth.agent.app.bsky.notification.updateSeen({ seenAt: newestSeenAt })
      } catch {
        // seen-state is best-effort
      }
    }
    rows.value = rows.value.map((row) => ({ ...row, read: true }))
  }

  async function followBack(did: string): Promise<void> {
    if (!auth.agent || followBackDone.value.has(did)) return
    followBackPending.value.add(did)
    try {
      await followAccount(auth.agent, did)
      followBackDone.value.add(did)
      followedDids.value?.add(did)
    } catch {
      // Leave the button available; the graph write is best-effort in UI terms.
    } finally {
      followBackPending.value.delete(did)
    }
  }

  function openRow(row: UnifiedNotification): void {
    if (row.externalHref) {
      window.open(row.externalHref, '_blank', 'noopener,noreferrer')
      return
    }
    if (row.href) {
      void router.push(row.href)
    }
  }

  return {
    rows,
    filteredRows,
    loading,
    filter,
    unreadCount,
    unreadByFilter,
    followedDids,
    followBackDone,
    followBackPending,
    showReadingList,
    load,
    markAllRead,
    followBack,
    openRow,
    // reading-list passthroughs (the "Watching" view)
    watch: watch,
  }
}
