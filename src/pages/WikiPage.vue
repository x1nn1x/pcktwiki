<script setup lang="ts">
import { appUrl } from '@/lib/base-url'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { canManage } from '@/lib/lichen/collections'
import { applyWikiTheme, loadLocalTheme, resetAppTheme, themeFromWiki, wikiHasCustomTheme } from '@/lib/theme'
import { normalizeHandle } from '@/lib/config'
import { normalizeArticleSlug } from '@/lib/atproto/lichen'
import { computeWikiCategories } from '@/lib/lichen/categories'
import { listRecentChanges } from '@/lib/lichen/recent-changes'
import { useShareMeta } from '@/composables/useShareMeta'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useWikiThemeMode } from '@/composables/useWikiThemeMode'
import { useMapProgress } from '@/composables/useMapProgress'
import { parseNoteContent } from '@/lib/lichen/content-meta'
import { extractTocFromMarkdown } from '@/lib/toc'
import { isCanonUnlocked } from '@/lib/lichen/map-fog'
import WikiHero from '@/components/WikiHero.vue'
import WikiHeaderLinks from '@/components/WikiHeaderLinks.vue'
import WikiNav from '@/components/WikiNav.vue'
import TableOfContents from '@/components/TableOfContents.vue'
import NoteContent from '@/components/NoteContent.vue'
import WikiPortal from '@/components/WikiPortal.vue'
import WikiToolbar from '@/components/WikiToolbar.vue'
import WikiThemeRegionOverlay from '@/components/WikiThemeRegionOverlay.vue'
import WikiSearch from '@/components/WikiSearch.vue'
import BlogSyncPanel from '@/components/BlogSyncPanel.vue'
import ForkSyncPanel from '@/components/ForkSyncPanel.vue'
import ForksOfWikiPanel from '@/components/ForksOfWikiPanel.vue'
import JoinRequestBanner from '@/components/JoinRequestBanner.vue'
import PhotoSubmitCard from '@/components/PhotoSubmitCard.vue'
import WikiDock from '@/components/WikiDock.vue'
import WikisLikeThis from '@/components/WikisLikeThis.vue'
import RateLimitSignInHint from '@/components/RateLimitSignInHint.vue'
import { resolveBlobDisplayUrl } from '@/lib/atproto/blobs'
import { getPublicAgent } from '@/lib/atproto/auth'
import {
  getDockButton,
  listDockItems,
  resolveDockButtonArt,
} from '@/lib/pckt-records'
import type { DockLink } from '@/lib/wiki-dock'
import WikiEditable from '@/components/WikiEditable.vue'
import WikiInlineNoteEditor from '@/components/WikiInlineNoteEditor.vue'
import { isRateLimitUserMessage } from '@/lib/http-retry'
import { useKeyboardNav } from '@/composables/useKeyboardNavProvider'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const lichen = useLichenStore()
const {
  openTarget,
  createSlug,
  exit: exitEditMode,
  openCreate,
  closeModal,
} = useWikiEditMode()
const { active: themeModeActive, discard: discardTheme } = useWikiThemeMode()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const noteSlug = computed(() => route.params.noteSlug as string | undefined)

const ownerDid = ref<string | null>(null)
const creatingStubs = ref(false)

const wikiScope = computed(() => `${handle.value}/${wikiSlug.value}`)

function applyWikiRedirect() {
  const slug = noteSlug.value ?? 'home'
  const resolved = lichen.getResolvedNote(slug)
  if (resolved && resolved.slug !== slug) {
    router.replace(`/@${handle.value}/${wikiSlug.value}/${resolved.slug}`)
  }
}

async function loadWikiData() {
  const did = await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  if (!did) return

  ownerDid.value = did

  if (auth.agent) {
    await lichen.processOfflineQueue(auth.agent)
  }

  const wiki = lichen.currentWiki
  if (wiki && wikiHasCustomTheme(wiki)) {
    // Fall back to the viewer's own preference for anything the wiki leaves unset.
    // Explicit light/dark from the viewer wins over a wiki-forced theme.
    const local = loadLocalTheme()
    const localMode = local.mode ?? 'auto'
    const fromWiki = themeFromWiki(wiki)
    applyWikiTheme({
      ...local,
      ...fromWiki,
      mode: localMode === 'auto' ? (fromWiki.mode ?? localMode) : localMode,
    })
  } else {
    resetAppTheme()
  }
}

