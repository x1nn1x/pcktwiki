<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import WikiAvatar from '@/components/WikiAvatar.vue'
import GuestFeedList from '@/components/guest-feed/GuestFeedList.vue'
import { useGuestFeed } from '@/composables/useGuestFeed'
import GlobalWikiSearch from '@/components/GlobalWikiSearch.vue'
import { wikiPath } from '@/data/featured-wikis'
import { useFeaturedWikis } from '@/composables/useFeaturedWikis'
import { useWatchlist } from '@/composables/useWatchlist'
import { discoverRecentWikis, type DiscoveredWiki } from '@/lib/constellation/wiki-discovery'
import {
  loadDirectoryStats,
  loadWikiDirectory,
  type DirectoryWiki,
} from '@/lib/lichen/wiki-directory'
import { listBookmarks } from '@/lib/lichen/bookmarks'
import { remixWiki } from '@/lib/lichen/fork-wiki'
import { useAuthStore } from '@/stores/auth'

/**
 * Explore — the discovery page, modeled on pckt.blog's explore view:
 * a rotating "Wiki of the day" hero, the live community feed, and a
 * right rail of ways in (hot, fresh, subscribed, starred).
 */

type ExploreChip = 'explore' | 'hot' | 'fresh' | 'featured'

const { stats, sortedWikis } = useFeaturedWikis()
const auth = useAuthStore()
const router = useRouter()
const chip = ref<ExploreChip>('explore')

const guestFeed = useGuestFeed()
const { wikis: subscribedWikis, sync: syncWatchlist } = useWatchlist()

const discovered = ref<DiscoveredWiki[]>([])
const directory = ref<DirectoryWiki[]>([])
const directoryStats = ref<Record<string, { notes: number; lastActivity: string | null }>>({})
const directoryLoading = ref(false)
const search = ref('')
const remixing = ref('')
const remixDone = ref('')
const remixError = ref('')
const starred = ref<Array<{ uri: string; wikiRef: string }>>([])

const today = new Date().toLocaleDateString(undefined, {
  month: 'long',
  day: 'numeric',
})

onMounted(() => {
  void guestFeed.load()
  void discoverRecentWikis().then((items) => {
    discovered.value = items
  })
  void loadLiveDirectory()
  void syncWatchlist()
  if (auth.agent && auth.did) {
    void listBookmarks(auth.agent, auth.did)
      .then((rows) => {
        starred.value = rows.map((row) => ({
          uri: row.uri,
          wikiRef: row.wikiRef,
        }))
      })
      .catch(() => {})
  }
})

async function loadLiveDirectory() {
  directoryLoading.value = true
  try {
    const wikis = await loadWikiDirectory()
    directory.value = wikis
    const dids = [...new Set(wikis.map((w) => w.did).filter(Boolean))]
    directoryStats.value = await loadDirectoryStats(dids)
  } catch {
    // the directory simply stays empty on failure
  } finally {
    directoryLoading.value = false
  }
}

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

/* ------------------------------ Wiki of the day ---------------------------- */

/** Deterministic daily rotation so the pick changes at midnight, not per load. */
const dayIndex = computed(() => {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), 0, 0)
  return Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86_400_000)
})

const wikiOfTheDay = computed(() => {
  const pool = sortedWikis.value
  if (!pool.length) return null
  return pool[dayIndex.value % pool.length] ?? null
})

const dailyIntro = computed(() => {
  const wiki = wikiOfTheDay.value
  if (!wiki) return ''
  const sentences = wiki.description.split(/(?<=[.!?])\s+/).filter(Boolean)
  return sentences[0] ?? wiki.description
})

/* --------------------------------- Counts --------------------------------- */

const hotCount = computed(
  () =>
    directory.value.filter((wiki) => {
      const at = directoryStats.value[wiki.did]?.lastActivity
      return !!at && Date.now() - Date.parse(at) < 7 * 86_400_000
    }).length,
)

const freshCount = computed(
  () =>
    directory.value.filter((wiki) => {
      if (!wiki.createdAt) return false
      return Date.now() - Date.parse(wiki.createdAt) < 30 * 86_400_000
    }).length,
)

