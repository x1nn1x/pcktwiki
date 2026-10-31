<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { visibilityLabel } from '@/lib/lichen/collections'
import {
  WIKI_TRASH_RETENTION_DAYS,
  formatWikiTrashCountdown,
} from '@/lib/lichen/wiki-trash'
import type { LichenWikiRecord } from '@/types/lichen'

const auth = useAuthStore()
const lichen = useLichenStore()
const initializing = ref(true)
const trashBusyUri = ref<string | null>(null)
const trashError = ref('')

const activeWikis = computed(() => lichen.activeWikis)
const trashedWikis = computed(() => lichen.trashedWikis)

// Launch checklist for the first wiki — everything here is computable from
// the owner's repo without loading each wiki's full contents.
const checkStats = ref<{ notes: number } | null>(null)

const checklist = computed(() => {
  const wiki = activeWikis.value[0]
  return {
    description: !!wiki?.description,
    logo: !!wiki?.headerImage,
    nav: (wiki?.navbarLinks?.length ?? 0) >= 2,
    pages: (checkStats.value?.notes ?? 0) >= 3,
  }
})

const checkNoteCount = computed(() => checkStats.value?.notes ?? 0)

onMounted(async () => {
  if (!auth.agent) return
  try {
    await lichen.loadOwnerWikis(auth.agent)
    await lichen.purgeExpiredTrashedWikis(auth.agent)
    if (auth.did) {
      const { loadDirectoryStats } = await import('@/lib/lichen/wiki-directory')
      const stats = await loadDirectoryStats([auth.did])
      checkStats.value = stats[auth.did] ?? null
    }
  } finally {
    initializing.value = false
  }
})

async function restore(wiki: LichenWikiRecord) {
  if (!auth.agent || trashBusyUri.value) return
  trashBusyUri.value = wiki.uri
  trashError.value = ''
  try {
    await lichen.restoreWiki(auth.agent, wiki)
  } catch (err) {
    trashError.value = err instanceof Error ? err.message : 'Could not restore wiki'
  } finally {
    trashBusyUri.value = null
  }
}

async function purgeForever(wiki: LichenWikiRecord) {
  if (!auth.agent || trashBusyUri.value) return
  if (!confirm(`Permanently delete “${wiki.name}”? This cannot be undone.`)) return
  trashBusyUri.value = wiki.uri
  trashError.value = ''
  try {
    await lichen.purgeWiki(auth.agent, wiki)
  } catch (err) {
    trashError.value = err instanceof Error ? err.message : 'Could not delete wiki'
  } finally {
    trashBusyUri.value = null
  }
}
</script>

