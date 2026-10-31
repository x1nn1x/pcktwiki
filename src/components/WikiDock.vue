<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  dockAccentFor,
  dockArtFor,
  dockInternalTarget,
  isDockLinkActive,
  isExternalDockUrl,
  type DockLink,
} from '@/lib/wiki-dock'

/**
 * Osean World OS bottom dock, ported for wiki views: floating bubble buttons
 * for the wiki's own navbar links (same editable `navbarLinks` the topbar
 * renders), with the balloon-press animation and the pink current-page ring.
 */
const props = defineProps<{
  links: DockLink[]
  ownerHandle: string
  wikiSlug: string
  /** Slug of the open article; empty on the wiki front page. */
  activeSlug?: string
}>()

const basePath = computed(() => `/@${props.ownerHandle}/${props.wikiSlug}`)

const buttons = computed(() =>
  props.links
    .filter((link) => link.label.trim())
    .map((link, index) => {
      const url = link.url?.trim() ?? ''
      const external = isExternalDockUrl(url)
      return {
        key: `${link.label}-${index}`,
        label: link.label.trim(),
        art: dockArtFor(link.label),
        accent: dockAccentFor(index),
        external,
        href: external ? url : undefined,
        to: !external && url ? dockInternalTarget(url, basePath.value) : undefined,
        active: isDockLinkActive(url, props.activeSlug),
      }
    }),
)

/* Balloon press: squash on pointerdown, spring back — restarted per press the
   same way the OS shell does (class reset + reflow). */
const popping = ref<string | null>(null)
function press(key: string, event: PointerEvent) {
  if (event.button != null && event.button !== 0) return
  popping.value = key
  requestAnimationFrame(() => {
    if (popping.value === key) return
  })
}
function popEnd() {
  popping.value = null
}
</script>

<template>
  <nav v-if="buttons.length" class="wikidock" aria-label="Wiki dock">
    <template v-for="btn in buttons" :key="btn.key">
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
          <img v-if="btn.art" :src="btn.art" alt="" draggable="false" width="72" height="72" />
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
          <img v-if="btn.art" :src="btn.art" alt="" draggable="false" width="72" height="72" />
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
          <img v-if="btn.art" :src="btn.art" alt="" draggable="false" width="72" height="72" />
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
  </nav>
</template>

<style scoped>
/* Ported from the Osean World OS shell (src/os.css) — dock tokens, bubble
   chrome, labels, balloon press, and the pink current-page ring. */
.wikidock {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  z-index: 30;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: clamp(6px, 2vw, 14px);
  padding: 1px clamp(10px, 3vw, 18px) 7px;
  pointer-events: none;
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

.wikidock-btn-letter {
  font-size: 17px;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 1px 0 rgba(23, 23, 28, 0.4);
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
.wikidock-btn.is-current .wikidock-btn-bubble img,
.wikidock-btn.is-current .wikidock-btn-letter::after {
  outline: none;
}

.wikidock-btn.is-current .wikidock-btn-bubble img {
  filter: drop-shadow(1px 0 0 #e4007f) drop-shadow(-1px 0 0 #e4007f)
    drop-shadow(0 1px 0 #e4007f) drop-shadow(0 -1px 0 #e4007f);
}

.wikidock-btn.is-current .wikidock-btn-letter {
  box-shadow:
    0 0 0 3px #fff,
    0 0 0 5px #e4007f;
}

@media (max-width: 480px) {
  .wikidock {
    --wikidock-btn: 44px;
    --wikidock-label-btn: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .wikidock-btn-bubble--pop {
    animation: none;
  }
}
</style>
