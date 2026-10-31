<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { listTimelineEvents } from '@/lib/lichen/timeline'

const route = useRoute()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const events = computed(() => listTimelineEvents(lichen.notes))

async function load() {
  await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  // This page reads deep history, which page views load newest-first.
  await lichen.ensureFullHistory(auth.agent)
}

onMounted(load)
watch(() => route.fullPath, load)
</script>

<template>
  <div class="timeline-page">
    <div class="inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Timeline</h1>
        <p class="muted">Events ordered by frontmatter <code>date</code> / <code>era</code>.</p>
      </header>

      <ol v-if="events.length" class="timeline">
        <li v-for="event in events" :key="event.note.uri">
          <div class="when">
            <strong v-if="event.date">{{ event.date }}</strong>
            <span v-if="event.era" class="muted">{{ event.era }}</span>
          </div>
          <RouterLink :to="`/@${handle}/${wikiSlug}/${event.note.slug}`">
            {{ event.note.title }}
          </RouterLink>
        </li>
      </ol>
      <p v-else class="muted">
        Add notes with <code>template: event</code> and a <code>date:</code> or <code>era:</code> field.
      </p>
    </div>
  </div>
</template>

<style scoped>
.timeline-page {
  padding: 2rem 1.25rem 4rem;
}

.inner {
  max-width: 720px;
  margin: 0 auto;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.timeline {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  border-left: 2px solid var(--pckt-border);
}

.timeline li {
  padding: 0.75rem 0 0.75rem 1.25rem;
  position: relative;
}

.timeline li::before {
  content: '';
  position: absolute;
  left: -5px;
  top: 1.1rem;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pckt-red);
}

.when {
  display: flex;
  gap: 0.5rem;
  font-size: 0.8125rem;
  margin-bottom: 0.2rem;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.85em;
}
</style>
