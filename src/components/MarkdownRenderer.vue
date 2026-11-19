<script setup lang="ts">
import { stripBase } from '@/lib/base-url'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useInternalLinkNavigation } from '@/composables/useInternalLinkNavigation'
import { useLinkPreview, type LinkPreviewData } from '@/composables/useLinkPreview'
import LinkPreviewCard from '@/components/LinkPreviewCard.vue'
import { getSessionBlobPreview, resolveBlobSrcSync } from '@/lib/atproto/blobs'
import { resolvePdsUrl } from '@/lib/atproto/pds'
import { buildNotePreview } from '@/lib/link-preview'
import { resolveRedirectTarget } from '@/lib/lichen/content-meta'
import { renderMarkdown } from '@/lib/markdown'
import { useLichenStore } from '@/stores/lichen'
import type { LichenNoteWithContent } from '@/types/lichen'

const { onMarkdownClick } = useInternalLinkNavigation()
const lichen = useLichenStore()

const props = defineProps<{
  source: string
  wikiSlug?: string
  ownerHandle?: string
  ownerDid?: string
  wikiNotes?: LichenNoteWithContent[]
  /** Base heading-slug counts from an earlier chunk of the same article. */
  headingIdCounts?: Map<string, number>
  /** When true, headings get a Wikipedia-style section Edit control. */
  canEdit?: boolean
}>()

const emit = defineEmits<{
  edit: []
}>()

const rootEl = ref<HTMLElement | null>(null)

const existingSlugs = computed(() =>
  props.wikiNotes ? new Set(props.wikiNotes.map((note) => note.slug)) : undefined,
)

/** Bumps after the PDS cache warms so `blob:cid` images rewrite on the next render. */
const pdsReady = ref(0)

watch(
  () => props.ownerDid,
  (did) => {
    if (!did) return
    void resolvePdsUrl(did)
      .then(() => {
        pdsReady.value += 1
      })
      .catch(() => {
        /* keep unresolved blob: srcs until a later navigation warms the cache */
      })
  },
  { immediate: true },
)

const html = computed(() => {
  pdsReady.value
  return renderMarkdown(props.source, {
    wikiSlug: props.wikiSlug,
    ownerHandle: props.ownerHandle,
    ownerDid: props.ownerDid,
    existingSlugs: existingSlugs.value,
    wikiNotes: props.wikiNotes,
    headingIdCounts: props.headingIdCounts,
  })
})

const previewNotes = computed<LichenNoteWithContent[]>(() => {
  if (props.wikiNotes?.length) return props.wikiNotes
  // Callers that don't thread notes through still get previews for the open wiki.
  if (props.wikiSlug && lichen.currentWiki?.slug === props.wikiSlug) return lichen.notes
  return []
})

/** `/@handle/wiki/slug` inside the wiki being rendered — nothing else previews. */
function localNoteSlugFromHref(href: string): string | null {
  if (!href || href.startsWith('#')) return null
  let url: URL
  try {
    url = new URL(href, window.location.origin)
  } catch {
    return null
  }
  if (url.origin !== window.location.origin) return null

  const parts = stripBase(url.pathname).split('/').filter(Boolean)
  if (parts.length !== 3 || !parts[0].startsWith('@')) return null

  const handle = decodeURIComponent(parts[0].slice(1))
  if (props.ownerHandle && handle !== props.ownerHandle) return null
  if (props.wikiSlug && decodeURIComponent(parts[1]) !== props.wikiSlug) return null

  return decodeURIComponent(parts[2])
}

function resolvePreview(anchor: HTMLAnchorElement): LinkPreviewData | null {
  if (!anchor.classList.contains('wikilink')) return null

  const slug = localNoteSlugFromHref(anchor.getAttribute('href') ?? '')
  if (!slug) return null

  const notes = previewNotes.value
  const note =
    notes.find((item) => item.slug === slug) ??
    notes.find((item) => item.slug.toLowerCase() === slug.toLowerCase())
  if (!note) return { kind: 'missing', title: anchor.textContent?.trim() || slug }

  const target = resolveRedirectTarget(note, notes) ?? note
  return { kind: 'note', ...buildNotePreview(target) }
}

const {
  anchorEl: previewAnchor,
  preview,
  href: previewHref,
  onPointerOver,
  onPointerOut,
  onFocusIn,
  onFocusOut,
  onCardEnter,
  onCardLeave,
  close: closePreview,
} = useLinkPreview(resolvePreview)

