<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useMenuDismissGroup } from '@/composables/useMenuDismissGroup'
import { useOverlayDismiss } from '@/composables/useOverlayDismiss'
import { useKeyboardNav } from '@/composables/useKeyboardNavProvider'
import { useThemeMode } from '@/composables/useThemeMode'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { wikiPath } from '@/data/featured-wikis'
import WikiAvatar from '@/components/WikiAvatar.vue'
import type { LichenWikiRecord } from '@/types/lichen'

const DOT_COLORS = ['red', 'green', 'blue', 'yellow'] as const

interface MenuLink {
  id: string
  label: string
  to: string
  accent?: boolean
}

const auth = useAuthStore()
const lichen = useLichenStore()
const nav = useKeyboardNav()
const { mode: themeMode, label: themeLabel, nextLabel: themeNextLabel, cycleMode } = useThemeMode()
const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const menuLoaded = ref(false)
const renamingUri = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)
const renaming = ref(false)
const renameError = ref('')

const handle = computed(() => auth.handle ?? lichen.ownerHandle ?? '')
const profileName = computed(() => lichen.profile?.displayName?.trim() ?? '')
const displayName = computed(() => profileName.value || handle.value || 'Account')

const navLinks = computed<MenuLink[]>(() => [
  { id: 'library', label: 'Wiki library', to: '/library' },
  { id: 'dashboard', label: 'My wikis', to: '/dashboard' },
  { id: 'create-wiki', label: 'Create wiki', to: '/wiki/new', accent: true },
])

const ownWikis = computed(() =>
  lichen.activeWikis.slice(0, 4).map((wiki) => ({
    wiki,
    to: auth.handle ? wikiPath(auth.handle, wiki.slug) : '/dashboard',
  })),
)

function dotColor(index: number): (typeof DOT_COLORS)[number] {
  return DOT_COLORS[index % DOT_COLORS.length]!
}

function close() {
  cancelRename()
  open.value = false
}

/** Open the keyboard-shortcut sheet from the menu, closing the menu first. */
function openKeyboardHelp() {
  close()
  nav.helpOpen.value = true
}

const { closeOtherMenus } = useMenuDismissGroup(open, close)

useOverlayDismiss(rootRef, open, close)

function toggle(event: Event) {
  event.stopPropagation()
  if (!open.value) closeOtherMenus()
  open.value = !open.value
}

async function ensureMenuData() {
  if (menuLoaded.value || !auth.agent) return
  // Already hydrated (e.g. dashboard/library) — show immediately
  if (lichen.activeWikis.length > 0) {
    menuLoaded.value = true
    return
  }
  try {
    await lichen.loadOwnerWikis(auth.agent)
  } catch {
    // Profile menu still works with static links
  } finally {
    menuLoaded.value = true
  }
}

async function signOut() {
  close()
  await auth.signOut()
  menuLoaded.value = false
}

function setRenameInput(el: unknown) {
  renameInputRef.value = (el as HTMLInputElement | null) ?? null
}

function startRename(wiki: LichenWikiRecord, event: Event) {
  event.preventDefault()
  event.stopPropagation()
  renamingUri.value = wiki.uri
  renameDraft.value = wiki.name
  renameError.value = ''
  void nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function cancelRename() {
  renamingUri.value = null
  renameDraft.value = ''
  renameError.value = ''
  renaming.value = false
}

async function saveRename(wiki: LichenWikiRecord) {
  if (!auth.agent || renaming.value) return
  const next = renameDraft.value.trim()
  if (!next) {
    renameError.value = 'Name is required'
    return
  }
  if (next === wiki.name) {
    cancelRename()
    return
  }

  renaming.value = true
  renameError.value = ''
  try {
    await lichen.setWikiName(auth.agent, wiki, next)
    cancelRename()
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : 'Could not rename wiki'
  } finally {
    renaming.value = false
  }
}

function onRenameKeydown(wiki: LichenWikiRecord, event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    void saveRename(wiki)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
  }
}

