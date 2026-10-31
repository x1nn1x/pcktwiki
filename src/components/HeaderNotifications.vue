<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { wikiPath } from '@/data/featured-wikis'
import { subjectSlugFromTalk } from '@/lib/lichen/content-meta'
import { useMenuDismissGroup } from '@/composables/useMenuDismissGroup'
import { useOverlayDismiss } from '@/composables/useOverlayDismiss'
import { notificationContext, notificationHeadline } from '@/lib/notifications'
import { useWatchNotifications } from '@/composables/useWatchNotifications'
import { useWatchlist } from '@/composables/useWatchlist'
import { useMemberRequestNotifications } from '@/composables/useMemberRequestNotifications'
import { useForumNotifications } from '@/composables/useForumNotifications'
import { listIncomingSuggestions } from '@/lib/lichen/suggestions-remote'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import type { DiscussionWatchEntry } from '@/lib/watchlist'
import type { WatchNotification } from '@/lib/notifications'

type TabId = 'updates' | 'watching' | 'requests' | 'forum'

const open = ref(false)
const tab = ref<TabId>('updates')
const rootRef = ref<HTMLElement | null>(null)

const {
  notifications,
  loading,
  unreadCount: updatesUnreadCount,
  hasWatchlist,
  hasNotifications,
  loadNotifications,
  markRead,
  markAllRead: markAllUpdatesRead,
  openNotification,
  isRead,
} = useWatchNotifications()

const {
  wikis,
  discussions,
  notes,
  unreadCount: watchingUnreadCount,
  hasWikis,
  hasDiscussions,
  hasNotes,
  hasAny,
  sync: syncWatchlist,
  markWikiRead,
  markDiscussionRead,
  markNoteRead,
  markAllRead: markAllWatchingRead,
  isWikiUnread,
  isDiscussionUnread,
  isNoteUnread,
} = useWatchlist()

const auth = useAuthStore()
const lichen = useLichenStore()
const {
  totalPending: requestCount,
  pendingByWiki,
  loadForWikis,
} = useMemberRequestNotifications()

const {
  rows: forumRows,
  unreadCount: forumUnreadCount,
  load: loadForumNotifications,
  markAllRead: markAllForumRead,
} = useForumNotifications()

const suggestionRows = ref<Array<{ wikiName: string; wikiSlug: string; count: number }>>([])
const suggestionCount = ref(0)

async function loadSuggestionReviews() {
  if (!auth.agent) return
  const rowsOut: Array<{ wikiName: string; wikiSlug: string; count: number }> = []
  let total = 0
  for (const wiki of ownedWikis.value) {
    try {
      const pending = await listIncomingSuggestions(auth.agent, wiki.uri)
      if (pending.length) {
        rowsOut.push({ wikiName: wiki.name, wikiSlug: wiki.slug, count: pending.length })
        total += pending.length
      }
    } catch {
      // skip unreachable wikis
    }
  }
  suggestionRows.value = rowsOut
  suggestionCount.value = total
}

const totalUnreadCount = computed(
  () => updatesUnreadCount.value + watchingUnreadCount.value + requestCount.value + forumUnreadCount.value + suggestionCount.value,
)

const ownedWikis = computed(() =>
  lichen.activeWikis.filter((wiki) => wiki.ownerDid === auth.did),
)

const pendingRequestRows = computed(() => {
  const rows: Array<{ wikiName: string; wikiSlug: string; count: number }> = []
  for (const wiki of ownedWikis.value) {
    const count = pendingByWiki.value[wiki.uri]?.length ?? 0
    if (!count) continue
    rows.push({ wikiName: wiki.name, wikiSlug: wiki.slug, count })
  }
  return rows
})

function close() {
  open.value = false
}

const { closeOtherMenus } = useMenuDismissGroup(open, close)

useOverlayDismiss(rootRef, open, close)

function toggle(event: Event) {
  event.stopPropagation()
  if (!open.value) closeOtherMenus()
  open.value = !open.value
}

function setTab(next: TabId) {
  tab.value = next
}

async function onNotificationClick(notification: WatchNotification) {
  close()
  await openNotification(notification)
}

function discussionMeta(entry: DiscussionWatchEntry): string {
  const subject = subjectSlugFromTalk(entry.noteSlug) ?? entry.subjectSlug
  return `${entry.wikiName} · ${subject}`
}

