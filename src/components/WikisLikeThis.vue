<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import WikiAvatar from '@/components/WikiAvatar.vue'
import { fetchLinksAll } from '@/lib/constellation/client'
import { loadWikiDirectory, type DirectoryWiki } from '@/lib/lichen/wiki-directory'
import { wikiPath } from '@/data/featured-wikis'

/**
 * The webring, modernized: "wikis like this one" — every wiki whose records
 * link to this wiki (forks, copies, cross-wiki wikilinks), straight from
 * Constellation, no curation required. Admins can still pin favorites later.
 */
const props = defineProps<{
  wikiUri: string
  handle: string
  slug: string
}>()

const related = ref<DirectoryWiki[]>([])
const loading = ref(true)

const cards = computed(() =>
  related.value.filter((w) => !(w.handle === props.handle && w.slug === props.slug)).slice(0, 6),
)

onMounted(async () => {
  try {
    const links = await fetchLinksAll(props.wikiUri)
    const dids = new Set<string>()
    for (const [collection, sources] of Object.entries(links.links ?? {})) {
      if (!collection.includes('wiki.lichen')) continue
      for (const did of Object.keys(sources)) dids.add(did)
    }
    const directory = await loadWikiDirectory()
    related.value = directory.filter((w) => dids.has(w.did))
  } catch {
    // the widget simply stays empty when the graph is unreachable
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <section v-if="loading || cards.length" class="wikiring card" aria-label="Wikis like this one">
    <h2 class="wikiring-title">Wikis like this one</h2>
    <p class="muted wikiring-sub">
      Part of this wiki's webring — wikis that link to it across the network.
    </p>
    <p v-if="loading" class="muted">Following links…</p>
    <ul v-else class="wikiring-grid">
      <li v-for="wiki in cards" :key="`${wiki.handle}-${wiki.slug}`">
        <RouterLink :to="wikiPath(wiki.handle, wiki.slug)" class="wikiring-item">
          <WikiAvatar
            :handle="wiki.handle"
            :name="wiki.name"
            :seed="wiki.slug"
            :accent-color="wiki.accentColor"
            :size="36"
          />
          <span class="wikiring-copy">
            <span class="wikiring-name">{{ wiki.name }}</span>
            <span class="wikiring-meta">@{{ wiki.handle }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.wikiring {
  padding: 1rem 1.25rem;
  margin-top: 1rem;
}

.wikiring-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.wikiring-sub {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
}

.wikiring-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.375rem;
}

.wikiring-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--pckt-radius-sm);
  text-decoration: none;
  color: inherit;
}

.wikiring-item:hover {
  background: color-mix(in srgb, var(--pckt-accent, var(--pckt-red)) 7%, transparent);
}

.wikiring-copy {
  display: grid;
  min-width: 0;
}

.wikiring-name {
  font-size: 0.875rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wikiring-meta {
  font-size: 0.75rem;
  color: var(--pckt-text-muted);
}
</style>
