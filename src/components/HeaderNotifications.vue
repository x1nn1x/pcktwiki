<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { wikiPath } from '@/data/featured-wikis'
import { subjectSlugFromTalk } from '@/lib/lichen/content-meta'
import { useMenuDismissGroup } from '@/composables/useMenuDismissGroup'
import { useOverlayDismiss } from '@/composables/useOverlayDismiss'
import { useUnifiedNotifications } from '@/composables/useUnifiedNotifications'
import { useWatchlist } from '@/composables/useWatchlist'
import { formatNotificationTime } from '@/lib/notifications'
import type {
  NotificationFilter,
  UnifiedNotification,
} from '@/lib/notifications-unified'
import type { DiscussionWatchEntry } from '@/lib/watchlist'

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const gearOpen = ref(false)
const router = useRouter()

const {
  filteredRows,
  loading,
  filter,
  unreadCount,
  unreadByFilter,
  followBackDone,
  followBackPending,
  showReadingList,
  load,
  markAllRead,
  followBack,
  openRow,
} = useUnifiedNotifications(router)


const {
  wikis,
  discussions,
  notes,
  hasWikis,
  hasDiscussions,
  hasNotes,
  hasAny,
  sync: syncWatchlist,
  markWikiRead,
  markDiscussionRead,
  markNoteRead,
  isWikiUnread,
  isDiscussionUnread,
  isNoteUnread,
} = useWatchlist()

const FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'following', label: 'People I follow' },
  { id: 'replies', label: 'Replies' },
  { id: 'follows', label: 'Follows' },
  { id: 'alerts', label: 'Post alerts' },
]

const totalUnreadCount = unreadCount

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

function setFilter(next: NotificationFilter) {
  filter.value = next
  showReadingList.value = false
}

function toggleGear(event: Event) {
  event.stopPropagation()
  gearOpen.value = !gearOpen.value
}

function openReadingList() {
  showReadingList.value = true
  gearOpen.value = false
  void syncWatchlist()
}

function onMarkAllRead() {
  void markAllRead()
  gearOpen.value = false
}

function rowTime(row: UnifiedNotification): string {
  return row.createdAt ? formatNotificationTime(row.createdAt) : ''
}

function rowMeta(row: UnifiedNotification): string {
  const time = rowTime(row)
  return [row.meta, time].filter(Boolean).join(' · ')
}

function onRowClick(row: UnifiedNotification) {
  close()
  openRow(row)
}