function onWikiClick(wikiUri: string) {
  markWikiRead(wikiUri)
  close()
}

function onDiscussionClick(wikiUri: string, noteSlug: string) {
  markDiscussionRead(wikiUri, noteSlug)
  close()
}

function onNoteClick(wikiUri: string, noteSlug: string) {
  markNoteRead(wikiUri, noteSlug)
  close()
}

function markAllRead() {
  if (tab.value === 'updates') markAllUpdatesRead()
  else if (tab.value === 'watching') markAllWatchingRead()
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  void loadNotifications()
  syncWatchlist()
  if (auth.agent) {
    if (!ownedWikis.value.length) {
      await lichen.loadOwnerWikis(auth.agent).catch(() => {})
    }
    if (ownedWikis.value.length) {
      void loadForWikis(auth.agent, ownedWikis.value)
    }
    void loadForumNotifications(auth.agent)
    void loadSuggestionReviews()
  }
})

watch(tab, async (next) => {
  if (!open.value) return
  if (next === 'updates') void loadNotifications()
  else if (next === 'watching') syncWatchlist()
  else if (next === 'requests' && auth.agent) {
    if (!ownedWikis.value.length) {
      await lichen.loadOwnerWikis(auth.agent).catch(() => {})
    }
    void loadForWikis(auth.agent, ownedWikis.value)
    void loadSuggestionReviews()
  } else if (next === 'forum' && auth.agent) {
    void loadForumNotifications(auth.agent)
  }
})
</script>