const CHIPS: Array<{ id: ExploreChip; label: string; icon: string; count: () => number }> = [
  { id: 'explore', label: 'Explore', icon: '✳', count: () => directory.value.length },
  { id: 'hot', label: 'Hot', icon: '🔥', count: () => hotCount.value },
  { id: 'fresh', label: 'Fresh', icon: '✦', count: () => freshCount.value },
  { id: 'featured', label: 'Featured', icon: '⭐', count: () => sortedWikis.value.length },
]

/* -------------------------------- Directory ------------------------------- */

const allWikis = computed(() => {
  const query = search.value.trim().toLowerCase()
  let rows = directory.value.filter((wiki) => {
    if (!query) return true
    return (
      wiki.name.toLowerCase().includes(query) ||
      wiki.slug.toLowerCase().includes(query) ||
      wiki.handle.toLowerCase().includes(query) ||
      wiki.description.toLowerCase().includes(query)
    )
  })
  if (chip.value === 'hot') {
    rows = rows
      .filter((wiki) => {
        const at = directoryStats.value[wiki.did]?.lastActivity
        return !!at && Date.now() - Date.parse(at) < 30 * 86_400_000
      })
      .sort(
        (a, b) =>
          (directoryStats.value[b.did]?.notes ?? 0) -
          (directoryStats.value[a.did]?.notes ?? 0),
      )
  } else if (chip.value === 'fresh') {
    rows = [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  } else if (chip.value === 'featured') {
    rows = sortedWikis.value.map((wiki) => ({
      did: '',
      handle: wiki.handle,
      slug: wiki.slug,
      name: wiki.name,
      description: wiki.description,
      pdsHost: '',
      accentColor: wiki.accentColor,
      createdAt: wiki.createdAt ?? '',
    }))
  } else {
    rows = rows.sort((a, b) => {
      const aAt = directoryStats.value[a.did]?.lastActivity ?? ''
      const bAt = directoryStats.value[b.did]?.lastActivity ?? ''
      return bAt.localeCompare(aAt) || a.name.localeCompare(b.name)
    })
  }
  return rows
})

function remixFeatured(wiki: {
  handle: string
  slug: string
  name: string
  description: string
  accentColor: string
  createdAt?: string
}): void {
  void remix({
    did: '',
    handle: wiki.handle,
    slug: wiki.slug,
    name: wiki.name,
    description: wiki.description,
    pdsHost: '',
    accentColor: wiki.accentColor,
    createdAt: wiki.createdAt ?? '',
  })
}

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

function bookmarkTarget(ref: string): { handle: string; slug: string } | null {
  const withoutAt = ref.replace(/^at:\/\//, '')
  const slash = withoutAt.indexOf('/')
  if (slash <= 0) return null
  const slugPart = withoutAt.slice(slash + 1)
  const slug = slugPart.split('/').pop() ?? ''
  return { handle: withoutAt.slice(0, slash), slug }
}

</script>

<template>
  <div class="explore">
    <div class="explore-inner">
      <div class="explore-main" data-kb-section aria-label="Explore wikis">
        <div class="explore-chip-row">
          <div class="explore-chips" role="tablist" aria-label="Explore sections">
            <button
              v-for="item in CHIPS"
              :key="item.id"
              type="button"
              class="explore-chip"
              :class="{ active: chip === item.id }"
              role="tab"
              :aria-selected="chip === item.id"
              @click="chip = item.id"
            >
              <span class="explore-chip-icon" aria-hidden="true">{{ item.icon }}</span>
              {{ item.label }}
              <span v-if="item.count()" class="explore-chip-count">{{ item.count() }}</span>
            </button>
          </div>
          <GlobalWikiSearch class="explore-search" input-id="explore-search" />
        </div>

        <!-- Wiki of the day -->
        <section v-if="wikiOfTheDay" class="daily" aria-label="Wiki of the day">
          <div class="daily-head">
            <h1 class="daily-title">Wiki of the day</h1>
            <span class="daily-date">{{ today }}</span>
          </div>
          <p class="daily-sub">A wiki worth your time today</p>
          <article
            class="daily-card"
            :style="{ '--daily-accent': wikiOfTheDay.accentColor }"
          >
            <div class="daily-banner" aria-hidden="true" />
            <div class="daily-body">
              <div class="daily-meta">
                <span class="daily-wiki">
                  <WikiAvatar
                    :handle="wikiOfTheDay.handle"
                    :name="wikiOfTheDay.name"
                    :seed="wikiOfTheDay.slug"
                    :accent-color="wikiOfTheDay.accentColor"
                    :size="20"
                  />
                  Wiki
                </span>
                <span class="daily-updated">
                  {{ dailyIntro ? '' : '' }}updated {{ relativeTime(wikiOfTheDay.updatedAt) }}
                </span>
              </div>
              <h2 class="daily-name">
                <RouterLink :to="wikiPath(wikiOfTheDay.handle, wikiOfTheDay.slug)">
                  {{ wikiOfTheDay.name }}
                </RouterLink>
              </h2>
              <p class="daily-desc">
                {{ dailyIntro || wikiOfTheDay.description }}
              </p>
              <div class="daily-actions">
                <RouterLink
                  :to="wikiPath(wikiOfTheDay.handle, wikiOfTheDay.slug)"
                  class="btn btn-primary btn-sm"
                >
                  Open wiki
                </RouterLink>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="remixing === `${wikiOfTheDay.handle}/${wikiOfTheDay.slug}`"
                  @click="remixFeatured(wikiOfTheDay)"
                >
                  {{
                    remixing === `${wikiOfTheDay.handle}/${wikiOfTheDay.slug}`
                      ? 'Remixing…'
                      : 'Remix'
                  }}
                </button>
                <span class="daily-stats">
                  {{ wikiOfTheDay.noteCount }} article{{ wikiOfTheDay.noteCount === 1 ? '' : 's' }}
                </span>
              </div>
            </div>
          </article>
        </section>

        <!-- From the community -->
        <section class="community" aria-label="From the community">
          <div class="section-head">
            <h2 class="section-title">From the community</h2>
          </div>
          <p class="section-sub">What's landing on pckt right now</p>
          <div v-if="guestFeed.loading.value" class="muted section-loading">
            Loading community activity…
          </div>
          <GuestFeedList
            v-else-if="guestFeed.snapshot.value?.items.length"
            :items="guestFeed.snapshot.value.items"
            :limit="8"
            compact
          />
          <p v-else class="muted">No recent community activity yet.</p>
        </section>

        <!-- Directory -->
        <section class="directory" aria-label="All wikis">
          <div class="section-head">
            <h2 class="section-title">
              {{ chip === 'hot' ? 'Hot wikis' : chip === 'fresh' ? 'Fresh wikis' : chip === 'featured' ? 'Featured wikis' : 'All public wikis' }}
            </h2>
          </div>
          <p v-if="!directoryLoading" class="section-sub">
            {{
              chip === 'hot'
                ? 'The most active wikis on the network right now'
                : chip === 'fresh'
                  ? 'Newest wikis — created in the last month'
                  : chip === 'featured'
                    ? 'Hand-curated starting points'
                    : 'Every public wiki the relay knows about, newest activity first'
            }}
          </p>
          <input
            v-model="search"
            class="input directory-search"
            type="search"
            placeholder="Search every public wiki on the network…"
            aria-label="Search the wiki directory"
          />
          <div v-if="directoryLoading" class="muted section-loading">Crawling the network…</div>
          <template v-else>
            <p v-if="remixDone" class="muted">{{ remixDone }}</p>
            <p v-if="remixError" class="error-text">{{ remixError }}</p>
            <ul class="directory-grid">
              <li v-for="wiki in allWikis" :key="`${wiki.handle}-${wiki.slug}`">
                <div class="directory-item">
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
            <p v-if="!allWikis.length" class="muted">
              {{ search ? `No wikis match “${search}”.` : 'No wikis here yet.' }}
            </p>
          </template>
        </section>
      </div>

      <!-- Right rail -->
      <aside class="explore-rail" aria-label="Explore shortcuts">
        <nav class="rail-nav">
          <button
            type="button"
            class="rail-link"
            :class="{ active: chip === 'explore' }"
            @click="chip = 'explore'"
          >
            ✳ Explore
          </button>
          <button
            type="button"
            class="rail-link"
            :class="{ active: chip === 'hot' }"
            @click="chip = 'hot'"
          >
            🔥 Hot wikis
          </button>
          <button
            type="button"
            class="rail-link"
            :class="{ active: chip === 'fresh' }"
            @click="chip = 'fresh'"
          >
            ✦ Fresh wikis
          </button>
          <button
            type="button"
            class="rail-link"
            :class="{ active: chip === 'featured' }"
            @click="chip = 'featured'"
          >
            ⭐ Featured
          </button>
        </nav>

        <section class="rail-box">
          <h3 class="rail-title">Subscribed</h3>
          <ul v-if="subscribedWikis.length" class="rail-list">
            <li v-for="wiki in subscribedWikis.slice(0, 6)" :key="wiki.wikiUri">
              <RouterLink
                :to="wikiPath(wiki.handle, wiki.wikiSlug)"
                class="rail-item"
              >
                {{ wiki.wikiName }}
              </RouterLink>
            </li>
          </ul>
          <p v-else class="rail-empty muted">Nothing watched yet.</p>
        </section>

        <section v-if="auth.agent" class="rail-box">
          <h3 class="rail-title">Starred</h3>
          <ul v-if="starred.length" class="rail-list">
            <li v-for="bookmark in starred.slice(0, 6)" :key="bookmark.uri">
              <RouterLink
                v-if="bookmarkTarget(bookmark.wikiRef)"
                :to="wikiPath(bookmarkTarget(bookmark.wikiRef)!.handle, bookmarkTarget(bookmark.wikiRef)!.slug)"
                class="rail-item"
              >
                {{ bookmarkTarget(bookmark.wikiRef)!.slug }}
              </RouterLink>
            </li>
          </ul>
          <p v-else class="rail-empty muted">Bookmark wikis to find them here.</p>
        </section>

        <section class="rail-box">
          <h3 class="rail-title">The network</h3>
          <ul class="rail-stats">
            <li><strong>{{ stats.wikiCount }}</strong> wikis</li>
            <li><strong>{{ stats.noteCount }}</strong> articles</li>
            <li><strong>{{ stats.contributorCount }}</strong> authors</li>
          </ul>
          <RouterLink to="/wiki/new" class="rail-item rail-item-cta">Create a wiki →</RouterLink>
          <a
            href="https://pckt.blog"
            target="_blank"
            rel="noopener noreferrer"
            class="rail-item"
          >
            pckt.blog ↗
          </a>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.explore {
  background: #fbf4e3;
  padding: 2rem 1.25rem 5rem;
  min-height: calc(100dvh - 3rem);
}

[data-theme='dark'] .explore {
  background: #1d1a15;
}

.explore-inner {
  max-width: 76rem;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 16rem;
  gap: 2.5rem;
  align-items: start;
}

.explore-main {
  min-width: 0;
}

/* Chips */
.explore-chip-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 2rem;
}

.explore-chips {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.explore-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--pckt-border);
  border-radius: 999px;
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.explore-chip:hover {
  border-color: color-mix(in srgb, var(--pckt-accent) 50%, var(--pckt-border));
}

.explore-chip.active {
  background: var(--pckt-text);
  border-color: var(--pckt-text);
  color: var(--pckt-bg-elevated);
}

.explore-chip-icon {
  font-size: 0.8rem;
}

.explore-chip-count {
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--pckt-text-muted);
}

