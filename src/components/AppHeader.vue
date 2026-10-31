<script setup lang="ts">
import { assetUrl } from '@/lib/base-url'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import PcktSparkLogomark from '@/components/PcktSparkLogomark.vue'
import LandingSignInCard from '@/components/landing/LandingSignInCard.vue'
import HeaderNavMenu from '@/components/HeaderNavMenu.vue'
import HeaderNotifications from '@/components/HeaderNotifications.vue'
import HeaderProfileMenu from '@/components/HeaderProfileMenu.vue'
import ThemeModeToggle from '@/components/ThemeModeToggle.vue'
import WikiHeaderLinks from '@/components/WikiHeaderLinks.vue'
import WikiEditable from '@/components/WikiEditable.vue'
import WikiHeaderImageEditor from '@/components/WikiHeaderImageEditor.vue'
import { blobCid, buildBlobUrl, resolveBlobDisplayUrl } from '@/lib/atproto/blobs'
import { getCachedPdsUrl } from '@/lib/atproto/handle-cache'
import { normalizeHandle } from '@/lib/config'
import { getPublicWikiCache } from '@/lib/lichen/wiki-cache'
import { canEdit, canManage } from '@/lib/lichen/collections'
import { refreshSuffixColor } from '@/lib/pckt-brand-color'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useWikiThemeMode } from '@/composables/useWikiThemeMode'
import type { LichenBlobRef, LichenNavLink } from '@/types/lichen'

const auth = useAuthStore()
const lichen = useLichenStore()
const route = useRoute()
const {
  active: editModeActive,
  openTarget,
  toggle: toggleEditMode,
  closeModal,
  saving: editSaving,
  requestSave,
  exit: exitEditMode,
} = useWikiEditMode()
const {
  active: themeModeActive,
  saving: themeSaving,
  enter: enterThemeMode,
  discard: discardTheme,
  commit: commitTheme,
} = useWikiThemeMode()

/**
 * In edit mode this button runs the same Save path as the article editor — one
 * action for every open editor. Edit mode only closes once the writes land.
 */
function onEditModeClick() {
  if (!editModeActive.value) {
    toggleEditMode()
    return
  }
  requestSave()
}

function discardEdits() {
  exitEditMode()
}

async function onThemeModeClick() {
  if (!themeModeActive.value) {
    enterThemeMode()
    return
  }
  await commitTheme()
}

const isHome = computed(() => route.name === 'home')
const isWikiView = computed(() =>
  [
    'wiki-home',
    'wiki-note',
    'edit-note',
    'note-history',
    'wiki-recent',
    'wiki-search',
    'wiki-category',
    'wiki-settings',
    'wiki-versions',
  ].includes(String(route.name)),
)

const routeWikiHandle = computed(() => {
  if (!isWikiView.value || !route.params.handle) return null
  return normalizeHandle(String(route.params.handle))
})
const routeWikiSlug = computed(() => {
  if (!isWikiView.value || !route.params.wikiSlug) return null
  return String(route.params.wikiSlug)
})

const wikiHeaderImageUrl = ref<string | null>(null)
const wikiBrandHandle = ref<string | null>(null)
const wikiBrandSlug = ref<string | null>(null)
const wikiBrandName = ref<string | null>(null)
const defaultWordmark = assetUrl('brand-assets/pckt-color.svg')

/** In-memory resolved blob URLs so soft navigations don't flash the default logo. */
const resolvedHeaderUrlCache = new Map<string, string>()

function headerUrlCacheKey(did: string, image: unknown): string | null {
  const cid = blobCid(image)
  return cid ? `${did}:${cid}` : null
}

function syncHeaderUrl(did: string, image: unknown): string | null {
  const key = headerUrlCacheKey(did, image)
  if (key) {
    const cached = resolvedHeaderUrlCache.get(key)
    if (cached) return cached
  }
  const cid = blobCid(image)
  if (!cid) return null
  const pdsUrl = getCachedPdsUrl(did)
  if (!pdsUrl) return null
  const url = buildBlobUrl(pdsUrl, did, cid)
  if (key) resolvedHeaderUrlCache.set(key, url)
  return url
}