<template>
  <div ref="rootRef" class="notif" :class="{ open }">
    <button
      type="button"
      class="notif-trigger"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="totalUnreadCount ? `${totalUnreadCount} unread notifications` : 'Notifications'"
      @click="toggle"
    >
      <svg class="notif-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          d="M10 2a5.25 5.25 0 00-5.25 5.25c0 2.35-.61 4.07-1.27 5.18A1.25 1.25 0 004.56 14.5h3.19a2.25 2.25 0 004.5 0h3.19a1.25 1.25 0 001.08-2.07c-.66-1.11-1.27-2.83-1.27-5.18A5.25 5.25 0 0010 2z"
        />
      </svg>
      <span v-if="totalUnreadCount" class="notif-badge" aria-hidden="true">{{ totalUnreadCount }}</span>
    </button>

    <div v-if="open" class="notif-panel" role="menu">
      <div class="notif-strip" aria-hidden="true">
        <span class="notif-strip-seg notif-strip-green" />
        <span class="notif-strip-seg notif-strip-blue" />
        <span class="notif-strip-seg notif-strip-yellow" />
      </div>

      <header class="notif-header">
        <div class="notif-tabs" role="tablist" aria-label="Notification views">
          <button
            type="button"
            class="notif-tab"
            role="tab"
            :class="{ active: tab === 'updates' }"
            :aria-selected="tab === 'updates'"
            @click.stop="setTab('updates')"
          >
            Updates
            <span v-if="updatesUnreadCount" class="notif-tab-count">{{ updatesUnreadCount }}</span>
          </button>
          <button
            type="button"
            class="notif-tab"
            role="tab"
            :class="{ active: tab === 'watching' }"
            :aria-selected="tab === 'watching'"
            @click.stop="setTab('watching')"
          >
            Watching
            <span v-if="watchingUnreadCount" class="notif-tab-count notif-tab-count-watching">
              {{ watchingUnreadCount }}
            </span>
          </button>
          <button
            v-if="auth.isAuthenticated"
            type="button"
            class="notif-tab"
            role="tab"
            :class="{ active: tab === 'requests' }"
            :aria-selected="tab === 'requests'"
            @click.stop="setTab('requests')"
          >
            Reviews
            <span v-if="requestCount + suggestionCount" class="notif-tab-count">{{
              requestCount + suggestionCount
            }}</span>
          </button>
          <button
            v-if="auth.isAuthenticated"
            type="button"
            class="notif-tab"
            role="tab"
            :class="{ active: tab === 'forum' }"
            :aria-selected="tab === 'forum'"
            @click.stop="setTab('forum')"
          >
            Forum
            <span v-if="forumUnreadCount" class="notif-tab-count notif-tab-count-watching">{{
              forumUnreadCount
            }}</span>
          </button>
        </div>
        <button
          v-if="tab === 'updates' ? updatesUnreadCount : watchingUnreadCount"
          type="button"
          class="notif-mark-all"
          @click.stop="markAllRead"
        >
          Mark all read
        </button>
      </header>

      <div v-if="tab === 'updates'" role="tabpanel">
        <div v-if="loading" class="notif-empty">
          <p class="notif-empty-text muted">Loading updates…</p>
        </div>

        <div v-else-if="!hasWatchlist" class="notif-empty">
          <p class="notif-empty-text muted">
            Nothing watched yet. Tap <strong>Watch wiki</strong> to follow a whole wiki, or
            <strong>Watch this article</strong> to follow a single page.
          </p>
        </div>

        <div v-else-if="!hasNotifications" class="notif-empty">
          <p class="notif-empty-text muted">No recent updates from what you're watching.</p>
        </div>

        <ul v-else class="notif-list">
          <li
            v-for="notification in notifications"
            :key="notification.id"
            class="notif-item"
            :class="{ 'notif-item-read': isRead(notification.id) }"
          >
            <button
              type="button"
              class="notif-link"
              role="menuitem"
              @click="onNotificationClick(notification)"
            >
              <span
                class="notif-dot"
                :class="{ 'notif-dot-unread': !isRead(notification.id) }"
                aria-hidden="true"
              />
              <span class="notif-copy">
                <span class="notif-headline">{{ notificationHeadline(notification) }}</span>
                <span class="notif-detail">{{ notification.detail }}</span>
                <span class="notif-meta muted">{{ notificationContext(notification) }}</span>
              </span>
            </button>
            <button
              v-if="!isRead(notification.id)"
              type="button"
              class="notif-mark-read"
              title="Mark as read"
              aria-label="Mark as read"
              @click.stop="markRead(notification.id)"
            >
              <svg class="notif-mark-read-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path
                  fill-rule="evenodd"
                  d="M16.704 5.29a1 1 0 010 1.42l-7.25 7.25a1 1 0 01-1.42 0l-3.25-3.25a1 1 0 111.42-1.42l2.54 2.54 6.54-6.54a1 1 0 011.42 0z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </li>
        </ul>

        <footer v-if="hasWatchlist" class="notif-footer">
          <RouterLink to="/wikis" class="notif-footer-link" @click="close">
            Browse more wikis
          </RouterLink>
        </footer>
      </div>

      <div v-else-if="tab === 'watching'" role="tabpanel">
        <div v-if="!hasAny" class="notif-empty">
          <p class="notif-empty-text muted">
            Nothing watched yet. On a wiki page, tap <strong>Watch wiki</strong>,
            <strong>Watch this article</strong> or <strong>Watch discussion</strong>
            to save it here.
          </p>
        </div>

        <template v-else>
          <section v-if="hasWikis" class="watch-section">
            <h4 class="watch-section-title">Wikis</h4>
            <ul class="watch-list">
              <li
                v-for="wiki in wikis"
                :key="wiki.wikiUri"
                class="watch-item"
                :class="{ 'watch-item-read': !isWikiUnread(wiki.wikiUri) }"
              >
                <RouterLink
                  :to="wikiPath(wiki.handle, wiki.wikiSlug)"
                  class="watch-link"
                  role="menuitem"
                  @click="onWikiClick(wiki.wikiUri)"
                >
                  <span
                    class="watch-dot"
                    :class="{ 'watch-dot-unread': isWikiUnread(wiki.wikiUri) }"
                    aria-hidden="true"
                  />
                  <span class="watch-copy">
                    <span class="watch-item-title">{{ wiki.wikiName }}</span>
                    <span class="watch-meta muted">@{{ wiki.handle }}</span>
                  </span>
                </RouterLink>
                <button
                  v-if="isWikiUnread(wiki.wikiUri)"
                  type="button"
                  class="watch-mark-read"
                  title="Mark as read"
                  aria-label="Mark as read"
                  @click.stop="markWikiRead(wiki.wikiUri)"
                >
                  <svg class="watch-mark-read-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M16.704 5.29a1 1 0 010 1.42l-7.25 7.25a1 1 0 01-1.42 0l-3.25-3.25a1 1 0 111.42-1.42l2.54 2.54 6.54-6.54a1 1 0 011.42 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </li>
            </ul>
          </section>

          <section v-if="hasNotes" class="watch-section">
            <h4 class="watch-section-title">Articles</h4>
            <ul class="watch-list">
              <li
                v-for="note in notes"
                :key="`${note.wikiUri}::${note.noteSlug}`"
                class="watch-item"
                :class="{ 'watch-item-read': !isNoteUnread(note.wikiUri, note.noteSlug) }"
              >
                <RouterLink
                  :to="`${wikiPath(note.handle, note.wikiSlug)}/${note.noteSlug}`"
                  class="watch-link"
                  role="menuitem"
                  @click="onNoteClick(note.wikiUri, note.noteSlug)"
                >
                  <span
                    class="watch-dot"
                    :class="{ 'watch-dot-unread': isNoteUnread(note.wikiUri, note.noteSlug) }"
                    aria-hidden="true"
                  />
                  <span class="watch-copy">
                    <span class="watch-item-title">{{ note.noteTitle }}</span>
                    <span class="watch-meta muted">{{ note.wikiName }}</span>
                  </span>
                </RouterLink>
                <button
                  v-if="isNoteUnread(note.wikiUri, note.noteSlug)"
                  type="button"
                  class="watch-mark-read"
                  title="Mark as read"
                  aria-label="Mark as read"
                  @click.stop="markNoteRead(note.wikiUri, note.noteSlug)"
                >
                  <svg class="watch-mark-read-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M16.704 5.29a1 1 0 010 1.42l-7.25 7.25a1 1 0 01-1.42 0l-3.25-3.25a1 1 0 111.42-1.42l2.54 2.54 6.54-6.54a1 1 0 011.42 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </li>
            </ul>
          </section>

          <section v-if="hasDiscussions" class="watch-section">
            <h4 class="watch-section-title">Discussions</h4>
            <ul class="watch-list">
              <li
                v-for="discussion in discussions"
                :key="`${discussion.wikiUri}::${discussion.noteSlug}`"
                class="watch-item"
                :class="{ 'watch-item-read': !isDiscussionUnread(discussion.wikiUri, discussion.noteSlug) }"
              >
                <RouterLink
                  :to="`${wikiPath(discussion.handle, discussion.wikiSlug)}/${discussion.noteSlug}`"
                  class="watch-link"
                  role="menuitem"
                  @click="onDiscussionClick(discussion.wikiUri, discussion.noteSlug)"
                >
                  <span
                    class="watch-dot"
                    :class="{ 'watch-dot-unread': isDiscussionUnread(discussion.wikiUri, discussion.noteSlug) }"
                    aria-hidden="true"
                  />
                  <span class="watch-copy">
                    <span class="watch-item-title">{{ discussion.noteTitle }}</span>
                    <span class="watch-meta muted">{{ discussionMeta(discussion) }}</span>
                  </span>
                </RouterLink>
                <button
                  v-if="isDiscussionUnread(discussion.wikiUri, discussion.noteSlug)"
                  type="button"
                  class="watch-mark-read"
                  title="Mark as read"
                  aria-label="Mark as read"
                  @click.stop="markDiscussionRead(discussion.wikiUri, discussion.noteSlug)"
                >
                  <svg class="watch-mark-read-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path
                      fill-rule="evenodd"
                      d="M16.704 5.29a1 1 0 010 1.42l-7.25 7.25a1 1 0 01-1.42 0l-3.25-3.25a1 1 0 111.42-1.42l2.54 2.54 6.54-6.54a1 1 0 011.42 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </button>
              </li>
            </ul>
          </section>
        </template>

        <footer class="notif-footer notif-footer-watching">
          <RouterLink to="/feed" class="notif-footer-link" @click="close">
            View all activity
          </RouterLink>
          <RouterLink to="/wikis" class="notif-footer-link" @click="close">
            Browse more wikis
          </RouterLink>
        </footer>
      </div>

      <div v-else-if="tab === 'requests'" role="tabpanel">
        <div v-if="!pendingRequestRows.length && !suggestionRows.length" class="notif-empty">
          <p class="notif-empty-text muted">
            No join requests or suggested edits waiting for your review.
          </p>
        </div>
        <ul v-if="pendingRequestRows.length" class="notif-list">
          <li v-for="row in pendingRequestRows" :key="`join-${row.wikiSlug}`" class="notif-item">
            <RouterLink
              v-if="auth.handle"
              :to="`/@${auth.handle}/${row.wikiSlug}/settings`"
              class="notif-link"
              role="menuitem"
              @click="close"
            >
              <span class="notif-dot notif-dot-unread" aria-hidden="true" />
              <span class="notif-copy">
                <span class="notif-headline">{{ row.count }} join request{{ row.count === 1 ? '' : 's' }}</span>
                <span class="notif-meta muted">{{ row.wikiName }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
        <ul v-if="suggestionRows.length" class="notif-list">
          <li v-for="row in suggestionRows" :key="`sugg-${row.wikiSlug}`" class="notif-item">
            <RouterLink
              v-if="auth.handle"
              :to="`/@${auth.handle}/${row.wikiSlug}/suggestions`"
              class="notif-link"
              role="menuitem"
              @click="close"
            >
              <span class="notif-dot notif-dot-unread" aria-hidden="true" />
              <span class="notif-copy">
                <span class="notif-headline">{{ row.count }} suggested edit{{ row.count === 1 ? '' : 's' }}</span>
                <span class="notif-meta muted">{{ row.wikiName }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <div v-else-if="tab === 'forum'" role="tabpanel">
        <div v-if="loading" class="notif-empty">
          <p class="notif-empty-text muted">Checking your threads…</p>
        </div>
        <div v-else-if="!forumRows.length" class="notif-empty">
          <p class="notif-empty-text muted">
            You haven't started any forum discussions yet — they live on Bluesky, and replies
            show up here.
          </p>
        </div>
        <ul v-else class="notif-list">
          <li v-for="row in forumRows" :key="row.rootPost" class="notif-item">
            <a :href="row.bskyUrl" target="_blank" rel="noopener noreferrer" class="notif-link" role="menuitem">
              <span
                class="notif-dot"
                :class="{ 'notif-dot-unread': row.replies > row.seen }"
                aria-hidden="true"
              />
              <span class="notif-copy">
                <span class="notif-headline">
                  {{ row.replies }} repl{{ row.replies === 1 ? 'y' : 'ies' }}
                  <template v-if="row.replies > row.seen">
                    ({{ row.replies - row.seen }} new)
                  </template>
                </span>
                <span class="notif-detail">{{ row.excerpt }}…</span>
                <span class="notif-meta muted">on Bluesky · @{{ row.author }}</span>
              </span>
            </a>
          </li>
        </ul>
        <footer v-if="forumRows.length" class="notif-footer">
          <button type="button" class="notif-footer-link" @click.stop="markAllForumRead">
            Mark all read
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notif {
  position: relative;
}

.notif-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 2px solid var(--pckt-border);
  border-radius: 50%;
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text-muted);
  cursor: pointer;
  box-shadow: var(--pckt-shadow-xs);
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    color 0.15s ease,
    box-shadow 0.15s ease;
}