function isSameWikiLoaded(): boolean {
  return (
    lichen.activeWikiScope === wikiScope.value &&
    lichen.currentWiki?.slug === wikiSlug.value
  )
}

async function onRouteChange() {
  if (!isSameWikiLoaded()) {
    await loadWikiData()
    if (!lichen.currentWiki) return
  }

  applyWikiRedirect()
}

watch(
  () => [route.params.handle, route.params.wikiSlug, route.params.noteSlug] as const,
  onRouteChange,
  { immediate: true },
)

const requestedSlug = computed(() => noteSlug.value ?? 'home')

async function startCreatePage() {
  const normalized = normalizeArticleSlug(requestedSlug.value)
  if (!normalized) return
  if (normalized !== requestedSlug.value) {
    await router.replace(`/@${handle.value}/${wikiSlug.value}/${normalized}`)
  }
  openCreate(normalized)
}

const currentNote = computed(() => {
  const slug = requestedSlug.value
  // Touch notes so this recomputes when pages are created/updated in the store.
  void lichen.notes.length
  return lichen.getResolvedNote(slug) ?? lichen.getNoteBySlug(slug) ?? null
})

/** Per-article section list shown in the sidebar, adapting to the open page. */
const noteToc = computed(() => {
  if (!currentNote.value) return []
  const body = parseNoteContent(currentNote.value.content).body
  return extractTocFromMarkdown(body)
})

/** Forks are a property of the wiki, so they belong on its front page only. */
const isWikiHome = computed(() => currentNote.value?.slug === 'home')

const noteNotFound = computed(
  () =>
    !lichen.loading &&
    !!lichen.currentWiki &&
    !lichen.error &&
    !currentNote.value,
)

const activeSlug = computed(() => currentNote.value?.slug)

/**
 * Reading a place's page is what discovers it on the world map. Unreleased
 * places are skipped: canon has to open before a visit can count, otherwise
 * anyone who found a staged page early would carry the reveal past its release.
 */
const { discover: discoverMapPlace } = useMapProgress({
  wikiUri: computed(() => lichen.currentWiki?.uri ?? null),
  agent: computed(() => auth.agent ?? null),
})

watch(
  currentNote,
  (note) => {
    if (!note) return
    const meta = parseNoteContent(note.content)
    if (meta.mapX == null || meta.mapY == null) return
    if (!isCanonUnlocked(meta)) return
    discoverMapPlace(note.slug)
  },
  { immediate: true },
)

/**
 * Collaboration capabilities for the open page: the wiki-wide picture layered
 * with the viewer's per-article grant, if one exists. "Can edit" here spans
 * publishing (owner) and proposing (everyone else) — the editor page sorts
 * out which one applies.
 */
const noteCaps = computed(() =>
  lichen.currentWiki ? lichen.capabilitiesForNote(requestedSlug.value) : lichen.capabilities,
)
const canEditWiki = computed(() => noteCaps.value.canPublish || noteCaps.value.canSuggest)
const canPublishWiki = computed(() => noteCaps.value.canPublish)
const canManageWiki = computed(() => canManage(lichen.access))

/**
 * The OS-style bottom dock mirrors the wiki's own editable navbar links — the
 * same list the site topbar renders, from the live wiki record or the public
 * cache while metadata is still loading — plus shared buttons other creators
 * have linked to this wiki. Bubble art resolves from blob refs where present.
 */
const dockLinks = ref<DockLink[]>([])
let dockLoadSeq = 0