const previewImageUrl = computed(() => {
  const data = preview.value
  if (!data || data.kind !== 'note' || !data.imageSrc) return undefined

  const src = data.imageSrc
  const sessionPreview = getSessionBlobPreview(src)
  if (sessionPreview) return sessionPreview
  const rewritten = props.ownerDid ? resolveBlobSrcSync(src, props.ownerDid) : null
  if (rewritten) return rewritten
  return /^https?:\/\//i.test(src) ? src : undefined
})

function onPreviewNavigate(event: MouseEvent) {
  onMarkdownClick(event)
  closePreview()
}

// A re-render replaces the anchors the open card was measured against.
watch(html, () => closePreview())

function markImageLoaded(img: HTMLImageElement) {
  img.classList.add('is-loaded')
  const frame = img.closest('.md-img-frame')
  if (frame instanceof HTMLElement) {
    frame.classList.add('is-loaded')
    // Keep forced crop aspect ratios; clear intrinsic placeholders so wrong
    // metadata never crops an uncropped image.
    const forcedCrop = frame.matches(
      '.md-img-crop--square, .md-img-crop--circle, .md-img-crop--wide, .md-img-crop--tall',
    )
    if (!forcedCrop) frame.style.aspectRatio = ''
  }
}

/**
 * Mark an image that was already loaded (cached / decoded) at bind time so it
 * appears instantly, skipping the opacity fade-in reserved for images still
 * streaming over the network.
 */
function markImageInstant(img: HTMLImageElement) {
  img.classList.add('is-loaded', 'is-instant')
  const frame = img.closest('.md-img-frame')
  if (frame instanceof HTMLElement) {
    frame.classList.add('is-loaded', 'is-instant')
    const forcedCrop = frame.matches(
      '.md-img-crop--square, .md-img-crop--circle, .md-img-crop--wide, .md-img-crop--tall',
    )
    if (!forcedCrop) frame.style.aspectRatio = ''
  }
}

function bindProgressiveImages(root: HTMLElement | null) {
  if (!root) return
  root.querySelectorAll<HTMLImageElement>('img.md-img-full, img.md-img-solo').forEach((img) => {
    if (img.dataset.progressiveBound === '1') return
    img.dataset.progressiveBound = '1'
    if (img.complete && img.naturalWidth > 0) {
      // Already decoded — show immediately, no fade.
      markImageInstant(img)
      return
    }
    img.addEventListener('load', () => markImageLoaded(img), { once: true })
    img.addEventListener('error', () => markImageLoaded(img), { once: true })
  })
}

/** Pull the masonry-marked image out of a lone wrapping `<p>` when present. */
function masonryItemFrom(node: Element): Element | null {
  if (node.classList.contains('md-img--masonry')) return node
  if (node.tagName === 'P' && node.children.length === 1) {
    const child = node.children[0]
    if (child.classList.contains('md-img--masonry')) return child
  }
  return null
}

/**
 * Consecutive masonry-tagged images become one column gallery. A single
 * masonry image stays in place until a neighbor joins it.
 */
function groupMasonryImages(root: HTMLElement | null) {
  if (!root) return

  const children = Array.from(root.children)
  let run: Element[] = []

  function gapClassFrom(item: Element): string {
    for (const gap of ['flush', 'sm', 'lg'] as const) {
      if (item.classList.contains(`md-img-gap--${gap}`)) return ` md-img-gap--${gap}`
    }
    return ''
  }

  function flush() {
    if (run.length < 2) {
      run = []
      return
    }
    const gallery = document.createElement('div')
    const firstItem = masonryItemFrom(run[0]!)
    gallery.className = `md-img-masonry${firstItem ? gapClassFrom(firstItem) : ''}`
    gallery.setAttribute('role', 'group')
    gallery.setAttribute('aria-label', 'Image gallery')
    run[0].parentElement?.insertBefore(gallery, run[0])
    for (const node of run) {
      const item = masonryItemFrom(node)
      if (item && item !== node) {
        gallery.appendChild(item)
        node.remove()
      } else if (item) {
        gallery.appendChild(item)
      } else {
        gallery.appendChild(node)
      }
    }
    run = []
  }

  for (const child of children) {
    if (masonryItemFrom(child)) run.push(child)
    else flush()
  }
  flush()
}

/** Classic Wikipedia: [edit] floated to the right of each section heading. */
function injectSectionEdits(root: HTMLElement | null) {
  if (!root) return
  root.querySelectorAll('.wiki-section-edit').forEach((node) => node.remove())
  if (!props.canEdit) return

  root.querySelectorAll<HTMLElement>('h2[id], h3[id]').forEach((heading) => {
    const wrap = document.createElement('span')
    wrap.className = 'wiki-section-edit'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'wiki-section-edit-btn'
    btn.dataset.wikiSectionEdit = '1'
    btn.title = 'Edit this section'
    btn.textContent = 'edit'
    wrap.appendChild(btn)
    heading.prepend(wrap)
  })
}