.notif-trigger:hover,
.notif.open .notif-trigger {
  border-color: color-mix(in srgb, var(--pckt-green) 40%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-green) 6%, var(--pckt-bg-elevated));
  color: var(--pckt-text);
  box-shadow: var(--pckt-shadow);
}

.notif-icon {
  width: 16px;
  height: 16px;
}

.notif-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--pckt-green);
  color: #fff;
  font-family: var(--pckt-font-ui);
  font-size: 0.625rem;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
}

.notif.open {
  z-index: 60;
}

.notif-panel {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 60;
  width: min(22rem, calc(100vw - 2rem));
  overflow: hidden;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow-md);
  text-align: left;
}

.notif-strip {
  display: flex;
  gap: 3px;
  height: 4px;
  padding: 0 0.25rem;
  background: var(--pckt-bg-elevated);
}

.notif-strip-seg {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 1px;
}

.notif-strip-green {
  background: var(--pckt-green);
}

.notif-strip-blue {
  background: var(--pckt-blue);
}

.notif-strip-yellow {
  background: var(--pckt-yellow);
}

.notif-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  border-bottom: 1px solid var(--pckt-border);
}

.notif-tabs {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

.notif-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.6rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.notif-tab:hover {
  background: var(--pckt-bg-muted);
  color: var(--pckt-text);
}

.notif-tab.active {
  background: color-mix(in srgb, var(--pckt-green) 10%, transparent);
  color: var(--pckt-text);
}

.notif-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--pckt-green) 14%, transparent);
  color: var(--pckt-green-active);
  font-size: 0.625rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: none;
}