async function resolveHeaderUrl(did: string, image: unknown): Promise<string | null> {
  const sync = syncHeaderUrl(did, image)
  if (sync) return sync
  const key = headerUrlCacheKey(did, image)
  try {
    const url = await resolveBlobDisplayUrl(did, image)
    if (url && key) resolvedHeaderUrlCache.set(key, url)
    return url
  } catch {
    return null
  }
}

function setWikiBrand(
  url: string | null,
  handle: string | null,
  slug: string | null,
  name: string | null,
) {
  if (url === wikiHeaderImageUrl.value) {
    wikiBrandHandle.value = handle ?? wikiBrandHandle.value
    wikiBrandSlug.value = slug ?? wikiBrandSlug.value
    wikiBrandName.value = name ?? wikiBrandName.value
    return
  }
  wikiHeaderImageUrl.value = url
  wikiBrandHandle.value = url ? handle : null
  wikiBrandSlug.value = url ? slug : null
  wikiBrandName.value = url ? name : null
}

const centerBrandSrc = computed(() => wikiHeaderImageUrl.value ?? defaultWordmark)
const centerBrandIsWiki = computed(() => Boolean(wikiHeaderImageUrl.value))
const centerBrandTo = computed(() => {
  const handle = wikiBrandHandle.value ?? lichen.ownerHandle ?? routeWikiHandle.value
  const slug = wikiBrandSlug.value ?? lichen.currentWiki?.slug ?? routeWikiSlug.value
  if (centerBrandIsWiki.value && handle && slug) {
    return `/@${handle}/${slug}`
  }
  return '/'
})
const centerBrandLabel = computed(() =>
  centerBrandIsWiki.value
    ? `${wikiBrandName.value ?? lichen.currentWiki?.name ?? 'Wiki'} home`
    : 'pckt.wiki home',
)
const centerBrandAlt = computed(() =>
  centerBrandIsWiki.value
    ? (wikiBrandName.value ?? lichen.currentWiki?.name ?? 'Wiki')
    : 'pckt',
)

const navbarLinks = computed((): LichenNavLink[] => {
  if (!isWikiView.value) return []
  const handle = routeWikiHandle.value
  const slug = routeWikiSlug.value
  const live = lichen.currentWiki
  if (
    live?.navbarLinks?.length &&
    (!slug || live.slug === slug) &&
    (!handle || !lichen.ownerHandle || lichen.ownerHandle === handle)
  ) {
    return live.navbarLinks
  }
  if (handle && slug) {
    return getPublicWikiCache(handle, slug, Number.POSITIVE_INFINITY)?.wiki?.navbarLinks ?? []
  }
  return []
})

const navbarOwnerHandle = computed(
  () => lichen.ownerHandle ?? routeWikiHandle.value ?? '',
)
const navbarWikiSlug = computed(
  () => lichen.currentWiki?.slug ?? routeWikiSlug.value ?? '',
)
const showNavbarLinks = computed(
  () =>
    isWikiView.value &&
    navbarLinks.value.length > 0 &&
    Boolean(navbarOwnerHandle.value && navbarWikiSlug.value),
)

const canManageWikiChrome = computed(() => isWikiView.value && canManage(lichen.access))
const canUseEditMode = computed(
  () => isWikiView.value && (canEdit(lichen.access) || canManage(lichen.access)),
)
const canUseThemeMode = computed(() => isWikiView.value && canManage(lichen.access))
const showNavbarEditTarget = computed(
  () =>
    showNavbarLinks.value ||
    (openTarget.value === 'navbarLinks' && canManageWikiChrome.value),
)
const showLogoEditTarget = computed(
  () =>
    isWikiView.value &&
    (centerBrandIsWiki.value ||
      (openTarget.value === 'headerImage' && canManageWikiChrome.value)),
)
const editingNavbar = computed(() => openTarget.value === 'navbarLinks')
const editingLogo = computed(() => openTarget.value === 'headerImage')