// Prefetch while the header is visible so the menu opens with wikis ready
onMounted(() => {
  void ensureMenuData()
})

watch(
  () => auth.agent,
  (agent) => {
    if (agent) void ensureMenuData()
  },
)

watch(open, (isOpen) => {
  if (isOpen) void ensureMenuData()
  else cancelRename()
})
</script>

<template>
  <div ref="rootRef" class="account-menu" :class="{ open }">
    <button
      type="button"
      class="account-menu-trigger"
      :aria-expanded="open"
      aria-haspopup="menu"
      :aria-label="`Account menu for ${displayName}`"
      @click="toggle"
    >
      <WikiAvatar
        :handle="handle || 'account'"
        :name="displayName"
        :seed="handle || 'account'"
        accent-color="var(--pckt-blue)"
        :size="36"
        loading="eager"
      />
    </button>

    <div v-if="open" class="account-menu-panel" role="menu">
      <div class="account-menu-strip" aria-hidden="true">
        <span class="account-menu-strip-seg account-menu-strip-red" />
        <span class="account-menu-strip-seg account-menu-strip-blue" />
        <span class="account-menu-strip-seg account-menu-strip-yellow" />
        <span class="account-menu-strip-seg account-menu-strip-green" />
        <span class="account-menu-strip-seg account-menu-strip-end" />
      </div>

      <header class="account-menu-hero">
        <WikiAvatar
          :handle="handle || 'account'"
          :name="displayName"
          :seed="handle || 'account'"
          accent-color="var(--pckt-blue)"
          :size="52"
          loading="eager"
        />
        <div class="account-menu-hero-copy">
          <p class="account-menu-hero-name">{{ displayName }}</p>
          <p v-if="handle" class="account-menu-hero-handle muted">@{{ handle }}</p>
          <p v-if="lichen.profile?.description" class="account-menu-hero-bio muted">
            {{ lichen.profile.description }}
          </p>
        </div>
      </header>

      <section class="account-menu-section">
        <h3 class="account-menu-section-title">Your wikis</h3>
        <ul class="account-menu-list">
          <li v-for="(link, index) in navLinks" :key="link.id">
            <RouterLink
              :to="link.to"
              class="account-menu-link"
              :class="{ 'account-menu-link-accent': link.accent }"
              role="menuitem"
              @click="close"
            >
              <span class="account-menu-dot" :class="`account-menu-dot-${dotColor(index)}`" aria-hidden="true" />
              <span>{{ link.label }}</span>
            </RouterLink>
          </li>

          <li
            v-for="(entry, index) in ownWikis"
            :key="entry.wiki.uri"
            class="account-menu-wiki-row"
          >
            <template v-if="renamingUri === entry.wiki.uri">
              <form
                class="account-menu-rename"
                @submit.prevent="saveRename(entry.wiki)"
                @click.stop
              >
                <span
                  class="account-menu-dot"
                  :class="`account-menu-dot-${dotColor(navLinks.length + index)}`"
                  aria-hidden="true"
                />
                <input
                  :ref="setRenameInput"
                  v-model="renameDraft"
                  class="account-menu-rename-input"
                  type="text"
                  maxlength="256"
                  :disabled="renaming"
                  :aria-label="`Rename ${entry.wiki.name}`"
                  @keydown="onRenameKeydown(entry.wiki, $event)"
                />
                <button
                  type="submit"
                  class="account-menu-rename-save"
                  :disabled="renaming || !renameDraft.trim()"
                >
                  {{ renaming ? '…' : 'Save' }}
                </button>
              </form>
              <p v-if="renameError" class="account-menu-rename-error">{{ renameError }}</p>
            </template>

            <div v-else class="account-menu-wiki-item">
              <RouterLink
                :to="entry.to"
                class="account-menu-link account-menu-wiki-link"
                role="menuitem"
                @click="close"
              >
                <span
                  class="account-menu-dot"
                  :class="`account-menu-dot-${dotColor(navLinks.length + index)}`"
                  aria-hidden="true"
                />
                <span class="account-menu-wiki-name">{{ entry.wiki.name }}</span>
              </RouterLink>
              <button
                type="button"
                class="account-menu-rename-btn"
                :aria-label="`Rename ${entry.wiki.name}`"
                title="Rename wiki"
                @click="startRename(entry.wiki, $event)"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                  <path
                    fill="currentColor"
                    d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm14.71-9.04a1 1 0 0 0 0-1.41l-2.51-2.51a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.99-1.66z"
                  />
                </svg>
              </button>
            </div>
          </li>
        </ul>
      </section>

      <section class="account-menu-section">
        <h3 class="account-menu-section-title">Preferences</h3>
        <ul class="account-menu-list">
          <li>
            <button
              type="button"
              class="account-menu-link"
              role="menuitem"
              :title="`Switch to ${themeNextLabel.toLowerCase()}`"
              @click.stop="cycleMode"
            >
              <span class="account-menu-icon" aria-hidden="true">
                <!-- Sun -->
                <svg v-if="themeMode === 'light'" viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2" />
                  <path
                    d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
                <!-- Moon -->
                <svg v-else-if="themeMode === 'dark'" viewBox="0 0 24 24" width="18" height="18">
                  <path
                    d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linejoin="round"
                  />
                </svg>
                <!-- Auto -->
                <svg v-else viewBox="0 0 24 24" width="18" height="18">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
                  <path d="M12 3a9 9 0 0 0 0 18V3z" fill="currentColor" />
                </svg>
              </span>
              <span>Appearance · {{ themeLabel }}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              class="account-menu-link"
              role="menuitem"
              title="Keyboard shortcuts (?)"
              @click.stop="openKeyboardHelp"
            >
              <span class="account-menu-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18">
                  <rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
                  <path
                    d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </span>
              <span>Keyboard shortcuts</span>
            </button>
          </li>
        </ul>
      </section>

      <footer class="account-menu-footer">
        <button type="button" class="account-menu-sign-out" role="menuitem" @click.stop="signOut">
          Sign out
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.account-menu {
  position: relative;
}

