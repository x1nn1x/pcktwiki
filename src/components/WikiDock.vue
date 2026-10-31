<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  dockAccentFor,
  dockArtFor,
  dockInternalTarget,
  isDockLinkActive,
  isExternalDockUrl,
  splitDockRow,
  type DockLink,
} from '@/lib/wiki-dock'
import menuArt from '@/assets/dock/menu.webp'

/**
 * Osean World OS bottom dock, ported for wiki views: floating bubble buttons
 * for the wiki's own navbar links (same editable `navbarLinks` the topbar
 * renders) plus shared buttons linked from other creators. Past five bubbles
 * the rest fold into a folder button, and first-time visitors get a hint.
 */
const props = defineProps<{
  links: DockLink[]
  ownerHandle: string
  wikiSlug: string
  /** Slug of the open article; empty on the wiki front page. */
  activeSlug?: string
}>()

const basePath = computed(() => `/@${props.ownerHandle}/${props.wikiSlug}`)

type Button = {
  key: string
  label: string
  artUrl: string | null
  accent: string
  external: boolean
  href?: string
  to?: string
  active: boolean
}

const buttons = computed<Button[]>(() =>
  props.links
    .filter((link) => link.label.trim())
    .map((link, index) => {
      const url = link.url?.trim() ?? ''
      const external = isExternalDockUrl(url)
      return {
        key: `${link.label}-${index}`,
        label: link.label.trim(),
        artUrl: link.artUrl ?? dockArtFor(link.label),
        accent: dockAccentFor(index),
        external,
        href: external ? url : undefined,
        to: !external && url ? dockInternalTarget(url, basePath.value) : undefined,
        active: isDockLinkActive(url, props.activeSlug),
      }
    }),
)

const row = computed(() => splitDockRow(buttons.value))
const folderOpen = ref(false)

/* Balloon press: squash on pointerdown, spring back — restarted per press the
   same way the OS shell does (class reset + reflow). */
const popping = ref<string | null>(null)
function press(key: string, event: PointerEvent) {
  if (event.button != null && event.button !== 0) return
  popping.value = key
}
function popEnd() {
  popping.value = null
}

function pressFolder() {
  folderOpen.value = !folderOpen.value
  press('__folder', new PointerEvent('pointerdown', { button: 0 }))
}

// One-time hint so newcomers learn what the dock is.
const TIP_KEY = 'pckt.wiki.dockTip.seen'
const showTip = ref(false)
onMounted(() => {
  try {
    if (!localStorage.getItem(TIP_KEY)) showTip.value = true
  } catch {
    showTip.value = false
  }
})
function dismissTip() {
  showTip.value = false
  try {
    localStorage.setItem(TIP_KEY, '1')
  } catch {
    // private mode: show again next visit
  }
}
</script>

