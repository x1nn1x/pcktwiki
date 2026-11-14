<script setup lang="ts">
import { appUrl } from '@/lib/base-url'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { LichenNoteWithContent } from '@/types/lichen'
import { useAuthStore } from '@/stores/auth'
import ForkWikiButton from '@/components/ForkWikiButton.vue'
import WikiQuickNav from '@/components/WikiQuickNav.vue'
import { blueskyShareUrl } from '@/composables/useShareMeta'
import {
  isTalkSlug,
  subjectSlugFromTalk,
  talkSlugFor,
} from '@/lib/lichen/content-meta'
import {
  isDiscussionWatched,
  isNoteWatched,
  isWikiWatched,
  unwatchDiscussion,
  unwatchNote,
  watchDiscussion,
  watchNote,
} from '@/lib/watchlist'
import {
  watchWikiWithBookmark,
  unwatchWikiWithBookmark,
} from '@/lib/lichen/bookmark-sync'
import { copyPermalink, noteAtUri } from '@/lib/atproto/permalinks'
import { isPinned, setPinned } from '@/lib/lichen/wiki-cache'
import { useOverlayDismiss } from '@/composables/useOverlayDismiss'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useWikiThemeMode } from '@/composables/useWikiThemeMode'
import { useLichenStore } from '@/stores/lichen'
import { downloadWikiExport } from '@/lib/export/wiki-bundle'
import WikiImportButton from '@/components/WikiImportButton.vue'

const props = defineProps<{
  note: LichenNoteWithContent
  ownerHandle: string
  wikiSlug: string
  wikiUri: string
  wikiName: string
  notes: LichenNoteWithContent[]
  canEdit: boolean
  canManage?: boolean
  isPublic: boolean
}>()

const router = useRouter()
const auth = useAuthStore()
const lichen = useLichenStore()
const { enter: enterEditMode } = useWikiEditMode()
const { active: themeModeActive, enter: enterThemeMode } = useWikiThemeMode()
const watched = ref(isWikiWatched(props.wikiUri))
const pinned = ref(false)
const exporting = ref(false)
/** Below 1100px the page sidebar is hidden, so this panel is the only nav. */
const quickNavOpen = ref(false)

onMounted(async () => {
  pinned.value = await isPinned(props.ownerHandle, props.wikiSlug)
})

// Anything you can currently read, you can fork — including private wikis you
// have access to and your own. The fork inherits the source's visibility.
const canFork = computed(() => auth.isAuthenticated)

const talkSlug = computed(() => talkSlugFor(props.note.slug))
const isTalkPage = computed(() => isTalkSlug(props.note.slug))
const hasTalkPage = computed(() => props.notes.some((n) => n.slug === talkSlug.value))
const activeDiscussionSlug = computed(() =>
  isTalkPage.value ? props.note.slug : talkSlug.value,
)
const discussionWatched = ref(
  isDiscussionWatched(props.wikiUri, activeDiscussionSlug.value),
)
const noteWatched = ref(isNoteWatched(props.wikiUri, props.note.slug))

// The toolbar stays mounted while navigating between pages, so these have to
// re-read when the note changes or they describe the previous page.
watch(
  () => [props.wikiUri, props.note.slug] as const,
  () => {
    noteWatched.value = isNoteWatched(props.wikiUri, props.note.slug)
    discussionWatched.value = isDiscussionWatched(props.wikiUri, activeDiscussionSlug.value)
  },
)
const shareUrl = computed(() =>
  typeof window !== 'undefined'
    ? appUrl(`/@${props.ownerHandle}/${props.wikiSlug}/${props.note.slug}`)
    : '',
)

function goRandom() {
  const pool = props.notes.filter(
    (n) => n.slug !== props.note.slug && n.slug !== 'home' && !n.slug.startsWith('talk:'),
  )
  if (pool.length === 0) return
  const pick = pool[Math.floor(Math.random() * pool.length)]
  router.push(`/@${props.ownerHandle}/${props.wikiSlug}/${pick.slug}`)
}

function shareBluesky() {
  if (!shareUrl.value) return
  const text = `${props.note.title} on @${props.ownerHandle}'s wiki`
  window.open(blueskyShareUrl(text, shareUrl.value), '_blank', 'noopener,noreferrer')
}

const menuRef = ref<HTMLElement | null>(null)
const menuOpen = ref(false)

/** Archive the current page: hides it at once; restore from Maintenance. */
async function archivePage() {
  const title = props.note.title
  const ok = window.confirm(
    `Archive "${title}"? It is hidden from the wiki immediately and can be restored or permanently deleted from the wiki's Maintenance page.`,
  )
  if (!ok) return
  try {
    await lichen.archiveNote(auth.agent!, props.note)
    closeMenu()
    router.push(`/@${props.ownerHandle}/${props.wikiSlug}`)
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Could not archive the page')
  }
}

function closeMenu() {
  menuOpen.value = false
}

useOverlayDismiss(menuRef, menuOpen, closeMenu)