.account-menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: 2px solid var(--pckt-border);
  border-radius: 50%;
  background: var(--pckt-bg-elevated);
  color: inherit;
  font: inherit;
  line-height: 0;
  cursor: pointer;
  box-shadow: var(--pckt-shadow-xs);
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.15s ease;
}

.account-menu-trigger:hover,
.account-menu.open .account-menu-trigger {
  border-color: color-mix(in srgb, var(--pckt-blue) 40%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-blue) 6%, var(--pckt-bg-elevated));
  box-shadow: var(--pckt-shadow);
}

.account-menu.open {
  z-index: 60;
}

.account-menu-panel {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 60;
  width: min(18.5rem, calc(100vw - 2rem));
  overflow: hidden;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow-md);
  text-align: left;
}

.account-menu-strip {
  display: flex;
  gap: 3px;
  height: 5px;
  padding: 0 0.25rem;
  background: var(--pckt-bg-elevated);
}

.account-menu-strip-seg {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 1px;
}

.account-menu-strip-red {
  background: var(--pckt-red);
}

.account-menu-strip-blue {
  background: var(--pckt-blue);
}

.account-menu-strip-yellow {
  background: var(--pckt-yellow);
}

.account-menu-strip-green {
  background: var(--pckt-green);
}

.account-menu-strip-end {
  background: var(--pckt-red);
}

.account-menu-hero {
  display: flex;
  gap: 0.875rem;
  align-items: flex-start;
  padding: 1rem 1rem 0.875rem;
  border-bottom: 1px solid var(--pckt-border);
  background: color-mix(in srgb, var(--pckt-cream) 28%, var(--pckt-bg-elevated));
}

[data-theme='dark'] .account-menu-hero {
  background: color-mix(in srgb, var(--pckt-bg-muted) 80%, var(--pckt-bg-elevated));
}

.account-menu-hero-copy {
  min-width: 0;
}

.account-menu-hero-name {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 1rem;
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--pckt-text);
}