function onClick(event: MouseEvent) {
  const target = event.target
  if (target instanceof Element && target.closest('[data-wiki-section-edit]')) {
    event.preventDefault()
    event.stopPropagation()
    emit('edit')
    return
  }
  onMarkdownClick(event)
}

function enhanceRendered(root: HTMLElement | null) {
  groupMasonryImages(root)
  bindProgressiveImages(root)
  injectSectionEdits(root)
}

watch(
  [html, () => props.canEdit],
  async () => {
    await nextTick()
    enhanceRendered(rootEl.value)
  },
  { flush: 'post' },
)

onMounted(() => {
  enhanceRendered(rootEl.value)
})
</script>

<template>
  <div
    ref="rootEl"
    class="prose markdown-body"
    v-html="html"
    @click="onClick"
    @pointerover="onPointerOver"
    @pointerout="onPointerOut"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  />
  <LinkPreviewCard
    v-if="preview && previewAnchor"
    :preview="preview"
    :anchor-el="previewAnchor"
    :href="previewHref"
    :image-url="previewImageUrl"
    @enter="onCardEnter"
    @leave="onCardLeave"
    @navigate="onPreviewNavigate"
  />
</template>

<style scoped>
:deep(.wikilink) {
  color: var(--pckt-blue);
  font-weight: 600;
  text-decoration: none;
}

:deep(.wikilink:hover) {
  text-decoration: underline;
}

/* Wiki convention (as on Wikipedia): blue links exist; red + dashed means
   the page doesn't exist yet and is waiting to be written. */
:deep(.wikilink-missing) {
  color: var(--pckt-red);
  border-bottom: 1px dashed var(--pckt-red);
}

:deep(.wiki-section-edit) {
  float: right;
  margin-left: 0.75rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.6;
}

:deep(.wiki-section-edit-btn) {
  padding: 0;
  border: none;
  background: none;
  color: var(--pckt-text-muted);
  font: inherit;
  cursor: pointer;
}

:deep(.wiki-section-edit-btn:hover),
:deep(.wiki-section-edit-btn:focus-visible) {
  color: var(--pckt-text);
  text-decoration: underline;
  text-underline-offset: 0.15em;
  outline: none;
}

:deep(.md-img-frame) {
  position: relative;
  display: block;
  max-width: 100%;
  margin: 0.75em 0;
  /* Placeholder only while loading — transparent PNGs must not keep this tint. */
  background: color-mix(in srgb, var(--pckt-border) 18%, transparent);
  line-height: 0;
}

:deep(.md-img-frame:not(.is-loaded)) {
  /* Clip blurred LQIP only while loading; never crop the full image. */
  overflow: hidden;
}

:deep(.md-img-frame.is-loaded) {
  aspect-ratio: auto;
  background: transparent;
  overflow: visible;
}

/* Opt-in crop styles — default images stay natural (no round, no cover). */
:deep(.md-img-frame.md-img-crop--rounded),
:deep(img.md-img-solo.md-img-crop--rounded) {
  border-radius: var(--pckt-radius-sm);
  overflow: hidden;
}

:deep(.md-img-frame.md-img-crop--square),
:deep(.md-img-frame.md-img-crop--circle),
:deep(.md-img-frame.md-img-crop--wide),
:deep(.md-img-frame.md-img-crop--tall) {
  overflow: hidden;
  background: transparent;
}

:deep(.md-img-frame.md-img-crop--square),
:deep(.md-img-frame.md-img-crop--circle) {
  aspect-ratio: 1;
}

:deep(.md-img-frame.md-img-crop--wide) {
  aspect-ratio: 16 / 9;
}

:deep(.md-img-frame.md-img-crop--tall) {
  aspect-ratio: 3 / 4;
}

:deep(.md-img-frame.md-img-crop--circle) {
  border-radius: 50%;
}

:deep(.md-img-frame.md-img-crop--square.is-loaded),
:deep(.md-img-frame.md-img-crop--circle.is-loaded) {
  aspect-ratio: 1;
  overflow: hidden;
}

:deep(.md-img-frame.md-img-crop--wide.is-loaded) {
  aspect-ratio: 16 / 9;
  overflow: hidden;
}

:deep(.md-img-frame.md-img-crop--tall.is-loaded) {
  aspect-ratio: 3 / 4;
  overflow: hidden;
}

