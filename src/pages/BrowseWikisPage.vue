<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import WikiPortalBox from '@/components/WikiPortalBox.vue'
import WikiAvatar from '@/components/WikiAvatar.vue'
import WikiPortalColumns from '@/components/WikiPortalColumns.vue'
import GuestFeedList from '@/components/guest-feed/GuestFeedList.vue'
import { useGuestFeed } from '@/composables/useGuestFeed'
import GlobalWikiSearch from '@/components/GlobalWikiSearch.vue'
import { wikiPath } from '@/data/featured-wikis'
import { useFeaturedWikis } from '@/composables/useFeaturedWikis'
import { discoverRecentWikis, type DiscoveredWiki } from '@/lib/constellation/wiki-discovery'
import {
  loadDirectoryStats,
  loadWikiDirectory,
  type DirectoryWiki,
} from '@/lib/lichen/wiki-directory'
import { remixWiki } from '@/lib/lichen/fork-wiki'
import { useAuthStore } from '@/stores/auth'

const { stats, sortedWikis } = useFeaturedWikis()
const auth = useAuthStore()
const router = useRouter()
const tab = ref<'all' | 'featured' | 'recent' | 'topics'>('all')
const discovered = ref<DiscoveredWiki[]>([])

const guestFeed = useGuestFeed()

// Live directory — every public wiki the relay knows about, with live
// article counts and last-activity dates instead of a curated list.
const directory = ref<DirectoryWiki[]>([])
const directoryStats = ref<Record<string, { notes: number; lastActivity: string | null }>>({})
const directoryLoading = ref(false)
const search = ref('')
const remixing = ref('')
const remixError = ref('')

onMounted(() => {
  void guestFeed.load()
  void discoverRecentWikis().then((items) => {
    discovered.value = items
  })
  void loadLiveDirectory()
})

async function loadLiveDirectory() {
  directoryLoading.value = true
  try {
    const wikis = await loadWikiDirectory()
    directory.value = wikis
    const dids = [...new Set(wikis.map((w) => w.did).filter(Boolean))]
    directoryStats.value = await loadDirectoryStats(dids)
  } catch {
    // the directory tab simply stays empty on failure
  } finally {
    directoryLoading.value = false
  }
}