.account-menu-hero-handle {
  margin: 0.125rem 0 0;
  font-size: 0.8125rem;
  font-weight: 600;
}

.account-menu-hero-bio {
  margin: 0.375rem 0 0;
  font-size: 0.75rem;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.account-menu-section {
  padding: 0.625rem 0.5rem 0.25rem;
}

.account-menu-section + .account-menu-section {
  border-top: 1px solid color-mix(in srgb, var(--pckt-border) 80%, transparent);
}

.account-menu-section-title {
  margin: 0 0 0.25rem;
  padding: 0 0.5rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--pckt-text-subtle);
}

.account-menu-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.account-menu-link {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.5625rem 0.625rem;
  border-radius: var(--pckt-radius-sm);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.3;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.account-menu-link:hover {
  background: var(--pckt-bg-muted);
  color: var(--pckt-text);
  text-decoration: none;
}

.account-menu-link-accent {
  color: var(--pckt-blue);
}

.account-menu-link-accent:hover {
  background: color-mix(in srgb, var(--pckt-blue) 10%, var(--pckt-bg-muted));
  color: var(--pckt-blue-hover);
}

.account-menu-wiki-item {
  display: flex;
  align-items: center;
  gap: 0.125rem;
}

.account-menu-wiki-link {
  min-width: 0;
  flex: 1 1 auto;
}

.account-menu-wiki-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-menu-rename-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  margin-right: 0.25rem;
  padding: 0;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text-subtle);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}

.account-menu-wiki-item:hover .account-menu-rename-btn,
.account-menu-wiki-item:focus-within .account-menu-rename-btn,
.account-menu-rename-btn:focus-visible {
  opacity: 1;
}

.account-menu-rename-btn:hover,
.account-menu-rename-btn:focus-visible {
  background: var(--pckt-bg-muted);
  color: var(--pckt-text);
}

.account-menu-rename {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3125rem 0.375rem 0.3125rem 0.625rem;
}

.account-menu-rename-input {
  min-width: 0;
  flex: 1 1 auto;
  padding: 0.3125rem 0.5rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.3;
}

.account-menu-rename-input:focus {
  outline: 2px solid color-mix(in srgb, var(--pckt-blue) 45%, transparent);
  outline-offset: 1px;
  border-color: color-mix(in srgb, var(--pckt-blue) 50%, var(--pckt-border));
}

.account-menu-rename-save {
  flex-shrink: 0;
  padding: 0.3125rem 0.5rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: color-mix(in srgb, var(--pckt-blue) 12%, transparent);
  color: var(--pckt-blue);
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.account-menu-rename-save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pckt-blue) 18%, transparent);
  color: var(--pckt-blue-hover);
}

.account-menu-rename-save:disabled {
  opacity: 0.55;
  cursor: default;
}

.account-menu-rename-error {
  margin: 0 0.625rem 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--pckt-red-active);
}

.account-menu-dot {
  flex-shrink: 0;
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
}

.account-menu-dot-red {
  background: var(--pckt-red);
}

.account-menu-dot-green {
  background: var(--pckt-green);
}

.account-menu-dot-blue {
  background: var(--pckt-blue);
}

.account-menu-dot-yellow {
  background: var(--pckt-yellow);
}

.account-menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  flex: none;
  color: var(--pckt-text-muted);
}

.account-menu-footer {
  padding: 0.5rem;
  border-top: 1px solid var(--pckt-border);
  background: color-mix(in srgb, var(--pckt-bg-muted) 45%, transparent);
}

.account-menu-sign-out {
  width: 100%;
  padding: 0.625rem 0.75rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: color-mix(in srgb, var(--pckt-red) 8%, transparent);
  color: color-mix(in srgb, var(--pckt-red-active) 85%, var(--pckt-text));
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.account-menu-sign-out:hover {
  background: color-mix(in srgb, var(--pckt-red) 14%, transparent);
  color: var(--pckt-red-active);
}

@media (hover: none) {
  .account-menu-rename-btn {
    opacity: 1;
  }
}
</style>