.notif-tab-count-watching {
  background: color-mix(in srgb, var(--pckt-yellow) 18%, transparent);
  color: color-mix(in srgb, var(--pckt-yellow) 70%, var(--pckt-text));
}

.notif-mark-all {
  flex-shrink: 0;
  margin-left: 0.25rem;
  padding: 0.3rem 0.55rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg);
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
  box-shadow: var(--pckt-shadow-xs);
  transition:
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.notif-mark-all:hover {
  border-color: color-mix(in srgb, var(--pckt-green) 35%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-green) 8%, var(--pckt-bg-elevated));
  color: var(--pckt-green-active);
  box-shadow: none;
}

.notif-empty {
  padding: 1.25rem 1rem;
}

.notif-empty-text {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.notif-list {
  list-style: none;
  margin: 0;
  padding: 0.375rem 0.375rem;
  max-height: 22rem;
  overflow-y: auto;
}

.notif-item {
  display: flex;
  align-items: flex-start;
  border-radius: var(--pckt-radius-sm);
  transition: background 0.15s ease;
}

.notif-item:hover {
  background: var(--pckt-bg-muted);
}

.notif-item-read .notif-headline,
.notif-item-read .notif-detail {
  color: var(--pckt-text-muted);
}

.notif-item-read .notif-headline {
  font-weight: 600;
}

.notif-link {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
  padding: 0.625rem 0.5rem 0.625rem 0.625rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.notif-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 0.35rem;
  border-radius: 50%;
  background: transparent;
}

.notif-dot-unread {
  background: var(--pckt-green);
}

.notif-copy {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.notif-headline {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 800;
  line-height: 1.3;
}

.notif-item:hover .notif-headline {
  color: var(--pckt-blue);
}

.notif-detail {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.35;
  color: var(--pckt-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notif-meta {
  font-size: 0.6875rem;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notif-mark-read {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0.5rem 0.375rem 0 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--pckt-text-subtle);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.notif-mark-read:hover {
  background: color-mix(in srgb, var(--pckt-green) 12%, transparent);
  color: var(--pckt-green-active);
}

.notif-mark-read-icon {
  width: 16px;
  height: 16px;
}

.notif-footer {
  padding: 0.5rem 0.75rem;
  border-top: 1px solid color-mix(in srgb, var(--pckt-border) 80%, transparent);
  text-align: center;
}

.notif-footer-watching {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem 1rem;
}

.notif-footer-link {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--pckt-text-muted);
  text-decoration: none;
  transition: color 0.15s ease;
}

.notif-footer-link:hover {
  color: var(--pckt-text);
  text-decoration: none;
}

.watch-section {
  padding: 0.375rem 0.375rem 0;
}

.watch-section + .watch-section {
  border-top: 1px solid color-mix(in srgb, var(--pckt-border) 80%, transparent);
  margin-top: 0.25rem;
  padding-top: 0.5rem;
}

.watch-section-title {
  margin: 0;
  padding: 0.25rem 0.625rem 0.375rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pckt-text-subtle);
}

.watch-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 14rem;
  overflow-y: auto;
}

.watch-item {
  display: flex;
  align-items: flex-start;
  border-radius: var(--pckt-radius-sm);
  transition: background 0.15s ease;
}

.watch-item-read .watch-item-title {
  font-weight: 600;
  color: var(--pckt-text-muted);
}

.watch-item:hover {
  background: var(--pckt-bg-muted);
}

.watch-link {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
  padding: 0.625rem 0.5rem 0.625rem 0.625rem;
  border-radius: var(--pckt-radius-sm);
  color: var(--pckt-text);
  font: inherit;
  text-align: left;
  text-decoration: none;
}

.watch-link:hover {
  text-decoration: none;
}

.watch-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-top: 0.35rem;
  border-radius: 50%;
}

.watch-dot-unread {
  background: var(--pckt-yellow);
}

.watch-mark-read {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0.5rem 0.375rem 0 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--pckt-text-subtle);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.watch-mark-read:hover {
  background: color-mix(in srgb, var(--pckt-yellow) 18%, transparent);
  color: color-mix(in srgb, var(--pckt-yellow) 70%, var(--pckt-text));
}

.watch-mark-read-icon {
  width: 16px;
  height: 16px;
}

.watch-copy {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.watch-item-title {
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 800;
  line-height: 1.3;
}

.watch-item:hover .watch-item-title {
  color: var(--pckt-blue);
}

.watch-meta {
  font-size: 0.75rem;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