<template>
  <div class="dashboard">
    <div class="dashboard-inner">
      <header class="dashboard-header">
        <div>
          <h1>My wikis</h1>
          <p class="muted">@{{ auth.handle }} · Lichen records on your PDS</p>
        </div>
        <RouterLink to="/wiki/new" class="btn btn-primary">Create wiki</RouterLink>
      </header>

      <div v-if="initializing || lichen.loading" class="muted">Loading wikis…</div>
      <div v-else-if="lichen.error" class="error-text">{{ lichen.error }}</div>

      <template v-else>
        <div v-if="activeWikis.length" class="checklist card">
          <h2>Launch checklist</h2>
          <p class="muted">
            A wiki feels alive once these are done — finish them for
            <strong>{{ activeWikis[0]!.name }}</strong> and it's ready to share.
          </p>
          <ul class="checklist-items">
            <li :class="{ done: checklist.description }">
              <span class="checklist-mark">{{ checklist.description ? '✓' : '○' }}</span>
              <span>Write a one-line description</span>
              <RouterLink class="btn btn-ghost btn-sm" :to="`/@${auth.handle}/${activeWikis[0]!.slug}/settings`">
                Add
              </RouterLink>
            </li>
            <li :class="{ done: checklist.logo }">
              <span class="checklist-mark">{{ checklist.logo ? '✓' : '○' }}</span>
              <span>Add a header logo</span>
              <RouterLink class="btn btn-ghost btn-sm" :to="`/@${auth.handle}/${activeWikis[0]!.slug}/settings`">
                Add
              </RouterLink>
            </li>
            <li :class="{ done: checklist.nav }">
              <span class="checklist-mark">{{ checklist.nav ? '✓' : '○' }}</span>
              <span>Pick your dock buttons (2+ navbar links)</span>
              <RouterLink class="btn btn-ghost btn-sm" :to="`/@${auth.handle}/${activeWikis[0]!.slug}/settings`">
                Choose
              </RouterLink>
            </li>
            <li :class="{ done: checklist.pages }">
              <span class="checklist-mark">{{ checklist.pages ? '✓' : '○' }}</span>
              <span>Write at least 3 pages <span class="muted">({{ checkNoteCount }} so far)</span></span>
              <RouterLink class="btn btn-ghost btn-sm" :to="`/@${auth.handle}/${activeWikis[0]!.slug}`">
                Write
              </RouterLink>
            </li>
          </ul>
        </div>

        <div v-if="activeWikis.length === 0" class="empty card">
          <h2>No wikis yet</h2>
          <p class="muted">Create your first wiki using Lichen lexicons. It will interoperate with lichen.wiki.</p>
          <RouterLink to="/wiki/new" class="btn btn-primary">Create wiki</RouterLink>
        </div>

        <ul v-else class="wiki-list">
          <li v-for="wiki in activeWikis" :key="wiki.uri" class="wiki-item card">
            <div>
              <strong>{{ wiki.name }}</strong>
              <span class="slug">/{{ wiki.slug }}</span>
              <span class="badge">{{ visibilityLabel(wiki.visibility) }}</span>
            </div>
            <div class="actions">
              <RouterLink
                :to="`/@${auth.handle}/${wiki.slug}`"
                class="btn btn-secondary"
              >
                Open
              </RouterLink>
              <RouterLink
                :to="`/@${auth.handle}/${wiki.slug}/settings`"
                class="btn btn-ghost"
              >
                Settings
              </RouterLink>
            </div>
          </li>
        </ul>

        <section v-if="trashedWikis.length" class="trash-section">
          <header class="trash-header">
            <h2>Recently deleted</h2>
            <p class="muted">
              Restorable for {{ WIKI_TRASH_RETENTION_DAYS }} days, then permanently removed.
            </p>
          </header>
          <p v-if="trashError" class="error-text">{{ trashError }}</p>
          <ul class="wiki-list">
            <li v-for="wiki in trashedWikis" :key="wiki.uri" class="wiki-item card trash-item">
              <div>
                <strong>{{ wiki.name }}</strong>
                <span class="slug">/{{ wiki.slug }}</span>
                <span class="badge badge-trash">{{ formatWikiTrashCountdown(wiki) }}</span>
              </div>
              <div class="actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  :disabled="trashBusyUri === wiki.uri"
                  @click="restore(wiki)"
                >
                  {{ trashBusyUri === wiki.uri ? 'Working…' : 'Restore' }}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  :disabled="trashBusyUri === wiki.uri"
                  @click="purgeForever(wiki)"
                >
                  Delete forever
                </button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  padding: 2rem 1.25rem 4rem;
}

.dashboard-inner {
  max-width: 900px;
  margin: 0 auto;
}

.dashboard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
  flex-wrap: wrap;
}

.dashboard-header h1 {
  margin: 0 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.empty {
  padding: 1.5rem;
}

.wiki-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}

.wiki-item {
  padding: 1rem 1.25rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.slug {
  margin-left: 0.5rem;
  color: var(--pckt-text-subtle);
  font-size: 0.875rem;
}

.badge {
  margin-left: 0.5rem;
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--pckt-accent-soft);
  color: var(--pckt-red);
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  font-weight: 700;
}

.badge-trash {
  text-transform: none;
  letter-spacing: 0;
  background: color-mix(in srgb, var(--pckt-danger) 12%, transparent);
  color: var(--pckt-danger);
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.trash-section {
  margin-top: 2.5rem;
}

.trash-header {
  margin-bottom: 0.75rem;
}

.trash-header h2 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-family: var(--pckt-font-ui);
}

.trash-item {
  opacity: 0.92;
  border-style: dashed;
}

.checklist {
  padding: 1rem 1.25rem;
  border-color: color-mix(in srgb, var(--pckt-accent, var(--pckt-red)) 30%, var(--pckt-border));
}

.checklist h2 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.checklist > p {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
}

.checklist-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.375rem;
}

.checklist-items li {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.3rem 0;
  font-size: 0.875rem;
}

.checklist-items li.done {
  color: var(--pckt-text-muted);
  text-decoration: line-through;
}

.checklist-mark {
  width: 1.25rem;
  text-align: center;
  color: var(--pckt-accent, var(--pckt-red));
}

.checklist-items .btn {
  margin-left: auto;
}
</style>