const allWikis = computed(() => {
  const query = search.value.trim().toLowerCase()
  const rows = directory.value.filter((wiki) => {
    if (!query) return true
    return (
      wiki.name.toLowerCase().includes(query) ||
      wiki.slug.toLowerCase().includes(query) ||
      wiki.handle.toLowerCase().includes(query) ||
      wiki.description.toLowerCase().includes(query)
    )
  })
  return rows.sort((a, b) => {
    const aAt = directoryStats.value[a.did]?.lastActivity ?? ''
    const bAt = directoryStats.value[b.did]?.lastActivity ?? ''
    return bAt.localeCompare(aAt) || a.name.localeCompare(b.name)
  })
})

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return '—'
  const days = Math.floor(diff / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

const remixDone = ref('')
async function remix(target: DirectoryWiki) {
  if (!auth.agent) {
    router.push({ name: 'home', query: { redirect: '/wikis' } })
    return
  }
  const key = `${target.handle}/${target.slug}`
  remixing.value = key
  remixError.value = ''
  try {
    const wiki = await remixWiki(auth.agent, target.handle, target.slug, {
      forkHandle: auth.handle ?? '',
    })
    remixDone.value = `Remixed as ${wiki.slug} — opening it…`
    await router.push(`/@${auth.handle}/${wiki.slug}`)
  } catch (err) {
    remixError.value = err instanceof Error ? err.message : 'Could not remix that wiki'
  } finally {
    remixing.value = ''
  }
}
</script>

<template>
  <div class="wiki-portal">
    <div class="wiki-portal-inner">
      <header class="wiki-portal-welcome" data-kb-section aria-label="Welcome">
        <h1 class="wiki-portal-title">Welcome to public wikis</h1>
        <p class="wiki-portal-tagline">
          Shared knowledge on the open social web — readable here on pckt.wiki, stored as Lichen
          records in each author's PDS.
        </p>
        <GlobalWikiSearch class="wiki-portal-search" input-id="browse-wiki-search" />
        <ul class="wiki-portal-stats" aria-label="Directory statistics">
          <li>
            <strong>{{ stats.wikiCount }}</strong>
            public wikis
          </li>
          <li>
            <strong>{{ stats.noteCount }}</strong>
            articles
          </li>
          <li>
            <strong>{{ stats.contributorCount }}</strong>
            authors
          </li>
        </ul>
      </header>

      <div data-kb-section aria-label="Featured columns">
        <WikiPortalColumns class="wiki-portal-columns-block" />
      </div>

      <WikiPortalBox
        title="Latest to learn"
        accent="blue"
        class="wiki-portal-feed"
        data-kb-section
        aria-label="Latest updates"
      >
        <p class="feed-intro muted">
          Live updates from curated guest-feed wikis across different PDS hosts.
          <RouterLink to="/learn">Open full learn feed →</RouterLink>
        </p>
        <div v-if="guestFeed.loading.value" class="muted">Loading updates…</div>
        <GuestFeedList
          v-else-if="guestFeed.snapshot.value?.items.length"
          :items="guestFeed.snapshot.value.items"
          :limit="6"
          compact
        />
        <p v-else class="muted">No recent updates yet.</p>
      </WikiPortalBox>

      <WikiPortalBox
        title="Wiki directory"
        accent="blue"
        class="wiki-portal-directory"
        data-kb-section
        aria-label="Wiki directory"
      >
        <div class="directory-tabs">
          <button
            v-for="option in ['all', 'featured', 'recent', 'topics'] as const"
            :key="option"
            type="button"
            class="btn btn-ghost btn-sm"
            :class="{ active: tab === option }"
            @click="tab = option"
          >
            {{ option === 'all' ? 'All wikis' : option === 'featured' ? 'Featured' : option === 'recent' ? 'Recently active' : 'Topics' }}
          </button>
        </div>

        <template v-if="tab === 'all'">
          <input
            v-model="search"
            class="input directory-search"
            type="search"
            placeholder="Search every public wiki on the network…"
            aria-label="Search the wiki directory"
          />
          <div v-if="directoryLoading" class="muted">Crawling the network…</div>
          <template v-else>
            <p class="directory-intro muted">
              {{ allWikis.length }} wikis, newest activity first. Remix any of them into your
              own editable copy.
            </p>
            <p v-if="remixDone" class="muted">{{ remixDone }}</p>
            <p v-if="remixError" class="error-text">{{ remixError }}</p>
            <ul class="directory-grid">
              <li v-for="wiki in allWikis" :key="`${wiki.handle}-${wiki.slug}`">
                <div class="directory-item directory-item--live">
                  <RouterLink :to="wikiPath(wiki.handle, wiki.slug)" class="directory-item-main">
                    <WikiAvatar
                      :handle="wiki.handle"
                      :name="wiki.name"
                      :seed="wiki.slug"
                      :accent-color="wiki.accentColor"
                      :size="40"
                    />
                    <span class="directory-item-copy">
                      <span class="directory-item-name">{{ wiki.name }}</span>
                      <span class="directory-item-meta">
                        @{{ wiki.handle }}
                        · {{ directoryStats[wiki.did]?.notes ?? 0 }} articles
                        · updated {{ relativeTime(directoryStats[wiki.did]?.lastActivity) }}
                      </span>
                      <span v-if="wiki.description" class="directory-item-desc">{{ wiki.description }}</span>
                    </span>
                  </RouterLink>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="remixing === `${wiki.handle}/${wiki.slug}`"
                    :title="`Fork @${wiki.handle}/${wiki.slug} into your own editable wiki`"
                    @click="remix(wiki)"
                  >
                    {{ remixing === `${wiki.handle}/${wiki.slug}` ? 'Remixing…' : 'Remix' }}
                  </button>
                </div>
              </li>
            </ul>
            <p v-if="!allWikis.length" class="muted">No wikis match “{{ search }}”.</p>
          </template>
        </template>

        <ul v-else-if="tab === 'featured'" class="directory-grid">
          <li v-for="wiki in sortedWikis" :key="`${wiki.handle}-${wiki.slug}`">
            <RouterLink :to="wikiPath(wiki.handle, wiki.slug)" class="directory-item">
              <WikiAvatar
                :handle="wiki.handle"
                :name="wiki.name"
                :seed="wiki.slug"
                :accent-color="wiki.accentColor"
                :size="40"
              />
              <span class="directory-item-copy">
                <span class="directory-item-name">{{ wiki.name }}</span>
                <span class="directory-item-meta">
                  @{{ wiki.handle }} · {{ wiki.language }} · {{ wiki.noteCount }} articles
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>

        <ul v-else-if="tab === 'recent'" class="directory-grid">
          <li v-for="wiki in discovered.filter((w) => w.source === 'recent')" :key="`${wiki.handle}-${wiki.slug}`">
            <RouterLink :to="wikiPath(wiki.handle, wiki.slug)" class="directory-item">
              <WikiAvatar
                :handle="wiki.handle"
                :name="wiki.name"
                :seed="wiki.slug"
                :accent-color="'#ff5d5b'"
                :size="40"
              />
              <span class="directory-item-copy">
                <span class="directory-item-name">{{ wiki.name }}</span>
                <span class="directory-item-meta">
                  @{{ wiki.handle }} · {{ wiki.noteCount }} articles
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>

        <div v-else class="topics-placeholder">
          <p class="muted">
            Topic browse uses the guest feed taxonomy.
            <RouterLink to="/learn">Open learn feed →</RouterLink>
          </p>
        </div>
      </WikiPortalBox>

      <section class="wiki-portal-explore" data-kb-section aria-label="Explore more">
        <h2 class="wiki-portal-explore-title">Other ways to explore</h2>
        <ul class="wiki-portal-explore-grid">
          <li>
            <RouterLink to="/" class="explore-card">
              <span class="explore-card-label">Start writing</span>
              <span class="explore-card-text">Sign in and create your own wiki on your PDS.</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/wiki/new" class="explore-card">
              <span class="explore-card-label">Create a wiki</span>
              <span class="explore-card-text">Spin up a wiki on your PDS in a few steps.</span>
            </RouterLink>
          </li>
          <li>
            <a
              href="https://pckt.blog"
              target="_blank"
              rel="noopener noreferrer"
              class="explore-card"
            >
              <span class="explore-card-label">pckt.blog</span>
              <span class="explore-card-text">Sister app for long-form writing on AT Protocol.</span>
            </a>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wiki-portal {
  background: #fbf4e3;
  padding: 2rem 1.5rem 5rem;
  min-height: calc(100dvh - 3rem);
}

[data-theme='dark'] .wiki-portal {
  background: #1d1a15;
}

.wiki-portal-inner {
  max-width: 68rem;
  margin: 0 auto;
}

.wiki-portal-welcome {
  margin-bottom: 2rem;
  text-align: center;
}

.wiki-portal-feed {
  margin-bottom: 1rem;
}

.feed-intro {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  line-height: 1.5;
}

.feed-intro a {
  font-weight: 700;
  color: var(--pckt-red);
  text-decoration: none;
}

.feed-intro a:hover {
  text-decoration: underline;
}

.wiki-portal-title {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: clamp(2rem, 4.5vw, 2.875rem);
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.wiki-portal-search {
  margin: 1.25rem auto 0;
  max-width: 36rem;
}

.wiki-portal-tagline {
  margin: 0.875rem auto 0;
  max-width: 40rem;
  font-family: var(--pckt-font-content);
  font-size: 1.0625rem;
  line-height: 1.6;
  color: rgba(17, 24, 39, 0.78);
}

@media (min-width: 768px) {
  .wiki-portal-tagline {
    font-size: 1.125rem;
  }
}

[data-theme='dark'] .wiki-portal-tagline {
  color: rgba(249, 250, 251, 0.78);
}

.wiki-portal-stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem 1.25rem;
  margin: 1.25rem 0 0;
  padding: 0;
  list-style: none;
  font-family: var(--pckt-font-ui);
  font-size: 0.9375rem;
  color: var(--pckt-text-muted);
}

.wiki-portal-stats strong {
  color: var(--pckt-text);
  font-weight: 800;
}

.wiki-portal-columns-block {
  margin-bottom: 1rem;
}

.wiki-portal-directory {
  margin-bottom: 2rem;
}

.directory-tabs {
  display: flex;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.directory-tabs .active {
  background: var(--pckt-accent);
  color: white;
}

.topics-placeholder {
  padding: 0.5rem 0;
}

.directory-intro {
  margin: 0 0 1rem;
  font-size: 0.875rem;
}

.directory-grid {
  display: grid;
  gap: 0.625rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 640px) {
  .directory-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (min-width: 1024px) {
  .directory-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.directory-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid #eadfce;
  border-radius: var(--pckt-radius-sm);
  background: color-mix(in srgb, #fff 80%, #fbf4e3);
  color: inherit;
  text-decoration: none;
  transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

[data-theme='dark'] .directory-item {
  border-color: #3a3025;
  background: rgba(17, 24, 39, 0.35);
}

.directory-item:hover {
  background: color-mix(in srgb, var(--pckt-blue) 6%, #fff);
  border-color: color-mix(in srgb, var(--pckt-blue) 25%, #dccaa4);
  transform: translateY(-1px);
  text-decoration: none;
}

[data-theme='dark'] .directory-item:hover {
  background: color-mix(in srgb, var(--pckt-blue) 12%, #1f2937);
}

.directory-item-copy {
  min-width: 0;
}

.directory-item-name {
  display: block;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.25;
}

.directory-item-meta {
  display: block;
  margin-top: 0.125rem;
  font-size: 0.75rem;
  color: var(--pckt-text-muted);
}

.wiki-portal-explore-title {
  margin: 0 0 1rem;
  font-family: var(--pckt-font-ui);
  font-size: 1.25rem;
  font-weight: 800;
  text-align: center;
}

.wiki-portal-explore-grid {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (min-width: 768px) {
  .wiki-portal-explore-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.explore-card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  height: 100%;
  padding: 1rem;
  border: 1px solid #dccaa4;
  border-radius: var(--pckt-radius-btn);
  background: #fff;
  color: inherit;
  text-decoration: none;
  transition: background-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
}

[data-theme='dark'] .explore-card {
  border-color: #3a3025;
  background: rgba(31, 41, 55, 0.55);
}

.explore-card:hover {
  background: color-mix(in srgb, var(--pckt-green) 6%, #fff);
  transform: translateY(-2px);
  box-shadow: var(--pckt-shadow-xs);
  text-decoration: none;
}

[data-theme='dark'] .explore-card:hover {
  background: color-mix(in srgb, var(--pckt-green) 10%, #1f2937);
}

.explore-card-label {
  font-family: var(--pckt-font-ui);
  font-size: 0.9375rem;
  font-weight: 800;
  color: var(--pckt-blue);
}

.explore-card-text {
  font-size: 0.875rem;
  line-height: 1.5;
  color: var(--pckt-text-muted);
}

.directory-item--live {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: space-between;
  width: 100%;
}

.directory-item-main {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-width: 0;
  text-decoration: none;
  color: inherit;
}

.directory-item-desc {
  display: block;
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46ch;
}

.directory-search {
  width: 100%;
  margin-bottom: 0.75rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
  font: inherit;
  box-sizing: border-box;
}
</style>
