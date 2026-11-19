<script setup lang="ts">
import { RouterLink } from 'vue-router'
import type { RecentChange } from '@/lib/lichen/recent-changes'
import { formatDocumentDate } from '@/lib/standardsite/blog'

/** One row per article — listRecentChanges already dedupes and drops typos. */
defineProps<{
  changes: RecentChange[]
  ownerHandle: string
  wikiSlug: string
}>()
</script>

<template>
  <ul class="recent-list">
    <li v-for="change in changes" :key="change.note.uri">
      <div class="recent-head">
        <RouterLink
          class="recent-title"
          :to="`/@${ownerHandle}/${wikiSlug}/${change.note.slug}`"
        >
          {{ change.note.title }}
        </RouterLink>
        <span v-if="change.action === 'created'" class="recent-badge">New</span>
      </div>
      <span class="meta muted">
        {{ change.summary }}
        · {{ formatDocumentDate(change.revision.createdAt) }}
      </span>
    </li>
  </ul>
</template>

<style scoped>
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.recent-list li {
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--pckt-border);
}

.recent-list li:last-child {
  border-bottom: none;
}

.recent-head {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.recent-title {
  font-weight: 600;
}

.recent-badge {
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-pill);
  background: var(--pckt-bg-muted);
  color: var(--pckt-text-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.meta {
  display: block;
  font-size: 0.8125rem;
  margin-top: 0.15rem;
}
</style>