.explore-chip.active .explore-chip-count {
  color: inherit;
  opacity: 0.7;
}

.explore-search {
  margin-left: auto;
  min-width: 12rem;
}

/* Wiki of the day */
.daily {
  margin-bottom: 3rem;
}

.daily-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}

.daily-title {
  margin: 0;
  font-family: var(--pckt-font-content);
  font-size: 2rem;
  font-weight: 700;
}

.daily-date {
  font-family: var(--pckt-font-content);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--pckt-text-muted);
}

.daily-sub {
  margin: 0.15rem 0 1rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  color: var(--pckt-text-muted);
}

.daily-card {
  overflow: hidden;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-lg, 14px);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow);
}

.daily-banner {
  height: 10rem;
  background: linear-gradient(
    120deg,
    color-mix(in srgb, var(--daily-accent, var(--pckt-blue)) 55%, transparent),
    color-mix(in srgb, var(--daily-accent, var(--pckt-blue)) 20%, transparent)
  );
}

.daily-body {
  padding: 1.1rem 1.25rem 1.25rem;
}

.daily-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
}

.daily-wiki {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
}

.daily-name {
  margin: 0.5rem 0 0.35rem;
  font-family: var(--pckt-font-content);
  font-size: 1.5rem;
  font-weight: 700;
}