<template>
  <div class="wikidock-wrap">
    <div v-if="showTip" class="wikidock-tip" role="status">
      <span>
        Every page of this wiki is one bubble away — and creators can share
        buttons to their own sections.
      </span>
      <button type="button" class="wikidock-tip-x" aria-label="Dismiss" @click="dismissTip">✕</button>
    </div>

    <nav class="wikidock" aria-label="Wiki dock">
      <template v-for="btn in row.inline" :key="btn.key">
        <RouterLink
          v-if="btn.to"
          :to="btn.to"
          class="wikidock-btn"
          :class="{ 'is-current': btn.active }"
          :aria-current="btn.active ? 'true' : undefined"
          :title="btn.label"
          :aria-label="btn.label"
          @pointerdown="press(btn.key, $event)"
        >
          <span
            class="wikidock-btn-bubble"
            :class="{ 'wikidock-btn-bubble--pop': popping === btn.key }"
            @animationend="popEnd"
          >
            <img v-if="btn.artUrl" :src="btn.artUrl" alt="" draggable="false" width="72" height="72" />
            <span
              v-else
              class="wikidock-btn-letter"
              :style="{ '--dock-accent': btn.accent }"
              aria-hidden="true"
              >{{ btn.label.charAt(0).toUpperCase() }}</span
            >
          </span>
          <span class="wikidock-btn-label">{{ btn.label }}</span>
        </RouterLink>
        <a
          v-else-if="btn.external"
          :href="btn.href"
          class="wikidock-btn"
          :title="btn.label"
          :aria-label="btn.label"
          target="_blank"
          rel="noopener noreferrer"
          @pointerdown="press(btn.key, $event)"
        >
          <span
            class="wikidock-btn-bubble"
            :class="{ 'wikidock-btn-bubble--pop': popping === btn.key }"
            @animationend="popEnd"
          >
            <img v-if="btn.artUrl" :src="btn.artUrl" alt="" draggable="false" width="72" height="72" />
            <span
              v-else
              class="wikidock-btn-letter"
              :style="{ '--dock-accent': btn.accent }"
              aria-hidden="true"
              >{{ btn.label.charAt(0).toUpperCase() }}</span
            >
          </span>
          <span class="wikidock-btn-label">{{ btn.label }}</span>
        </a>
        <span v-else class="wikidock-btn wikidock-btn--inert" :title="btn.label">
          <span class="wikidock-btn-bubble">
            <img v-if="btn.artUrl" :src="btn.artUrl" alt="" draggable="false" width="72" height="72" />
            <span
              v-else
              class="wikidock-btn-letter"
              :style="{ '--dock-accent': btn.accent }"
              aria-hidden="true"
              >{{ btn.label.charAt(0).toUpperCase() }}</span
            >
          </span>
          <span class="wikidock-btn-label">{{ btn.label }}</span>
        </span>
      </template>

      <button
        v-if="row.folder.length"
        type="button"
        class="wikidock-btn wikidock-folder"
        :aria-expanded="folderOpen"
        aria-label="More pages"
        title="More pages"
        @click="pressFolder"
      >
        <span
          class="wikidock-btn-bubble"
          :class="{ 'wikidock-btn-bubble--pop': popping === '__folder' }"
          @animationend="popEnd"
        >
          <img :src="menuArt" alt="" draggable="false" width="72" height="72" />
        </span>
        <span class="wikidock-btn-label">More</span>
      </button>
    </nav>

    <div v-if="folderOpen && row.folder.length" class="wikidock-folder-panel" role="menu">
      <template v-for="btn in row.folder" :key="btn.key">
        <RouterLink
          v-if="btn.to"
          :to="btn.to"
          class="wikidock-folder-item"
          role="menuitem"
          :aria-current="btn.active ? 'true' : undefined"
          @click="folderOpen = false"
        >
          <img v-if="btn.artUrl" :src="btn.artUrl" alt="" width="40" height="40" />
          <span v-else class="wikidock-folder-letter" :style="{ '--dock-accent': btn.accent }">{{
            btn.label.charAt(0).toUpperCase()
          }}</span>
          <span>{{ btn.label }}</span>
        </RouterLink>
        <a
          v-else-if="btn.external"
          :href="btn.href"
          class="wikidock-folder-item"
          role="menuitem"
          target="_blank"
          rel="noopener noreferrer"
          @click="folderOpen = false"
        >
          <img v-if="btn.artUrl" :src="btn.artUrl" alt="" width="40" height="40" />
          <span v-else class="wikidock-folder-letter" :style="{ '--dock-accent': btn.accent }">{{
            btn.label.charAt(0).toUpperCase()
          }}</span>
          <span>{{ btn.label }}</span>
        </a>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Ported from the Osean World OS shell (src/os.css) — dock tokens, bubble
   chrome, labels, balloon press, and the pink current-page ring. */
.wikidock-wrap {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  pointer-events: none;
}

.wikidock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: clamp(6px, 2vw, 14px);
  padding: 1px clamp(10px, 3vw, 18px) 7px;
}