watch(
  () => [lichen.currentWiki?.uri, lichen.currentWiki?.ownerDid, lichen.currentWiki?.navbarLinks, ownerDid.value] as const,
  async ([wikiUri, wikiOwnerDid, navbarLinks]) => {
    const seq = ++dockLoadSeq
    if (!wikiUri || !wikiOwnerDid) {
      dockLinks.value = []
      return
    }

    const links: DockLink[] = (navbarLinks ?? []).map((link) => ({
      label: link.label,
      url: link.url ?? '',
    }))
    // Static rows render instantly; shared buttons fill in async.
    dockLinks.value = links

    void (async () => {
      try {
        const items = await listDockItems(wikiOwnerDid)
        const agent = auth.agent ?? getPublicAgent()
        const extra: DockLink[] = []
        for (const item of items) {
          if (item.wikiRef !== wikiUri) continue
          if (item.buttonRef) {
            // Linked shape — label and art stay live from the creator's repo.
            const button = await getDockButton(agent, item.buttonRef)
            if (!button) continue
            const resolved = await resolveDockButtonArt(button)
            extra.push({
              label: resolved.label,
              url: resolved.href,
              artUrl: resolved.artUrl ?? undefined,
            })
          } else if (item.label && item.href) {
            // Forked shape — a self-contained copy this wiki owns.
            const artUrl = item.art
              ? await resolveBlobDisplayUrl(wikiOwnerDid, item.art).catch(() => null)
              : null
            extra.push({ label: item.label, url: item.href, artUrl: artUrl ?? undefined })
          }
        }
        if (seq === dockLoadSeq && extra.length) {
          dockLinks.value = [...dockLinks.value, ...extra]
        }
      } catch {
        // shared buttons are additive; failures leave the dock as-is
      }
    })()
  },
  { immediate: true },
)
const showRateLimitSignInHint = computed(
  () => !auth.isAuthenticated && isRateLimitUserMessage(lichen.error),
)

const categories = computed(() => computeWikiCategories(lichen.notes))
/** Sidebar teaser — the “All recent changes” page shows the fuller list. */
const recentChanges = computed(() => listRecentChanges(lichen.revisions, lichen.notes, 4))
const blogSuggestions = computed(() => lichen.getBlogStubSuggestions())

const shareTitle = computed(() => {
  if (!lichen.currentWiki || !currentNote.value) return 'pckt.wiki'
  return `${currentNote.value.title} · ${lichen.currentWiki.name}`
})

const shareDescription = computed(() => {
  if (!lichen.currentWiki) return 'Your personal wiki on the open social web.'
  return lichen.currentWiki.description ?? `@${handle.value}'s wiki on pckt.wiki`
})

const shareUrl = computed(() => {
  if (!currentNote.value || typeof window === 'undefined') return ''
  return appUrl(`/@${handle.value}/${wikiSlug.value}/${currentNote.value.slug}`)
})

const referenceSubjects = computed(() => {
  const subjects: string[] = []
  if (currentNote.value?.uri) subjects.push(currentNote.value.uri)
  if (lichen.currentWiki?.uri) subjects.push(lichen.currentWiki.uri)
  if (shareUrl.value) subjects.push(shareUrl.value)
  return subjects
})

useShareMeta({
  title: shareTitle,
  description: shareDescription,
  url: shareUrl,
})

async function createAllStubs() {
  if (!auth.agent) return
  creatingStubs.value = true
  try {
    await lichen.createAllBlogStubs(auth.agent)
  } finally {
    creatingStubs.value = false
  }
}

// Remix — fork this wiki into the viewer's account (surfaced on the home page
// for non-owners; the browse directory cards use the same helper).
const remixing = ref(false)
const remixError = ref('')
async function remixThisWiki() {
  if (!auth.agent) {
    router.push({ name: 'home', query: { redirect: route.fullPath } })
    return
  }
  remixing.value = true
  remixError.value = ''
  try {
    const { remixWiki } = await import('@/lib/lichen/fork-wiki')
    const wiki = await remixWiki(auth.agent, handle.value, wikiSlug.value, {
      forkHandle: auth.handle ?? '',
    })
    await router.push(`/@${auth.handle}/${wiki.slug}`)
  } catch (err) {
    remixError.value = err instanceof Error ? err.message : 'Could not remix this wiki'
  } finally {
    remixing.value = false
  }
}

async function createOneStub(suggestion: typeof blogSuggestions.value[number]) {
  if (!auth.agent) return
  creatingStubs.value = true
  try {
    await lichen.createBlogStub(auth.agent, suggestion)
  } finally {
    creatingStubs.value = false
  }
}

async function saveTalkContent(content: string) {
  if (!auth.agent || !currentNote.value) return
  await lichen.queueOrSaveNoteEdit(
    auth.agent,
    currentNote.value,
    currentNote.value.title,
    content,
    'Talk comment',
    handle.value,
    wikiSlug.value,
  )
}

const toolbarRef = ref<InstanceType<typeof WikiToolbar> | null>(null)
const nav = useKeyboardNav()