.daily-name a {
  color: inherit;
  text-decoration: none;
}

.daily-name a:hover {
  color: var(--pckt-accent);
}

.daily-desc {
  margin: 0 0 1rem;
  font-family: var(--pckt-font-content);
  font-size: 1rem;
  line-height: 1.55;
  color: var(--pckt-text);
}

.daily-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.daily-stats {
  margin-left: auto;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--pckt-text-muted);
}

/* Sections */
.section-title {
  margin: 0;
  font-family: var(--pckt-font-content);
  font-size: 1.65rem;
  font-weight: 700;
}

.section-sub {
  margin: 0.15rem 0 1rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  color: var(--pckt-text-muted);
}

.section-loading {
  padding: 1rem 0;
}

.community {
  margin-bottom: 3rem;
}

.directory {
  margin-bottom: 2rem;
}

.directory-search {
  margin-bottom: 1rem;
}

.directory-grid {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.6rem;
}

.directory-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-md, 12px);
  background: var(--pckt-bg-elevated);
}

.directory-item-main {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}

.directory-item-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.directory-item-name {
  font-family: var(--pckt-font-ui);
  font-size: 0.9375rem;
  font-weight: 700;
}

.directory-item-meta {
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  color: var(--pckt-text-muted);
}

.directory-item-desc {
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  color: var(--pckt-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42rem;
}

/* Right rail */
.explore-rail {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  position: sticky;
  top: 4.5rem;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--pckt-border);
}

