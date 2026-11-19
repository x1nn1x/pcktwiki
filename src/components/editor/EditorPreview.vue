<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/lib/markdown'

const props = withDefaults(
  defineProps<{
    source: string
    ownerHandle?: string
    wikiSlug?: string
    /** Slugs that exist, so links to missing pages can be flagged. */
    knownSlugs?: string[]
  }>(),
  { knownSlugs: () => [] },
)

const html = computed(() =>
  renderMarkdown(props.source, {
    ownerHandle: props.ownerHandle,
    wikiSlug: props.wikiSlug,
    existingSlugs: props.knownSlugs.length ? new Set(props.knownSlugs) : undefined,
  }),
)

const isEmpty = computed(() => !props.source.trim())

/** Preview links are inert: following one would discard unsaved edits. */
function onClick(event: MouseEvent) {
  const link = (event.target as HTMLElement | null)?.closest('a')
  if (!link) return
  const href = link.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
    return
  }
  event.preventDefault()
}
</script>

<template>
  <div class="ep">
    <p v-if="isEmpty" class="ep-empty">Nothing to preview yet.</p>
    <div v-else class="prose markdown-body ep-body" v-html="html" @click="onClick" />
  </div>
</template>

<style scoped>
.ep {
  padding: 1.25rem clamp(1rem, 3vw, 1.75rem);
}

.ep-empty {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  color: var(--pckt-text-subtle);
}

.ep-body {
  font-size: 1rem;
}

.ep-body :deep(h1:first-child),
.ep-body :deep(h2:first-child),
.ep-body :deep(h3:first-child) {
  margin-top: 0;
}

.ep-body :deep(.wikilink) {
  color: var(--pckt-blue);
  font-weight: 600;
}

/* Wiki convention (as on Wikipedia): blue links exist; red + dashed means
   the page doesn't exist yet and is waiting to be written. */
.ep-body :deep(.wikilink-missing) {
  color: var(--pckt-red);
  border-bottom: 1px dashed var(--pckt-red);
}
</style>