function handleWikiShortcut(key: string, e: KeyboardEvent): boolean {
  if (!currentNote.value) return false

  if (e.code === 'Space') {
    toolbarRef.value?.toggleWatch()
    return true
  }

  switch (key) {
    case 'r':
      toolbarRef.value?.openDiscussion()
      return true
    case 'c':
      toolbarRef.value?.toggleWatch()
      return true
    case 'f':
      window.open(`https://bsky.app/profile/${encodeURIComponent(handle.value)}`, '_blank', 'noopener,noreferrer')
      return true
    case 'm':
    case '`':
      toolbarRef.value?.focusToolbar()
      return true
    default:
      return false
  }
}

onMounted(() => nav.setPageShortcutHandler(handleWikiShortcut))
onUnmounted(() => {
  nav.setPageShortcutHandler(null)
  exitEditMode()
  if (themeModeActive.value) discardTheme()
})
</script>

<template>
  <div class="wiki-view wiki-view--has-dock">
    <WikiThemeRegionOverlay v-if="themeModeActive && canManageWiki" />
    <div
      class="wiki-layout"
      :class="{ 'has-sidebars': lichen.notes.length > 0 }"
    >
      <aside
        v-if="lichen.notes.length"
        class="wiki-sidebar wiki-sidebar-start"
        data-kb-section
        aria-label="Wiki sidebar"
      >
        <WikiSearch
          :notes="lichen.notes"
          :owner-handle="handle"
          :wiki-slug="wikiSlug"
        />
        <WikiNav
          :notes="lichen.notes"
          :owner-handle="handle"
          :wiki-slug="wikiSlug"
          :active-slug="activeSlug"
          :can-manage="canManageWiki"
          :sidebar-order="lichen.currentWiki?.sidebarOrder"
        />
        <TableOfContents variant="sidebar" :entries="noteToc" />
      </aside>

      <div class="wiki-main" data-kb-section aria-label="Wiki content">
        <div v-if="lichen.loading" class="state muted">Loading wiki…</div>
        <div v-else-if="lichen.error" class="state">
          <WikiHero :wiki="lichen.currentWiki" :profile="lichen.profile" :handle="handle" />
          <JoinRequestBanner
            v-if="lichen.currentWiki"
            :wiki-uri="lichen.currentWiki.uri"
            :wiki-name="lichen.currentWiki.name"
          />
          <p class="error-text">{{ lichen.error }}</p>
          <RateLimitSignInHint v-if="showRateLimitSignInHint" />
        </div>
        <div v-else-if="noteNotFound" class="state" :class="{ 'not-found': openTarget !== 'createNote' }">
          <WikiEditable
            v-if="lichen.currentWiki?.headerLinks?.length || (openTarget === 'headerLinks' && canManageWiki)"
            target="headerLinks"
            auto-open
            :allowed="canManageWiki"
            label="Edit header links"
            seamless
          >
            <WikiHeaderLinks
              v-if="lichen.currentWiki?.headerLinks?.length"
              :links="lichen.currentWiki.headerLinks"
              :owner-did="lichen.currentWiki.ownerDid"
              :owner-handle="handle"
              :wiki-slug="wikiSlug"
              kind="header"
            />
            <p v-else class="edit-empty muted">Add illustrated header links</p>
            <template #editor>
              <WikiHeaderLinks
                editing
                :links="lichen.currentWiki?.headerLinks ?? []"
                :owner-did="lichen.currentWiki?.ownerDid"
                :owner-handle="handle"
                :wiki-slug="wikiSlug"
                kind="header"
                @saved="closeModal"
                @cancel="closeModal"
              />
            </template>
          </WikiEditable>

          <WikiInlineNoteEditor
            v-if="openTarget === 'createNote' && canPublishWiki"
            mode="create"
            :create-slug="createSlug"
            :owner-handle="handle"
            :wiki-slug="wikiSlug"
          />
          <template v-else-if="!openTarget">
            <p class="muted not-found-copy">
              This page doesn’t exist yet.
              <template v-if="canPublishWiki"> You can create it.</template>
            </p>
            <div class="not-found-actions">
              <button
                v-if="canPublishWiki"
                type="button"
                class="btn btn-primary"
                @click="startCreatePage"
              >
                Create this page
              </button>
              <RouterLink
                v-else-if="noteCaps.canSuggest"
                :to="`/@${handle}/${wikiSlug}/edit/${requestedSlug}`"
                class="btn btn-primary"
              >
                Propose this page
              </RouterLink>
              <RouterLink
                :to="`/@${handle}/${wikiSlug}/forum?note=${encodeURIComponent(requestedSlug)}`"
                class="btn btn-secondary"
              >
                Discuss it instead
              </RouterLink>
            </div>
            <p v-if="!canEditWiki && !noteCaps.canSuggest" class="muted not-found-copy">
              Or start a discussion about what this page should be.
            </p>
          </template>
        </div>
        <template v-else-if="lichen.currentWiki && currentNote">
          <WikiEditable
            v-if="lichen.currentWiki.headerLinks?.length || (openTarget === 'headerLinks' && canManageWiki)"
            target="headerLinks"
            auto-open
            :allowed="canManageWiki"
            label="Edit header links"
            seamless
          >
            <WikiHeaderLinks
              v-if="lichen.currentWiki.headerLinks?.length"
              :links="lichen.currentWiki.headerLinks"
              :owner-did="lichen.currentWiki.ownerDid"
              :owner-handle="handle"
              :wiki-slug="wikiSlug"
              kind="header"
            />
            <p v-else class="edit-empty muted">Add illustrated header links</p>
            <template #editor>
              <WikiHeaderLinks
                editing
                :links="lichen.currentWiki.headerLinks ?? []"
                :owner-did="lichen.currentWiki.ownerDid"
                :owner-handle="handle"
                :wiki-slug="wikiSlug"
                kind="header"
                @saved="closeModal"
                @cancel="closeModal"
              />
            </template>
          </WikiEditable>

          <JoinRequestBanner
            v-if="lichen.currentWiki"
            :wiki-uri="lichen.currentWiki.uri"
            :wiki-name="lichen.currentWiki.name"
          />

          <BlogSyncPanel
            v-if="canPublishWiki && blogSuggestions.length"
            :suggestions="blogSuggestions"
            :owner-handle="handle"
            :wiki-slug="wikiSlug"
            :publications="lichen.publications"
            :creating="creatingStubs"
            @create-all="createAllStubs"
            @create-one="createOneStub"
          />

          <PhotoSubmitCard
            v-if="noteCaps.canSubmitImages && !noteCaps.canPublish && currentNote"
            :note-slug="currentNote.slug"
          />

          <WikiToolbar
            ref="toolbarRef"
            :note="currentNote"
            :owner-handle="handle"
            :wiki-slug="wikiSlug"
            :wiki-uri="lichen.currentWiki.uri"
            :wiki-name="lichen.currentWiki.name"
            :notes="lichen.notes"
            :can-edit="canEditWiki"
            :can-manage="canManageWiki"
            :is-public="lichen.currentWiki.visibility === 'public'"
          />

          <ForkSyncPanel />

          <ForksOfWikiPanel
            v-if="isWikiHome"
            :wiki-uri="lichen.currentWiki.uri"
          />

          <WikisLikeThis
            v-if="isWikiHome && lichen.currentWiki"
            :wiki-uri="lichen.currentWiki.uri"
            :handle="handle"
            :slug="wikiSlug"
          />

          <section
            v-if="isWikiHome && !canPublishWiki && lichen.currentWiki"
            class="card remix-card"
          >
            <h2>Remix this wiki</h2>
            <p class="muted">
              Fork it into your own account — every page, image, and the theme come with you,
              and you can pull in the original's later changes whenever you want.
            </p>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="remixing"
              @click="remixThisWiki"
            >
              {{ remixing ? 'Remixing…' : auth.isAuthenticated ? 'Remix this wiki' : 'Sign in to remix' }}
            </button>
            <p v-if="remixError" class="error-text">{{ remixError }}</p>
          </section>

          <NoteContent
            :key="currentNote.uri"
            :note="currentNote"
            :owner-handle="handle"
            :wiki-slug="wikiSlug"
            :backlinks="lichen.getBacklinksFor(currentNote.slug)"
            :reference-subjects="referenceSubjects"
            :blog-posts="lichen.blogPosts"
            :publications="lichen.publications"
            :wiki-notes="lichen.notes"
            :subheader-links="currentNote.subheaderLinks"
            :owner-did="lichen.currentWiki.ownerDid"
            :can-edit="canEditWiki"
            :can-manage="canManageWiki"
            @save-talk="saveTalkContent"
          />
        </template>
      </div>

      <aside
        v-if="lichen.notes.length"
        class="wiki-sidebar wiki-sidebar-end"
        data-kb-section
        aria-label="Wiki tools"
      >
        <WikiHero
          :wiki="lichen.currentWiki"
          :profile="lichen.profile"
          :handle="handle"
          sidebar
        />
        <WikiPortal
          :owner-handle="handle"
          :wiki-slug="wikiSlug"
          :notes="lichen.notes"
          :recent-changes="recentChanges"
          :categories="categories"
          :can-edit="canEditWiki"
        />
      </aside>
    </div>
    <WikiDock
      v-if="dockLinks.length"
      :links="dockLinks"
      :owner-handle="handle"
      :wiki-slug="wikiSlug"
      :active-slug="noteSlug"
    />

  </div>
