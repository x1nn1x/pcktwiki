<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { canManage } from '@/lib/lichen/collections'
import { listAllOpenSuggestions } from '@/lib/lichen/suggestions'
import { parentSlugFromBranch } from '@/lib/lichen/branches'
import { getPublicAgent } from '@/lib/atproto/auth'
import { getActorProfile } from '@/lib/standardsite/blog'
import { resolveBlobDisplayUrl } from '@/lib/atproto/blobs'
import type { ActorProfile, LichenSuggestionRecord } from '@/types/lichen'
import RevisionDiff from '@/components/RevisionDiff.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const canReviewWiki = computed(() => canManage(lichen.access))
const isOwner = computed(
  () => !!auth.did && !!lichen.currentWiki && lichen.currentWiki.ownerDid === auth.did,
)
const suggestions = computed(() => listAllOpenSuggestions(lichen.notes))

/** Handles for suggestion authors, resolved lazily for display. */
const authorProfiles = ref<Record<string, ActorProfile | null>>({})

async function resolveAuthor(did: string): Promise<void> {
  if (authorProfiles.value[did] !== undefined) return
  authorProfiles.value = { ...authorProfiles.value, [did]: null }
  try {
    authorProfiles.value = {
      ...authorProfiles.value,
      [did]: await getActorProfile(getPublicAgent(), did),
    }
  } catch {
    // keep the null placeholder
  }
}

function authorLabel(did: string): string {
  return authorProfiles.value[did]?.handle ?? did
}

/** Thumbnail URLs for photo submissions (author's own blobs). */
const photoUrls = ref<Record<string, string | null>>({})

async function resolvePhoto(suggestion: LichenSuggestionRecord, index: number): Promise<void> {
  const key = `${suggestion.uri}#${index}`
  if (photoUrls.value[key] !== undefined) return
  photoUrls.value = { ...photoUrls.value, [key]: null }
  const blobRef = suggestion.blobs?.[index]
  try {
    photoUrls.value = {
      ...photoUrls.value,
      [key]: await resolveBlobDisplayUrl(suggestion.authorDid, blobRef),
    }
  } catch {
    // keep the null placeholder
  }
}

const working = ref<string | null>(null)
const reviewError = ref('')

async function load() {
  await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  // Suggestions replay branch revisions, which page views load newest-first.
  await lichen.ensureFullHistory(auth.agent)
  if (auth.agent && canReviewWiki.value && lichen.currentWiki) {
    void lichen.refreshIncomingSuggestions(auth.agent)
    for (const suggestion of lichen.incomingSuggestions) {
      void resolveAuthor(suggestion.authorDid)
      if (suggestion.kind === 'image') {
        for (let index = 0; index < (suggestion.blobs?.length ?? 0); index += 1) {
          void resolvePhoto(suggestion, index)
        }
      }
    }
  }
}

onMounted(load)
watch(() => route.fullPath, load)
watch(
  () => lichen.incomingSuggestions,
  (list) => {
    for (const suggestion of list) {
      void resolveAuthor(suggestion.authorDid)
      if (suggestion.kind === 'image') {
        for (let index = 0; index < (suggestion.blobs?.length ?? 0); index += 1) {
          void resolvePhoto(suggestion, index)
        }
      }
    }
  },
)

async function accept(branchSlug: string) {
  if (!auth.agent) return
  const parent = parentSlugFromBranch(branchSlug)
  const branchNote = lichen.getNoteBySlug(branchSlug)
  const parentNote = parent ? lichen.getNoteBySlug(parent) : null
  if (!branchNote || !parentNote || !parent) return
  if (!confirm(`Accept suggestion into “${parent}”?`)) return
  await lichen.saveNoteEdit(
    auth.agent,
    parentNote,
    parentNote.title,
    branchNote.content,
    `Accepted suggestion ${branchSlug}`,
  )
  await lichen.removeNote(auth.agent, branchNote)
  router.push(`/@${handle.value}/${wikiSlug.value}/${parent}`)
}

async function reject(branchSlug: string) {
  if (!auth.agent) return
  const branchNote = lichen.getNoteBySlug(branchSlug)
  if (!branchNote) return
  if (!confirm('Reject and delete this suggestion?')) return
  await lichen.removeNote(auth.agent, branchNote)
}

async function approve(suggestion: LichenSuggestionRecord) {
  if (!auth.agent) return
  reviewError.value = ''
  const target = suggestion.noteSlug || 'this page'
  if (!confirm(`Publish this suggestion into “${target}”?`)) return
  working.value = suggestion.uri
  try {
    await lichen.approveSuggestion(auth.agent, suggestion)
    lichen.incomingSuggestions = lichen.incomingSuggestions.filter(
      (item) => item.uri !== suggestion.uri,
    )
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : 'Could not publish the suggestion'
  } finally {
    working.value = null
  }
}

function rejectIncoming(suggestion: LichenSuggestionRecord) {
  lichen.rejectIncomingSuggestion(suggestion)
}
</script>

