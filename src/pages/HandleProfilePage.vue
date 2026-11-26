<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import WikiAvatar from '@/components/WikiAvatar.vue'
import { getReadAgentForRepo, resolveHandleToDid } from '@/lib/atproto/auth'
import { listWikis } from '@/lib/atproto/lichen'
import { loadWikiDirectory, pdsHostFromHandle, type DirectoryWiki } from '@/lib/lichen/wiki-directory'
import { defaultHandleForLabel } from '@/lib/lichen/subdomain-handle'
import { formatDocumentDate } from '@/lib/standardsite/blog'
import type { LichenWikiRecord } from '@/types/lichen'

/**
 * `/by/:sub` — the wikis of one person, reached by a username subdomain
 * (`oseanstudio.allour.wiki`), a custom-domain handle (`joyboy.wiki`), or typed
 * directly.
 *
 * A bare label maps to the default Bluesky handle (`oseanstudio.bsky.social`).
 * A dotted label is already a handle, so `joyboy.wiki` resolves directly;
 * directory matching is only needed for `<label>.allour.wiki` → `mfzx.net`.
 */

interface ProfileWiki {
  handle: string
  slug: string
  name: string
  description: string
  accentColor: string
  createdAt: string
  pdsHost: string
}

const route = useRoute()

const sub = computed(() => String(route.params.sub ?? '').trim().toLowerCase())
const primaryHandle = computed(() =>
  !sub.value ? '' : sub.value.includes('.') ? sub.value : defaultHandleForLabel(sub.value),
)

const wikis = ref<ProfileWiki[]>([])
const resolvedHandle = ref('')
const loading = ref(true)
const error = ref('')

const accent = computed(() => wikis.value[0]?.accentColor || '#3366cc')

const displayName = computed(() => {
  const handle = resolvedHandle.value || primaryHandle.value
  return handle.split('.')[0] || handle
})

function toProfileWiki(handle: string, record: LichenWikiRecord): ProfileWiki {
  return {
    handle,
    slug: record.slug,
    name: record.name,
    description: record.description ?? '',
    accentColor: record.accentColor ?? '#3366cc',
    createdAt: record.createdAt,
    pdsHost: pdsHostFromHandle(handle),
  }
}

function fromDirectory(row: DirectoryWiki): ProfileWiki {
  return {
    handle: row.handle,
    slug: row.slug,
    name: row.name,
    description: row.description,
    accentColor: row.accentColor,
    createdAt: row.createdAt,
    pdsHost: row.pdsHost,
  }
}

/** A label without a dot is treated as a bsky.social handle. Custom-domain
 * handles (juprodh.me) can only be found by matching the label against the
 * public wiki directory. */
function directoryMatches(directory: DirectoryWiki[]): ProfileWiki[] {
  return directory
    .filter((row) => {
      const handle = row.handle.toLowerCase()
      return handle === primaryHandle.value || handle.split('.')[0] === sub.value
    })
    .map(fromDirectory)
}

async function loadWikisForHandle(handle: string): Promise<ProfileWiki[]> {
  const did = await resolveHandleToDid(handle)
  const agent = await getReadAgentForRepo(did)
  const records = await listWikis(agent, did)
  return records
    .filter((record) => record.visibility === 'public' && !record.deletedAt)
    .map((record) => toProfileWiki(handle, record))
}