</template>

<style scoped>
.wiki-view {
  padding: 0 0 4rem;
  background: var(--pckt-bg);
}

/* The floating dock clears the stage so scrolled content never slides
   behind the bubbles — same contract as the OS shell's dock clearance. */
.wiki-view--has-dock {
  padding-bottom: calc(96px + env(safe-area-inset-bottom, 0px));
}

.wiki-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: 'main';
  align-items: start;
  width: 100%;
}

/* Equal side rails keep the article visually centered (Vector 2022) */
.wiki-layout.has-sidebars {
  grid-template-columns:
    var(--pckt-sidebar-width)
    minmax(0, 1fr)
    var(--pckt-sidebar-width);
  grid-template-areas: 'start main end';
}

.wiki-sidebar-start {
  grid-area: start;
  padding: 1.5rem 0.875rem 2rem var(--pckt-page-gutter);
}

.wiki-main {
  grid-area: main;
  box-sizing: border-box;
  justify-self: center;
  min-width: 0;
  width: 100%;
  max-width: var(--pckt-content-width);
  padding: 1.5rem 1.5rem 0;
}

.wiki-sidebar-end {
  grid-area: end;
  padding: 1.5rem var(--pckt-page-gutter) 2rem 0.875rem;
}

.wiki-sidebar {
  position: sticky;
  top: 0;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  box-sizing: border-box;
  width: var(--pckt-sidebar-width);
  max-height: 100dvh;
  overflow-y: auto;
  background: var(--pckt-wiki-sidebar-bg, transparent);
}