async function toggleWatch() {
  if (watched.value) {
    await unwatchWikiWithBookmark(auth.agent, props.wikiUri)
    watched.value = false
  } else {
    await watchWikiWithBookmark(auth.agent, {
      wikiUri: props.wikiUri,
      handle: props.ownerHandle,
      wikiSlug: props.wikiSlug,
      wikiName: props.wikiName,
    })
    watched.value = true
  }
}

async function copyWebLink() {
  if (!shareUrl.value) return
  await copyPermalink(shareUrl.value)
  closeMenu()
}

async function copyAtLink() {
  await copyPermalink(noteAtUri(props.note.uri))
  closeMenu()
}

async function togglePin() {
  pinned.value = !pinned.value
  await setPinned(props.ownerHandle, props.wikiSlug, pinned.value)
}

async function exportWiki() {
  if (!lichen.currentWiki || exporting.value) return
  exporting.value = true
  try {
    await downloadWikiExport(lichen.currentWiki, lichen.notes, lichen.revisions, {
      ownerHandle: props.ownerHandle,
    })
  } finally {
    exporting.value = false
  }
}

function toggleDiscussionWatch() {
  const noteSlug = activeDiscussionSlug.value
  if (discussionWatched.value) {
    unwatchDiscussion(props.wikiUri, noteSlug)
    discussionWatched.value = false
    return
  }

  const subjectSlug = subjectSlugFromTalk(noteSlug) ?? props.note.slug
  const talkNote = props.notes.find((n) => n.slug === noteSlug)
  watchDiscussion({
    wikiUri: props.wikiUri,
    handle: props.ownerHandle,
    wikiSlug: props.wikiSlug,
    wikiName: props.wikiName,
    noteSlug,
    noteTitle: talkNote?.title ?? `Discussion: ${subjectSlug}`,
    subjectSlug,
  })
  discussionWatched.value = true
}

function toggleNoteWatch() {
  if (noteWatched.value) {
    unwatchNote(props.wikiUri, props.note.slug)
    noteWatched.value = false
    return
  }

  watchNote({
    wikiUri: props.wikiUri,
    handle: props.ownerHandle,
    wikiSlug: props.wikiSlug,
    wikiName: props.wikiName,
    noteSlug: props.note.slug,
    noteTitle: props.note.title,
  })
  noteWatched.value = true
}

function openDiscussion() {
  if (hasTalkPage.value) {
    void router.push(`/@${props.ownerHandle}/${props.wikiSlug}/${talkSlug.value}`)
  } else if (props.canEdit) {
    void router.push(`/@${props.ownerHandle}/${props.wikiSlug}/edit/${talkSlug.value}`)
  }
}

function focusToolbar() {
  const root = document.querySelector<HTMLElement>('.wiki-toolbar')
  const first = root?.querySelector<HTMLElement>('a[href], button:not([disabled])')
  first?.focus()
}

defineExpose({
  openDiscussion,
  toggleWatch,
  toggleDiscussionWatch,
  toggleNoteWatch,
  goRandom,
  shareBluesky,
  focusToolbar,
})
</script>