.wikidock-btn {
  pointer-events: auto;
  position: relative;
  flex: 0 1 auto;
  width: var(--wikidock-btn, 48px);
  height: var(--wikidock-btn, 48px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 0;
  gap: 0;
  text-decoration: none;
  background: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

.wikidock-btn--inert {
  cursor: default;
}

.wikidock-btn-bubble {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 50%;
  overflow: visible;
  display: block;
  transform-origin: 50% 55%;
  will-change: transform;
}

.wikidock-btn-bubble img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
  background: transparent;
}

/* Letter bubbles for links without matching art — the OS framed-button look. */
.wikidock-btn-letter {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(to bottom, #ffffff, #e9e8e3);
  border: 2px solid #17171c;
  border-radius: 50%;
  box-shadow:
    0 0 0 3px #fff,
    0 0 0 5px rgba(23, 23, 28, 0.85);
  font-size: 17px;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 1px 0 rgba(23, 23, 28, 0.4);
  position: relative;
}

.wikidock-btn-letter::after {
  content: '';
  position: absolute;
  inset: 14%;
  border: 2px solid #17171c;
  border-radius: 50%;
  background: var(--dock-accent, #e8a200);
  z-index: -1;
}

/* balloon press: squash outward, then spring back */
.wikidock-btn-bubble--pop {
  animation: wikidock-balloon-press 480ms cubic-bezier(0.22, 1.4, 0.36, 1) both;
}

@keyframes wikidock-balloon-press {
  0% {
    transform: scale(1, 1);
  }
  22% {
    transform: scale(1.28, 0.72);
  }
  48% {
    transform: scale(0.9, 1.16);
  }
  72% {
    transform: scale(1.08, 0.94);
  }
  100% {
    transform: scale(1, 1);
  }
}

.wikidock-btn-label {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  font-size: calc(var(--wikidock-label-btn, 54px) * 0.18);
  letter-spacing: 0.12em;
  font-weight: 800;
  text-transform: uppercase;
  color: var(--pckt-text, #17171c);
  white-space: nowrap;
  line-height: 1;
  pointer-events: none;
}

/* current page: pink ring following the artwork's alpha edge */
.wikidock-btn.is-current .wikidock-btn-bubble img {
  filter: drop-shadow(1px 0 0 #e4007f) drop-shadow(-1px 0 0 #e4007f)
    drop-shadow(0 1px 0 #e4007f) drop-shadow(0 -1px 0 #e4007f);
}

.wikidock-btn.is-current .wikidock-btn-letter {
  box-shadow:
    0 0 0 3px #fff,
    0 0 0 5px #e4007f;
}

/* folder contents */
.wikidock-folder-panel {
  pointer-events: auto;
  position: absolute;
  left: 50%;
  bottom: calc(76px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  display: grid;
  grid-template-columns: repeat(2, minmax(150px, 1fr));
  gap: 0.25rem;
  padding: 0.5rem;
  background: var(--pckt-bg-elevated, #fff);
  border: 2px solid #17171c;
  border-radius: 14px;
  box-shadow: 0 6px 0 rgba(23, 23, 28, 0.16), 0 10px 24px rgba(23, 23, 28, 0.12);
  max-height: min(60vh, 420px);
  overflow-y: auto;
}

.wikidock-folder-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: 10px;
  text-decoration: none;
  color: var(--pckt-text, #17171c);
  font-size: 0.875rem;
  font-weight: 600;
}

.wikidock-folder-item:hover {
  background: color-mix(in srgb, var(--pckt-accent, #ff5d5b) 8%, transparent);
}

.wikidock-folder-item img,
.wikidock-folder-letter {
  width: 32px;
  height: 32px;
  object-fit: contain;
  flex: none;
}

.wikidock-folder-letter {
  display: grid;
  place-items: center;
  background: var(--dock-accent, #e8a200);
  border: 2px solid #17171c;
  border-radius: 50%;
  color: #fff;
  font-weight: 800;
  font-size: 14px;
}

.wikidock-folder-item[aria-current='true'] span:last-child {
  text-decoration: underline;
  text-decoration-color: #e4007f;
}

/* one-time hint */
.wikidock-tip {
  pointer-events: auto;
  position: absolute;
  left: 50%;
  bottom: calc(86px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: min(92vw, 420px);
  padding: 0.625rem 0.75rem;
  background: var(--pckt-bg-elevated, #fff);
  border: 1px solid var(--pckt-border);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  font-size: 0.8125rem;
}

.wikidock-tip-x {
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--pckt-text-muted);
  font-size: 0.875rem;
  padding: 0.125rem;
}

@media (max-width: 480px) {
  .wikidock {
    --wikidock-btn: 44px;
    --wikidock-label-btn: 44px;
  }

  .wikidock-folder-panel {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wikidock-btn-bubble--pop {
    animation: none;
  }
}
</style>