.rail-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.9rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.rail-link:hover {
  background: var(--pckt-bg-muted);
}

.rail-link.active {
  background: color-mix(in srgb, var(--pckt-accent) 12%, var(--pckt-bg-elevated));
  color: var(--pckt-accent);
}

.rail-box {
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--pckt-border);
}

.rail-title {
  margin: 0 0 0.4rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--pckt-text-muted);
}

.rail-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.rail-item {
  display: block;
  padding: 0.3rem 0.35rem;
  border-radius: var(--pckt-radius-sm);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-item:hover {
  background: var(--pckt-bg-muted);
}

.rail-item-cta {
  color: var(--pckt-accent);
}

.rail-empty {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
}

.rail-stats {
  margin: 0 0 0.5rem;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.85rem;
  color: var(--pckt-text-muted);
}

.rail-stats strong {
  color: var(--pckt-text);
}

@media (max-width: 960px) {
  .explore-inner {
    grid-template-columns: minmax(0, 1fr);
  }

  .explore-rail {
    position: static;
  }

  .daily-title,
  .daily-date {
    font-size: 1.5rem;
  }
}

@media (max-width: 560px) {
  .explore {
    padding: 1.25rem 0.875rem 4rem;
  }

  .explore-search {
    margin-left: 0;
    width: 100%;
  }

  .directory-item {
    flex-direction: column;
    align-items: stretch;
  }

  .directory-item-desc {
    white-space: normal;
  }
}
</style>