watch(
  () =>
    [
      isWikiView.value,
      routeWikiHandle.value,
      routeWikiSlug.value,
      lichen.currentWiki?.uri,
      lichen.currentWiki?.slug,
      lichen.currentWiki?.ownerDid,
      lichen.currentWiki?.headerImage,
      lichen.currentWiki?.name,
      lichen.ownerHandle,
    ] as const,
  async ([onWiki, handle, slug, , wikiSlug, ownerDid, headerImage, wikiName, ownerHandle]) => {
    if (!onWiki) {
      setWikiBrand(null, null, null, null)
      return
    }

    const brandHandle = ownerHandle ?? handle
    const brandSlug = wikiSlug ?? slug
    const brandName = wikiName ?? null

    let did: string | null | undefined = ownerDid
    let image: LichenBlobRef | undefined = headerImage

    const liveMatchesRoute =
      Boolean(did && image) &&
      (!slug || wikiSlug === slug) &&
      (!handle || !ownerHandle || ownerHandle === handle)

    if (!liveMatchesRoute && handle && slug) {
      const cached = getPublicWikiCache(handle, slug, Number.POSITIVE_INFINITY)
      if (cached?.wiki?.headerImage && cached.did) {
        did = cached.did
        image = cached.wiki.headerImage
      }
    }

    if (!did || !image) {
      // Wiki loaded for this route and intentionally has no custom logo.
      if (lichen.currentWiki && (!slug || lichen.currentWiki.slug === slug) && !lichen.currentWiki.headerImage) {
        setWikiBrand(null, null, null, null)
      }
      // Otherwise keep the current wiki logo while metadata is still loading.
      return
    }

    const syncUrl = syncHeaderUrl(did, image)
    if (syncUrl) {
      setWikiBrand(syncUrl, brandHandle, brandSlug, brandName ?? cachedWikiName(handle, slug))
      return
    }

    const resolveHandle = handle
    const resolveSlug = slug
    const url = await resolveHeaderUrl(did, image)
    // Drop stale async results after navigating away or to another wiki.
    if (!isWikiView.value) return
    if (resolveHandle && routeWikiHandle.value !== resolveHandle) return
    if (resolveSlug && routeWikiSlug.value !== resolveSlug) return
    if (url) {
      setWikiBrand(url, brandHandle, brandSlug, brandName ?? cachedWikiName(handle, slug))
    }
  },
  { immediate: true },
)

function cachedWikiName(handle: string | null, slug: string | null): string | null {
  if (!handle || !slug) return null
  return getPublicWikiCache(handle, slug, Number.POSITIVE_INFINITY)?.wiki?.name ?? null
}

function onBrandMenuClick(event: Event, toggle: (event: Event) => void) {
  refreshSuffixColor()
  toggle(event)
}
</script>