async function load() {
  loading.value = true
  error.value = ''
  wikis.value = []
  resolvedHandle.value = ''

  if (!sub.value) {
    error.value = 'That address is missing a name.'
    loading.value = false
    return
  }

  let primary: ProfileWiki[] = []
  if (primaryHandle.value) {
    try {
      primary = await loadWikisForHandle(primaryHandle.value)
    } catch {
      // The default handle may not exist; the directory fallback covers custom
      // domains such as oseanstudio.com.
    }
  }

  if (primary.length) {
    resolvedHandle.value = primaryHandle.value
    wikis.value = primary.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    loading.value = false
    return
  }

  // Only crawl the network-wide directory when the default handle did not
  // produce a wiki. It is cached after the first Explore visit.
  const directory = await loadWikiDirectory().catch(() => [] as DirectoryWiki[])
  const fallback = directoryMatches(directory)
  if (fallback.length) {
    const exact = fallback.find(
      (wiki) => wiki.handle.toLowerCase() === primaryHandle.value,
    )
    resolvedHandle.value = exact?.handle ?? fallback[0].handle
    wikis.value = fallback.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  loading.value = false
}

onMounted(load)
watch(() => route.params.sub, load)
</script>

<template>
  <div class="profile-page">
    <div class="inner">
      <header class="profile-head">
        <WikiAvatar
          :handle="resolvedHandle || primaryHandle"
          :name="displayName"
          :seed="resolvedHandle || primaryHandle"
          :accent-color="accent"
          :size="72"
          loading="eager"
        />
        <div class="profile-id">
          <p class="eyebrow">Wikis by</p>
          <h1>@{{ resolvedHandle || primaryHandle || sub }}</h1>
          <p class="muted">
            <template v-if="loading">Looking up their wikis…</template>
            <template v-else>
              {{ wikis.length }} public wiki{{ wikis.length === 1 ? '' : 's' }}
            </template>
          </p>
        </div>
      </header>

      <p v-if="error" class="error-text">{{ error }}</p>

      <ul v-if="wikis.length" class="wiki-grid">
        <li v-for="wiki in wikis" :key="`${wiki.handle}/${wiki.slug}`" class="wiki-card">
          <RouterLink :to="`/@${wiki.handle}/${wiki.slug}`">
            <span class="wiki-accent" :style="{ background: wiki.accentColor }" aria-hidden="true" />
            <span class="wiki-card-body">
              <span class="wiki-card-name">{{ wiki.name }}</span>
              <span class="muted wiki-card-desc">
                {{ wiki.description || 'A public wiki on Lichen.' }}
              </span>
              <span class="wiki-card-meta muted">
                {{ wiki.slug }} · @{{ wiki.handle }}
                <template v-if="wiki.createdAt"> · {{ formatDocumentDate(wiki.createdAt) }}</template>
              </span>
            </span>
          </RouterLink>
        </li>
      </ul>

      <p v-else-if="!loading && !error" class="empty">
        No public wikis yet for <strong>@{{ resolvedHandle || primaryHandle }}</strong>.
        <template v-if="!sub.includes('.')">
          <br />
          Username subdomains point at the wikis of the matching Bluesky handle —
          <code>{{ sub }}.allour.wiki</code> shows
          <code>{{ sub }}.bsky.social</code>.
        </template>
        <RouterLink to="/wikis">Browse every wiki →</RouterLink>
      </p>
    </div>
  </div>
</template>

<style scoped>
.profile-page {
  padding: 2.5rem 1.25rem 4rem;
}

.inner {
  max-width: 960px;
  margin: 0 auto;
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--pckt-border);
}

.profile-id h1 {
  margin: 0.1rem 0 0.2rem;
  font-family: var(--pckt-font-content);
  font-size: clamp(1.5rem, 3vw, 2rem);
  overflow-wrap: anywhere;
}

.eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pckt-text-muted);
}

.profile-head .muted {
  margin: 0;
  font-size: 0.875rem;
}

.wiki-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.9rem;
  margin: 1.25rem 0 0;
  padding: 0;
  list-style: none;
}

.wiki-card a {
  display: flex;
  gap: 0.85rem;
  height: 100%;
  padding: 1rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
}

.wiki-card a:hover {
  border-color: var(--pckt-accent);
  text-decoration: none;
}

.wiki-accent {
  flex-shrink: 0;
  width: 0.25rem;
  border-radius: var(--pckt-radius-pill);
}

.wiki-card-body {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.wiki-card-name {
  font-weight: 600;
  font-size: 1.05rem;
  font-family: var(--pckt-font-content);
}

.wiki-card-desc {
  font-size: 0.875rem;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.wiki-card-meta {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.empty {
  margin-top: 1.5rem;
  line-height: 1.8;
  color: var(--pckt-text-muted);
}

.empty code {
  padding: 0.05rem 0.3rem;
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-muted);
  font-family: var(--pckt-font-mono);
  font-size: 0.85em;
  overflow-wrap: anywhere;
}

.empty a {
  display: inline-block;
  margin-top: 0.75rem;
}

.error-text {
  color: var(--pckt-red);
  margin-top: 1rem;
}
</style>
