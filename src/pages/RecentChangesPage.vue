<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { listRecentChanges } from '@/lib/lichen/recent-changes'
import RecentChangesList from '@/components/RecentChangesList.vue'

const route = useRoute()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)

async function load() {
  await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
}

onMounted(load)
watch(() => route.fullPath, load)

const changes = computed(() =>
  listRecentChanges(lichen.revisions, lichen.notes, 50),
)
</script>

<template>
  <div class="recent-page">
    <div class="recent-inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Recent changes</h1>
        <p class="muted">Latest meaningful edits — one row per article</p>
      </header>

      <div v-if="lichen.loading" class="muted">Loading…</div>
      <div v-else class="card recent-card">
        <RecentChangesList
          :changes="changes"
          :owner-handle="handle"
          :wiki-slug="wikiSlug"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.recent-page {
  padding: 2rem 1.25rem 4rem;
}

.recent-inner {
  max-width: 720px;
  margin: 0 auto;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.recent-card {
  padding: 1.25rem;
  margin-top: 1.5rem;
}
</style>