function onFollowBack(did: string) {
  void followBack(did)
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

watch(open, async (isOpen) => {
  if (!isOpen) {
    gearOpen.value = false
    return
  }
  void load()
  void syncWatchlist()
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
        <div class="notif-title-row">
          <h3 class="notif-title">Notifications</h3>
          <div class="notif-title-actions">
            <button
              type="button"
              class="notif-gear"
              aria-label="Notification options"
              :aria-expanded="gearOpen"
              @click.stop="toggleGear"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="notif-gear-icon">
                <path
                  fill-rule="evenodd"
                  d="M10 6.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM8.1 2.6a1 1 0 01.98-.8h1.84a1 1 0 01.98.8l.24 1.2c.42.16.81.38 1.16.65l1.16-.4a1 1 0 011.18.45l.92 1.6a1 1 0 01-.2 1.24l-.93.8a5.6 5.6 0 010 1.72l.93.8a1 1 0 01.2 1.25l-.92 1.59a1 1 0 01-1.18.45l-1.16-.4c-.35.27-.74.5-1.16.65l-.24 1.2a1 1 0 01-.98.8H9.08a1 1 0 01-.98-.8l-.24-1.2a5.06 5.06 0 01-1.16-.65l-1.16.4a1 1 0 01-1.18-.45l-.92-1.6a1 1 0 01.2-1.24l.93-.8a5.6 5.6 0 010-1.72l-.93-.8a1 1 0 01-.2-1.25l.92-1.59a1 1 0 011.18-.45l1.16.4c.35-.27.74-.5 1.16-.65l.24-1.2z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
            <div v-if="gearOpen" class="notif-gear-menu" role="menu">
              <button type="button" role="menuitem" class="notif-gear-item" @click.stop="openReadingList">
                Reading list
              </button>
              <button type="button" role="menuitem" class="notif-gear-item" @click.stop="onMarkAllRead">
                Mark all read
              </button>
            </div>
          </div>
        </div>

        <div v-if="!showReadingList" class="notif-chips" role="tablist" aria-label="Notification filters">
          <button
            v-for="item in FILTERS"
            :key="item.id"
            type="button"
            class="notif-chip"
            role="tab"
            :class="{ active: filter === item.id && !showReadingList }"
            :aria-selected="filter === item.id && !showReadingList"
            @click.stop="setFilter(item.id)"
          >
            {{ item.label }}
            <span v-if="unreadByFilter[item.id]" class="notif-chip-count">{{
              unreadByFilter[item.id]
            }}</span>
          </button>
        </div>
        <div v-else class="notif-chips" role="tablist" aria-label="Notification views">
          <button type="button" class="notif-chip" role="tab" @click.stop="showReadingList = false">
            ← Back to notifications
          </button>
        </div>
      </header>

      <!-- Reading list (the former Watching view) -->
      <div v-if="showReadingList" role="tabpanel" class="notif-reading">
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

      <!-- Unified stacked feed -->
      <div v-else role="tabpanel">
        <div v-if="loading && !filteredRows.length" class="notif-empty">
          <p class="notif-empty-text muted">Loading notifications…</p>
        </div>

        <div v-else-if="!filteredRows.length" class="notif-empty">
          <p class="notif-empty-text muted">
            {{ filter === 'all' ? 'No notifications yet.' : `Nothing in ${filter}.` }}
          </p>
        </div>

        <ul v-else class="notif-stack">
          <li
            v-for="row in filteredRows.slice(0, 30)"
            :key="row.id"
            class="notif-row"
            :class="{ 'notif-row-read': row.read }"
          >
            <button type="button" class="notif-row-link" role="menuitem" @click="onRowClick(row)">
              <span class="notif-row-avatars" aria-hidden="true">
                <template v-if="row.actors.length">
                  <img
                    v-for="(actor, index) in row.actors.slice(0, 3)"
                    :key="actor.did + index"
                    class="notif-avatar"
                    :class="{ 'notif-avatar-sm': index > 0 }"
                    :src="actor.avatar"
                    :alt="''"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                  <span
                    v-if="row.additionalCount"
                    class="notif-avatar-more"
                  >+{{ row.additionalCount }}</span>
                  <span v-if="row.kind === 'follow'" class="notif-kind-icon notif-kind-follow" />
                  <span
                    v-else-if="row.kind === 'repost' || row.kind === 'like' || row.kind === 'quote'"
                    class="notif-kind-icon notif-kind-engage"
                  />
                  <span v-else-if="row.kind === 'post-alert'" class="notif-kind-icon notif-kind-alert" />
                </template>
                <span v-else class="notif-kind-badge" :class="`notif-kind-badge--${row.source}`">
                  {{ row.source === 'wiki' ? '⒲' : row.source === 'forum' ? '💬' : 'Ⓜ' }}
                </span>
              </span>

              <span class="notif-row-copy">
                <span class="notif-row-headline">{{ row.headline }}</span>
                <span v-if="row.detail" class="notif-row-detail">{{ row.detail }}</span>
                <span v-if="rowMeta(row)" class="notif-row-meta muted">{{ rowMeta(row) }}</span>
                <span
                  v-if="row.viewAllHref"
                  class="notif-row-viewall"
                  @click.stop.prevent="onRowClick(row)"
                >View all →</span>
              </span>

              <span v-if="row.thumbnail" class="notif-row-thumb" aria-hidden="true">
                <img :src="row.thumbnail" alt="" loading="lazy" referrerpolicy="no-referrer" />
              </span>
              <span v-else-if="row.kind === 'follow'" class="notif-row-action">
                <button
                  v-for="did in row.followBackDids?.slice(0, 1) ?? []"
                  :key="did"
                  type="button"
                  class="notif-follow-back"
                  :disabled="
                    followBackDone.has(did) || followBackPending.has(did)
                  "
                  @click.stop.prevent="onFollowBack(did)"
                >
                  {{ followBackDone.has(did) ? 'Following ✓' : 'Follow back' }}
                </button>
              </span>
            </button>
          </li>
        </ul>

        <footer class="notif-footer">
          <RouterLink to="/wikis" class="notif-footer-link" @click="close">
            Browse more wikis
          </RouterLink>
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

/* Panel */
.notif-panel {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 60;
  width: min(440px, calc(100vw - 20px));
  max-height: min(70vh, 620px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-lg, 14px);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.18));
  overflow: hidden;
}

.notif-strip {
  display: flex;
  height: 3px;
  flex: none;
}

.notif-strip-seg {
  flex: 1;
}

.notif-strip-green { background: var(--pckt-green); }
.notif-strip-blue { background: var(--pckt-blue); }
.notif-strip-yellow { background: var(--pckt-yellow); }

.notif-header {
  flex: none;
  padding: 0.75rem 0.875rem 0.5rem;
  border-bottom: 1px solid var(--pckt-border);
}

.notif-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.notif-title {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 1rem;
  font-weight: 800;
}

.notif-title-actions {
  position: relative;
}

.notif-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--pckt-text-muted);
  cursor: pointer;
}

.notif-gear:hover {
  background: var(--pckt-bg-muted);
  color: var(--pckt-text);
}

.notif-gear-icon {
  width: 16px;
  height: 16px;
}

.notif-gear-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 5;
  min-width: 10rem;
  padding: 0.25rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow);
}