<template>
  <header
    class="header app-header"
    data-kb-section
    aria-label="Site navigation"
    :class="{
      'header-home': isHome,
      'header-minimal': isWikiView,
      'header-has-wiki-nav': showNavbarEditTarget,
    }"
  >
    <div class="header-inner">
      <div class="brand-area">
        <HeaderNavMenu :is-home="isHome" align="start" class="brand-menu">
          <template #trigger="{ toggle, open }">
            <button
              type="button"
              class="brand brand-trigger"
              :aria-expanded="open"
              aria-haspopup="menu"
              aria-label="Site menu"
              @click="onBrandMenuClick($event, toggle)"
            >
              <PcktSparkLogomark class="brand-mark" />
            </button>
          </template>
        </HeaderNavMenu>
        <WikiEditable
          v-if="showLogoEditTarget"
          target="headerImage"
          :allowed="canManageWikiChrome"
          label="Edit header logo"
          class="header-wiki-brand-wrap"
          :class="{ 'header-chrome-editing': editingLogo }"
        >
          <RouterLink
            v-if="centerBrandIsWiki"
            :to="centerBrandTo"
            class="header-wiki-brand"
            :aria-label="centerBrandLabel"
          >
            <img
              class="header-wiki-brand-img"
              :src="centerBrandSrc"
              :alt="centerBrandAlt"
              decoding="async"
              fetchpriority="high"
            />
          </RouterLink>
          <span v-else class="header-logo-empty muted">Add logo</span>
          <template #editor>
            <WikiHeaderImageEditor embedded @saved="closeModal" />
          </template>
        </WikiEditable>
      </div>

      <RouterLink
        v-if="!isHome && !centerBrandIsWiki && !showNavbarEditTarget"
        :to="centerBrandTo"
        class="header-center-brand"
        :aria-label="centerBrandLabel"
      >
        <img
          class="header-center-wordmark"
          :src="centerBrandSrc"
          :alt="centerBrandAlt"
          :width="249"
          :height="106"
          decoding="async"
          fetchpriority="high"
        />
      </RouterLink>

      <WikiEditable
        v-if="showNavbarEditTarget"
        target="navbarLinks"
        :allowed="canManageWikiChrome"
        label="Edit top navbar links"
        class="header-wiki-nav"
        :class="{ 'header-wiki-nav--editing': editingNavbar }"
        seamless
      >
        <WikiHeaderLinks
          v-if="showNavbarLinks"
          :links="navbarLinks"
          :owner-handle="navbarOwnerHandle"
          :wiki-slug="navbarWikiSlug"
          kind="header"
          variant="navbar"
        />
        <span v-else class="header-nav-empty muted">Add navbar links</span>
        <template #editor>
          <WikiHeaderLinks
            editing
            :links="navbarLinks"
            :owner-handle="navbarOwnerHandle"
            :wiki-slug="navbarWikiSlug"
            kind="header"
            variant="navbar"
            @saved="closeModal"
            @cancel="closeModal"
          />
        </template>
      </WikiEditable>

      <nav class="nav">
        <div class="nav-actions">
          <LandingSignInCard v-if="!auth.isAuthenticated && !auth.loading" header />
          <template v-else-if="auth.isAuthenticated">
            <button
              v-if="canUseEditMode && editModeActive"
              type="button"
              class="btn btn-ghost btn-sm"
              title="Leave edit mode without saving"
              @click="discardEdits"
            >
              Cancel
            </button>
            <button
              v-if="canUseEditMode"
              type="button"
              class="btn btn-sm header-edit-mode-btn"
              :class="editModeActive ? 'btn-primary' : 'btn-ghost'"
              :aria-pressed="editModeActive"
              :disabled="editSaving || themeModeActive"
              :title="editModeActive ? 'Save every open editor and leave edit mode' : 'Enter edit mode'"
              @click="onEditModeClick"
            >
              {{ editModeActive ? (editSaving ? 'Saving…' : 'Save') : 'Edit' }}
            </button>
            <button
              v-if="canUseThemeMode && themeModeActive"
              type="button"
              class="btn btn-ghost btn-sm"
              title="Leave theme mode without saving"
              @click="discardTheme"
            >
              Cancel
            </button>
            <button
              v-if="canUseThemeMode"
              type="button"
              class="btn btn-sm"
              :class="themeModeActive ? 'btn-primary' : 'btn-ghost'"
              :aria-pressed="themeModeActive"
              :disabled="themeSaving || editModeActive"
              :title="themeModeActive ? 'Save wiki theme and leave theme mode' : 'Enter theme mode'"
              @click="onThemeModeClick"
            >
              {{ themeModeActive ? (themeSaving ? 'Saving…' : 'Save theme') : 'Theme' }}
            </button>
            <HeaderNotifications />
            <HeaderProfileMenu />
          </template>
          <!-- Signed-in users reach these from the profile menu; guests keep the
               quick theme toggle on the bar. -->
          <ThemeModeToggle v-if="!auth.isAuthenticated" />
        </div>
      </nav>
    </div>
  </header>
</template>

<style scoped>
header.header {
  position: relative;
  z-index: 50;
  background: var(--pckt-header-bg, var(--pckt-bg));
  font-family: var(--pckt-font-ui);
  letter-spacing: normal;
  overflow: visible;
}

header.header-home {
  border-bottom: none;
}

header.header:not(.header-home) {
  border-bottom: 1px solid var(--pckt-border);
}

header.header-minimal {
  background: var(--pckt-header-bg, var(--pckt-bg));
  overflow: visible;
}

.header-inner {
  position: relative;
  max-width: min(88rem, calc(100vw - 2rem));
  margin: 0 auto;
  padding: 0.625rem var(--pckt-page-gutter);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  overflow: visible;
}

/* Align spark with the left wiki rail (Wikipedia-style) */
header.header-minimal .header-inner {
  max-width: none;
  width: 100%;
  margin: 0;
  box-sizing: border-box;
}

header.header-minimal .brand-area {
  min-width: calc(var(--pckt-sidebar-width) - var(--pckt-page-gutter));
  flex-shrink: 0;
}