:deep(.md-img-frame.md-img-crop--square > .md-img-full),
:deep(.md-img-frame.md-img-crop--circle > .md-img-full),
:deep(.md-img-frame.md-img-crop--wide > .md-img-full),
:deep(.md-img-frame.md-img-crop--tall > .md-img-full),
:deep(.md-img-frame.md-img-crop--square > .md-img-lqip),
:deep(.md-img-frame.md-img-crop--circle > .md-img-lqip),
:deep(.md-img-frame.md-img-crop--wide > .md-img-lqip),
:deep(.md-img-frame.md-img-crop--tall > .md-img-lqip) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

:deep(.md-img-frame.md-img--center) {
  margin-inline: auto;
}

:deep(.md-img-frame.md-img--left) {
  float: left;
  margin: 0.25rem 1rem 0.75rem 0;
  max-width: min(100%, 20rem);
}

:deep(.md-img-frame.md-img--right) {
  float: right;
  margin: 0.25rem 0 0.75rem 1rem;
  max-width: min(100%, 20rem);
}

:deep(.md-img-frame.md-img-size--sm),
:deep(img.md-img-size--sm) {
  max-width: min(100%, 12rem);
}

:deep(.md-img-frame.md-img-size--md),
:deep(img.md-img-size--md) {
  max-width: min(100%, 20rem);
}

:deep(.md-img-frame.md-img-size--lg),
:deep(img.md-img-size--lg) {
  max-width: min(100%, 32rem);
}

:deep(.md-img-masonry) {
  --md-img-gap: 0.75rem;
  display: block;
  columns: 2 11rem;
  column-gap: var(--md-img-gap);
  margin: 0.75em 0;
}

:deep(.md-img-masonry.md-img-gap--flush) {
  --md-img-gap: 0;
}

:deep(.md-img-masonry.md-img-gap--sm) {
  --md-img-gap: 0.25rem;
}

:deep(.md-img-masonry.md-img-gap--lg) {
  --md-img-gap: 1.5rem;
}

:deep(.md-img-masonry > .md-img-frame),
:deep(.md-img-masonry > img.md-img-solo) {
  display: inline-block;
  width: 100%;
  max-width: 100%;
  margin: 0 0 var(--md-img-gap);
  float: none;
  break-inside: avoid;
  page-break-inside: avoid;
}

:deep(.md-img-masonry.md-img-gap--flush > .md-img-frame),
:deep(.md-img-masonry.md-img-gap--flush > img.md-img-solo) {
  border-radius: 0;
}

:deep(.md-img-frame > .md-img-full) {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: auto;
  max-width: 100%;
  opacity: 0;
  transition: opacity 0.35s ease;
  border-radius: 0;
}

:deep(.md-img-frame > .md-img-full.is-loaded) {
  opacity: 1;
}

/* Already-decoded images appear instantly; no fade-in. */
:deep(.md-img-frame > .md-img-full.is-instant),
:deep(.md-img-frame.is-instant > .md-img-full) {
  transition: none;
}

:deep(.md-img-frame > .md-img-lqip) {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: blur(16px);
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.35s ease;
}

:deep(.md-img-frame.is-loaded > .md-img-lqip) {
  opacity: 0;
}

:deep(.md-img-frame.is-instant > .md-img-lqip) {
  transition: none;
}

:deep(img.md-img-solo) {
  max-width: 100%;
  height: auto;
  background: color-mix(in srgb, var(--pckt-border) 18%, transparent);
  opacity: 0;
  transition: opacity 0.35s ease, background-color 0.35s ease;
}

:deep(img.md-img-solo.is-loaded) {
  opacity: 1;
  background: transparent;
}

:deep(img.md-img-solo.is-instant) {
  transition: none;
}

:deep(img.md-img-solo.md-img--center) {
  display: block;
  margin-inline: auto;
}

:deep(img.md-img-solo.md-img--left) {
  float: left;
  margin: 0.25rem 1rem 0.75rem 0;
  max-width: min(100%, 20rem);
}

:deep(img.md-img-solo.md-img--right) {
  float: right;
  margin: 0.25rem 0 0.75rem 1rem;
  max-width: min(100%, 20rem);
}

@media (max-width: 640px) {
  :deep(.md-img-frame.md-img--left),
  :deep(.md-img-frame.md-img--right),
  :deep(img.md-img-solo.md-img--left),
  :deep(img.md-img-solo.md-img--right) {
    float: none;
    display: block;
    margin-inline: auto;
    max-width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.md-img-frame > .md-img-full),
  :deep(.md-img-frame > .md-img-lqip),
  :deep(img.md-img-solo) {
    transition: none;
  }

  :deep(.md-img-frame > .md-img-full),
  :deep(img.md-img-solo) {
    opacity: 1;
  }

  :deep(.md-img-frame > .md-img-lqip) {
    display: none;
  }
}
</style>