.notif-gear-item {
  display: block;
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.notif-gear-item:hover {
  background: var(--pckt-bg-muted);
}

/* Filter chips */
.notif-chips {
  display: flex;
  gap: 0.375rem;
  margin-top: 0.625rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 0.25rem;
}

.notif-chips::-webkit-scrollbar {
  display: none;
}

.notif-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.32rem 0.7rem;
  border: 1px solid var(--pckt-border);
  border-radius: 999px;
  background: transparent;
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.notif-chip:hover {
  background: var(--pckt-bg-muted);
}

.notif-chip.active {
  background: var(--pckt-text);
  border-color: var(--pckt-text);
  color: var(--pckt-bg-elevated);
}

.notif-chip-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.05rem;
  height: 1.05rem;
  padding: 0 0.28rem;
  border-radius: 999px;
  background: var(--pckt-green);
  color: #fff;
  font-size: 0.625rem;
  font-weight: 800;
}

/* Stacked rows */
.notif-stack {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.notif-row {
  border-bottom: 1px solid var(--pckt-border);
}

.notif-row:last-child {
  border-bottom: none;
}

.notif-row-link {
  display: flex;
  gap: 0.65rem;
  width: 100%;
  padding: 0.7rem 0.875rem;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  align-items: flex-start;
}

.notif-row-link:hover {
  background: var(--pckt-bg-muted);
}

.notif-row-read {
  opacity: 0.62;
}

.notif-row-avatars {
  position: relative;
  display: flex;
  align-items: center;
  flex: none;
  padding-top: 2px;
}

.notif-avatar {
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  border: 2px solid var(--pckt-bg-elevated);
  background: var(--pckt-bg-muted);
  object-fit: cover;
}

.notif-avatar + .notif-avatar {
  margin-left: -0.55rem;
}

.notif-avatar-sm {
  width: 1.7rem;
  height: 1.7rem;
}

.notif-avatar-more {
  margin-left: 0.3rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--pckt-text-muted);
}

.notif-kind-icon {
  position: absolute;
  left: -4px;
  bottom: -3px;
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 50%;
  border: 2px solid var(--pckt-bg-elevated);
}

.notif-kind-follow {
  background: var(--pckt-blue);
}

.notif-kind-engage {
  background: var(--pckt-pink, var(--pckt-red));
}

.notif-kind-alert {
  background: var(--pckt-yellow);
}

.notif-kind-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  background: var(--pckt-bg-muted);
  font-size: 0.95rem;
}

.notif-row-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.notif-row-headline {
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--pckt-text);
}

.notif-row-detail {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  color: var(--pckt-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notif-row-meta {
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
}

.notif-row-viewall {
  display: inline-block;
  margin-top: 0.15rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--pckt-blue);
  cursor: pointer;
}

.notif-row-thumb {
  flex: none;
  width: 2.9rem;
  height: 2.9rem;
  border-radius: var(--pckt-radius-sm);
  overflow: hidden;
  border: 1px solid var(--pckt-border);
}

.notif-row-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.notif-row-action {
  flex: none;
  align-self: center;
}

.notif-follow-back {
  padding: 0.32rem 0.65rem;
  border: 1px solid color-mix(in srgb, var(--pckt-blue) 55%, var(--pckt-border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--pckt-blue) 8%, var(--pckt-bg-elevated));
  color: var(--pckt-blue-active, var(--pckt-blue));
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.notif-follow-back:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pckt-blue) 16%, var(--pckt-bg-elevated));
}

.notif-follow-back:disabled {
  opacity: 0.55;
  cursor: default;
}

/* Reading list (Watching view) — kept from the previous panel */
.notif-reading {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0.875rem 0.75rem;
}

.watch-section {
  margin: 0 0 1rem;
}

.watch-section-title {
  margin: 0 0 0.4rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pckt-text-muted);
}

.watch-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.watch-item {
  border-radius: var(--pckt-radius-sm);
}

.watch-item-read {
  opacity: 0.6;
}

.watch-link {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.35rem;
  color: inherit;
  text-decoration: none;
}

.watch-link:hover {
  background: var(--pckt-bg-muted);
}

.watch-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 0.4rem;
  border-radius: 50%;
  background: var(--pckt-border);
}

.watch-dot-unread {
  background: var(--pckt-green);
}

.watch-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.watch-item-title {
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
}

.watch-meta {
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
}

.notif-empty {
  padding: 1.75rem 1rem;
  text-align: center;
}

.notif-empty-text {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
}

.notif-footer {
  flex: none;
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0.875rem;
  border-top: 1px solid var(--pckt-border);
}

.notif-footer-watching {
  border-top: 1px solid var(--pckt-border);
}

.notif-footer-link {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--pckt-blue);
  text-decoration: none;
}

.notif-footer-link:hover {
  text-decoration: underline;
}

@media (max-width: 560px) {
  .notif-panel {
    position: fixed;
    top: auto;
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    max-height: 76vh;
  }

  .notif-row-link {
    padding: 0.65rem 0.7rem;
  }
}
</style>