<template>
  <div class="wiki-toolbar" data-kb-toolbar>
    <div class="wiki-toolbar-search">
      <button
        type="button"
        class="btn btn-ghost btn-sm quick-nav-trigger"
        aria-label="Search and navigate this wiki"
        :aria-expanded="quickNavOpen"
        @click="quickNavOpen = true"
      >
        <svg class="quick-nav-trigger-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M16.5 16.5 21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        Search
      </button>
    </div>

    <WikiQuickNav
      :open="quickNavOpen"
      :note="note"
      :notes="notes"
      :owner-handle="ownerHandle"
      :wiki-slug="wikiSlug"
      :sidebar-order="lichen.currentWiki?.sidebarOrder"
      @close="quickNavOpen = false"
    />

    <div class="wiki-toolbar-actions">
      <button
        v-if="canEdit"
        type="button"
        class="btn btn-ghost btn-sm"
        title="Edit this page"
        @click="enterEditMode"
      >
        Edit
      </button>
      <button
        v-if="canManage"
        type="button"
        class="btn btn-ghost btn-sm"
        :aria-pressed="themeModeActive"
        title="Recolor wiki layout regions"
        @click="enterThemeMode"
      >
        Theme
      </button>
      <button
        v-if="canManage"
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="exporting"
        title="Download a zip with markdown notes and a browsable HTML/CSS site"
        @click="exportWiki"
      >
        {{ exporting ? 'Exporting…' : 'Export' }}
      </button>
      <WikiImportButton v-if="canManage" />
      <RouterLink
        v-if="canManage"
        :to="`/@${ownerHandle}/${wikiSlug}/settings`"
        class="btn btn-ghost btn-sm"
      >
        Settings
      </RouterLink>

      <div ref="menuRef" class="tools-menu-wrap" :class="{ open: menuOpen }">
        <button
          type="button"
          class="btn btn-ghost btn-sm tools-trigger"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          Tools
          <span class="tools-caret" aria-hidden="true">▾</span>
        </button>
        <div v-if="menuOpen" class="tools-menu" role="menu">
          <button
            v-if="canEdit"
            type="button"
            class="tools-item"
            role="menuitem"
            title="Hide this page immediately — restore from Maintenance"
            @click="archivePage"
          >
            Archive page
          </button>
          <RouterLink
            v-if="canEdit"
            :to="`/@${ownerHandle}/${wikiSlug}/edit/${note.slug}`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Open full editor
          </RouterLink>
          <RouterLink
            v-if="canEdit"
            :to="`/@${ownerHandle}/${wikiSlug}/special/rename?from=${encodeURIComponent(note.slug)}`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Rename…
          </RouterLink>
          <RouterLink
            :to="`/@${ownerHandle}/${wikiSlug}/${note.slug}/history`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            History
          </RouterLink>
          <RouterLink
            v-if="canManage"
            :to="`/@${ownerHandle}/${wikiSlug}/suggestions`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Suggested edits
          </RouterLink>
          <RouterLink
            v-if="canEdit"
            :to="`/@${ownerHandle}/${wikiSlug}/versions`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Versions
          </RouterLink>
          <RouterLink
            v-if="hasTalkPage"
            :to="`/@${ownerHandle}/${wikiSlug}/${talkSlug}`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Discussion
          </RouterLink>
          <RouterLink
            v-else-if="canEdit"
            :to="`/@${ownerHandle}/${wikiSlug}/edit/${talkSlug}`"
            class="tools-item"
            role="menuitem"
            @click="closeMenu"
          >
            Start discussion
          </RouterLink>

          <div class="tools-sep" role="separator" />

          <button type="button" class="tools-item" role="menuitem" @click="goRandom(); closeMenu()">
            Random article
          </button>
          <button type="button" class="tools-item" role="menuitem" @click="toggleWatch">
            {{ watched ? 'Watching wiki' : 'Watch wiki' }}
          </button>
          <button
            v-if="!isTalkPage"
            type="button"
            class="tools-item"
            role="menuitem"
            @click="toggleNoteWatch"
          >
            {{ noteWatched ? 'Watching this article' : 'Watch this article' }}
          </button>
          <button type="button" class="tools-item" role="menuitem" @click="togglePin">
            {{ pinned ? 'Pinned offline' : 'Pin offline' }}
          </button>
          <button
            v-if="canManage"
            type="button"
            class="tools-item"
            role="menuitem"
            :disabled="exporting"
            @click="exportWiki(); closeMenu()"
          >
            {{ exporting ? 'Exporting…' : 'Export wiki zip' }}
          </button>
          <button
            v-if="isTalkPage || hasTalkPage"
            type="button"
            class="tools-item"
            role="menuitem"
            @click="toggleDiscussionWatch"
          >
            {{ discussionWatched ? 'Watching discussion' : 'Watch discussion' }}
          </button>

          <template v-if="isPublic">
            <div class="tools-sep" role="separator" />
            <button type="button" class="tools-item" role="menuitem" @click="copyWebLink">
              Copy web link
            </button>
            <button type="button" class="tools-item" role="menuitem" @click="copyAtLink">
              Copy AT-URI
            </button>
            <button type="button" class="tools-item" role="menuitem" @click="shareBluesky(); closeMenu()">
              Share to Bluesky
            </button>
          </template>

          <template v-if="canFork">
            <div class="tools-sep" role="separator" />
            <ForkWikiButton
              :source-name="wikiName"
              :source-handle="ownerHandle"
              :source-slug="wikiSlug"
              :source-wiki-uri="wikiUri"
              :source-is-public="isPublic"
              :is-own-wiki="canEdit"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quick-nav-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.quick-nav-trigger-icon {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}

.wiki-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

.wiki-toolbar-search {
  display: none;
  margin-right: auto;
  min-width: 0;
}

.wiki-toolbar-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}

@media (max-width: 1100px) {
  .wiki-toolbar-search {
    display: block;
  }
}

.tools-menu-wrap {
  position: relative;
}

.tools-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.tools-caret {
  font-size: 0.75em;
  transition: transform 0.15s ease;
}

.tools-menu-wrap.open .tools-caret {
  transform: rotate(180deg);
}

.tools-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 12rem;
  padding: 0.25rem;
  margin-top: 0.35rem;
  background: var(--pckt-bg-elevated);
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  box-shadow: var(--pckt-shadow-md);
}

.tools-item,
.tools-menu :deep(.btn) {
  display: block;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: none;
  color: var(--pckt-text);
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  font: inherit;
  font-size: 0.875rem;
}

.tools-item:hover,
.tools-item:focus-visible,
.tools-menu :deep(.btn:hover),
.tools-menu :deep(.btn:focus-visible) {
  background: var(--pckt-bg-muted);
  color: var(--pckt-text);
}

.tools-sep {
  height: 1px;
  margin: 0.25rem 0.25rem;
  background: var(--pckt-border);
}
</style>