/* The end rail's cards run taller than the viewport, so capping it at 100dvh
   made it the tallest grid item — the row then matched its height exactly,
   leaving sticky no travel. It never pinned, scrolled away with the page, and
   clipped its own cards top and bottom behind a second scrollbar. Plain column
   instead; the start rail is short enough that its sticky still works. */
.wiki-sidebar-end {
  position: static;
  max-height: none;
  overflow: visible;
}

@media (max-width: 1100px) {
  .wiki-layout.has-sidebars {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'main'
      'end';
  }

  .wiki-sidebar-start {
    display: none;
  }

  .wiki-sidebar-end {
    width: auto;
    max-height: none;
    position: static;
    padding: 0 var(--pckt-page-gutter) 1.5rem;
  }
}

@media (max-width: 768px) {
  .wiki-view {
    padding: 0 0 3rem;
  }

  .wiki-sidebar {
    position: static;
    top: auto;
    width: auto;
    max-height: none;
    overflow: visible;
  }

  .wiki-sidebar-end {
    padding: 0 var(--pckt-page-gutter) 1rem;
  }

  .wiki-main {
    max-width: none;
    padding: 1rem 0.875rem 0;
  }
}

.state {
  padding: 2rem 0;
}

.not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
}

.not-found-copy {
  margin: 0;
}

.edit-empty {
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  border: 1px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  font-size: 0.875rem;
}

.not-found-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: center;
}

.remix-card {
  padding: 1rem 1.25rem;
  margin-top: 1rem;
  display: grid;
  gap: 0.5rem;
}

.remix-card h2 {
  margin: 0;
  font-size: 1rem;
}

.remix-card p {
  margin: 0;
  font-size: 0.875rem;
}
</style>