<template>
  <div class="suggestions-page">
    <div class="inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Suggested edits</h1>
        <p class="muted">Branch notes named <code>suggestion-*</code> awaiting review.</p>
      </header>

      <section
        v-if="canReviewWiki"
        class="card incoming"
        aria-label="Suggestions from contributors"
      >
        <h2>From contributors</h2>
        <p class="muted">
          Proposed edits and photo submissions filed by other accounts. Publishing requires
          the wiki owner<template v-if="!isOwner"> — you can review here, and the owner
          publishes.</template>
        </p>

        <p v-if="lichen.suggestionsLoading" class="muted">Checking for suggestions…</p>
        <template v-else-if="lichen.incomingSuggestions.length">
          <section
            v-for="item in lichen.incomingSuggestions"
            :key="item.uri"
            class="incoming-item"
          >
            <header class="incoming-head">
              <div class="incoming-meta">
                <strong>{{ item.noteSlug || 'wiki' }}</strong>
                <span class="muted"> by @{{ authorLabel(item.authorDid) }}</span>
                <span class="muted"> · {{ new Date(item.createdAt).toLocaleString() }}</span>
                <span v-if="item.kind === 'image'" class="pill">photo submission</span>
              </div>
              <div class="actions">
                <button
                  v-if="isOwner"
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="working === item.uri"
                  @click="approve(item)"
                >
                  {{ working === item.uri ? 'Publishing…' : 'Approve & publish' }}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  @click="rejectIncoming(item)"
                >
                  Reject
                </button>
              </div>
            </header>
            <p v-if="item.message" class="incoming-message">“{{ item.message }}”</p>

            <template v-if="item.kind === 'image'">
              <div class="incoming-photos">
                <template v-for="index in (item.blobs?.length ?? 0)" :key="index">
                  <img
                    v-if="photoUrls[`${item.uri}#${index}`]"
                    :src="photoUrls[`${item.uri}#${index}`]!"
                    :alt="item.alt || 'Submitted photo'"
                    loading="lazy"
                  />
                </template>
              </div>
            </template>
            <template v-else>
              <RevisionDiff
                v-if="lichen.getNoteBySlug(item.noteSlug)"
                :old-text="lichen.getNoteBySlug(item.noteSlug)!.content"
                :new-text="item.content ?? ''"
              />
              <p v-else class="muted incoming-new">
                Proposes creating this page ({{ item.content?.length ?? 0 }} characters).
              </p>
            </template>
          </section>
        </template>
        <p v-else class="muted">No pending contributor suggestions.</p>
        <p v-if="reviewError" class="error-text">{{ reviewError }}</p>
      </section>

      <section v-for="item in suggestions" :key="item.branch.uri" class="card suggestion">
        <header class="suggestion-head">
          <div>
            <RouterLink :to="`/@${handle}/${wikiSlug}/${item.parentSlug}`">
              {{ item.parentSlug }}
            </RouterLink>
            <span class="muted"> ← {{ item.branch.slug.split('/').pop() }}</span>
          </div>
          <div v-if="canReviewWiki" class="actions">
            <button type="button" class="btn btn-primary btn-sm" @click="accept(item.branch.slug)">
              Accept
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="reject(item.branch.slug)">
              Reject
            </button>
            <RouterLink
              class="btn btn-secondary btn-sm"
              :to="`/@${handle}/${wikiSlug}/edit/${item.branch.slug}`"
            >
              Edit
            </RouterLink>
          </div>
        </header>
        <RevisionDiff
          v-if="lichen.getNoteBySlug(item.parentSlug)"
          :old-text="lichen.getNoteBySlug(item.parentSlug)!.content"
          :new-text="item.branch.content"
        />
      </section>

      <p v-if="!suggestions.length" class="muted">No open suggestions.</p>
    </div>
  </div>
</template>

<style scoped>
.suggestions-page {
  padding: 2rem 1.25rem 4rem;
}

.inner {
  max-width: 900px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.suggestion,
.incoming {
  padding: 1rem;
  display: grid;
  gap: 0.75rem;
}

.incoming h2 {
  margin: 0;
  font-size: 1rem;
}

.incoming > p {
  margin: 0;
  font-size: 0.875rem;
}

.incoming-item {
  padding: 0.75rem 0;
  border-top: 1px solid var(--pckt-border);
  display: grid;
  gap: 0.5rem;
}

.incoming-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
}

.incoming-meta {
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

.incoming-message {
  margin: 0;
  font-size: 0.875rem;
  font-style: italic;
}

.incoming-new {
  margin: 0;
  font-size: 0.875rem;
}

.incoming-photos {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.incoming-photos img {
  max-width: 12rem;
  max-height: 9rem;
  border-radius: var(--pckt-radius-sm, 6px);
  border: 1px solid var(--pckt-border);
}

.pill {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--pckt-border);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.suggestion-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: center;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.85em;
}
</style>