.header-center-brand {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  color: var(--pckt-text);
  text-decoration: none;
  z-index: 1;
  max-width: min(16rem, 42vw);
}

.header-center-brand:hover {
  text-decoration: none;
}

.header-center-wordmark {
  display: block;
  width: auto;
  height: 1.375rem;
  max-width: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.brand-area {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex-shrink: 0;
  min-width: 0;
}

/* Beat WikiEditable's `position: relative` (same specificity otherwise). */
header.header-has-wiki-nav .header-wiki-nav {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
  width: max-content;
  max-width: min(36rem, calc(100% - 12rem));
  display: flex;
  justify-content: center;
}

.header-wiki-nav--editing {
  z-index: 60;
  overflow: visible;
}

.header-chrome-editing {
  position: relative;
  z-index: 60;
}

.header-chrome-editing :deep(.wiki-editable-editor) {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  width: min(24rem, calc(100vw - 2rem));
  box-shadow: 0 12px 32px rgba(17, 24, 39, 0.16);
  background: var(--pckt-bg-elevated);
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
}

.header-wiki-brand-wrap {
  display: flex;
  align-items: center;
  min-width: 0;
}

.header-logo-empty,
.header-nav-empty {
  display: inline-flex;
  align-items: center;
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.header-wiki-brand {
  display: inline-flex;
  align-items: center;
  color: var(--pckt-text);
  text-decoration: none;
  min-width: 0;
  max-width: min(14rem, 42vw);
}

.header-wiki-brand:hover {
  text-decoration: none;
}

.header-wiki-brand-img {
  display: block;
  width: auto;
  height: 1.75rem;
  max-width: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.brand {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--pckt-text);
  text-decoration: none;
}

.brand:hover {
  text-decoration: none;
}

.brand-menu {
  display: flex;
  align-items: center;
}

.brand-trigger {
  position: relative;
  border: none;
  background: none;
  padding: 0;
  margin: 0;
  font: inherit;
  cursor: pointer;
  color: inherit;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.brand-trigger::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  min-width: max(100%, 2.75rem);
  min-height: max(100%, 2.75rem);
}

.brand-mark {
  width: 1.375rem;
  height: auto;
  flex-shrink: 0;
  display: block;
  pointer-events: none;
  user-select: none;
}

.nav {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
  flex: 0 0 auto;
  min-width: 0;
}

header.header:not(.header-home) .nav {
  max-width: none;
}

.nav-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  min-width: 0;
  margin-left: auto;
}

@media (max-width: 1100px) {
  header.header-minimal .brand-area {
    min-width: 0;
  }
}

@media (max-width: 720px) {
  .nav {
    max-width: none;
  }

  /* Give wiki navbar its own full-width row so links stay tappable. */
  header.header-has-wiki-nav .header-inner {
    flex-wrap: wrap;
    row-gap: 0.25rem;
  }

  header.header-has-wiki-nav .header-wiki-nav {
    position: static;
    transform: none;
    order: 3;
    flex: 1 0 100%;
    width: 100%;
    max-width: none;
    margin-inline: calc(-1 * var(--pckt-page-gutter));
    padding-inline: var(--pckt-page-gutter);
  }

  header.header-has-wiki-nav .header-wiki-nav :deep(.wiki-header-links.is-navbar) {
    justify-content: center;
    gap: 0.125rem;
    padding-block: 0.125rem;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
  }
}

@media (max-width: 480px) {
  .header-inner {
    padding-inline: 0.875rem;
    gap: 0.625rem;
  }

  header.header-minimal .brand-area {
    min-width: 0;
  }

  .header-center-brand {
    max-width: min(12rem, 38vw);
  }

  .header-wiki-brand {
    max-width: min(10rem, 36vw);
  }

  header.header-has-wiki-nav .header-wiki-nav {
    margin-inline: -0.875rem;
    padding-inline: 0.875rem;
  }
}

@media (max-width: 430px) {
  header.header-has-wiki-nav .header-wiki-nav {
    margin-inline: -0.5rem;
    padding-inline: 0.5rem;
  }

  header.header-has-wiki-nav .header-wiki-nav :deep(.wiki-header-links.is-navbar) {
    justify-content: center;
    gap: 0;
    overflow-x: visible;
  }
}
</style>
