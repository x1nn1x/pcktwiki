<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { TocEntry } from '@/lib/toc'

defineProps<{
  entries: TocEntry[]
}>()

/**
 * Wikipedia keeps its Contents box expanded on desktop and collapsed on
 * mobile, where the article body leads. The box stays user-togglable either
 * way — the media query only seeds the initial state.
 */
const WIDE_QUERY = '(min-width: 1101px)'
const open = ref(true)
let wideMql: MediaQueryList | null = null

function syncOpen(): void {
  open.value = !!wideMql?.matches
}

onMounted(() => {
  wideMql = window.matchMedia(WIDE_QUERY)
  syncOpen()
  wideMql.addEventListener('change', syncOpen)
})

onUnmounted(() => {
  wideMql?.removeEventListener('change', syncOpen)
})
</script>

<template>
  <nav v-if="entries.length >= 2" class="toc" aria-label="Table of contents">
    <details class="toc-box" :open="open">
      <summary class="toc-summary">
        <span class="toc-title">Contents</span>
        <span class="toc-toggle" aria-hidden="true" />
      </summary>
      <ol class="toc-list">
        <li
          v-for="entry in entries"
          :key="entry.id"
          :class="`toc-level-${entry.level}`"
        >
          <a :href="`#${entry.id}`">{{ entry.text }}</a>
        </li>
      </ol>
    </details>
  </nav>
</template>

<style scoped>
/* Wikipedia's article-top box: hairline border, small heading, numbered
   entries, and a (hide)/(show) toggle in the header row. */
.toc {
  margin: 0 0 1.25rem;
}

.toc-box {
  display: inline-block;
  max-width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  font-size: 0.875rem;
}

.toc-summary {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.toc-summary::-webkit-details-marker {
  display: none;
}

.toc-title {
  font-weight: 700;
  color: var(--pckt-text);
}

/* Wikipedia renders the toggle as a small (hide)/(show) link. */
.toc-toggle::after {
  content: '(show)';
  font-size: 0.75rem;
  color: var(--pckt-blue-active);
}

.toc-box[open] .toc-toggle::after {
  content: '(hide)';
}

.toc-list {
  counter-reset: toc-h2;
  margin: 0;
  padding: 0.15rem 0.75rem 0.55rem 2.5rem;
  list-style: none;
}

.toc-list li {
  margin: 0.2rem 0;
  line-height: 1.35;
}

/* Wikipedia numbers entries hierarchically: 1, 1.1, 1.2, 2 … */
.toc-level-2 {
  counter-increment: toc-h2;
  counter-reset: toc-h3;
}

.toc-level-3 {
  counter-increment: toc-h3;
  padding-left: 1.25rem;
}

.toc-level-2::before {
  content: counter(toc-h2);
}

.toc-level-3::before {
  content: counter(toc-h2) '.' counter(toc-h3);
}

.toc-level-2::before,
.toc-level-3::before {
  display: inline-block;
  min-width: 1.4rem;
  color: var(--pckt-text);
}

.toc-list a {
  color: var(--pckt-text);
  text-decoration: none;
}

.toc-list a:hover {
  color: var(--pckt-red);
  text-decoration: underline;
}
</style>
