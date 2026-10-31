<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { canEdit } from '@/lib/lichen/collections'
import { formatDocumentDate } from '@/lib/standardsite/blog'
import RevisionDiff from '@/components/RevisionDiff.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const noteSlug = computed(() => route.params.noteSlug as string)
const focusDamaged = computed(() => route.query.focus === 'damaged')

const selectedRevision = ref<string | null>(null)
const compareMode = ref<'snapshot' | 'diff'>('diff')
const restoring = ref(false)
const restoreError = ref('')
const revisionListEl = ref<HTMLElement | null>(null)

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

const note = computed(() => lichen.getNoteBySlug(noteSlug.value))
const history = computed(() => (note.value ? lichen.getHistory(note.value.uri) : []))
const canRestore = computed(() => canEdit(lichen.access) && !!auth.agent)

const damagedUriSet = computed(() => new Set(note.value?.damagedRevisionUris ?? []))
const damagedInHistory = computed(() =>
  history.value.filter((revision) => damagedUriSet.value.has(revision.uri)),
)
const selectedIsDamaged = computed(
  () => !!selectedRevision.value && damagedUriSet.value.has(selectedRevision.value),
)

const selectedIndex = computed(() =>
  history.value.findIndex((revision) => revision.uri === selectedRevision.value),
)

const selectedIsCurrent = computed(
  () => selectedIndex.value === 0 && history.value.length > 0,
)

const previewContent = computed(() => {
  if (!note.value || !selectedRevision.value) return null
  return lichen.getContentAtRevision(note.value.uri, selectedRevision.value)
})

const previousContent = computed(() => {
  if (!note.value || selectedIndex.value < 0) return ''
  const prevRevision = history.value[selectedIndex.value + 1]
  if (!prevRevision) return ''
  return lichen.getContentAtRevision(note.value.uri, prevRevision.uri)
})

const damagedFocusIndex = computed(() => {
  if (!selectedRevision.value) return -1
  return damagedInHistory.value.findIndex((revision) => revision.uri === selectedRevision.value)
})

function selectRevision(uri: string) {
  selectedRevision.value = uri
  void scrollSelectedIntoView()
}

function selectDamagedByOffset(offset: number) {
  const items = damagedInHistory.value
  if (!items.length) return
  const current = damagedFocusIndex.value
  const next = current < 0 ? 0 : (current + offset + items.length) % items.length
  selectRevision(items[next].uri)
}

async function scrollSelectedIntoView() {
  await nextTick()
  const root = revisionListEl.value
  if (!root || !selectedRevision.value) return
  const active = root.querySelector<HTMLElement>('[data-revision-active="true"]')
  active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function pickInitialRevision(items: typeof history.value): string | null {
  if (!items.length) return null
  if (focusDamaged.value) {
    const firstDamaged = items.find((revision) => damagedUriSet.value.has(revision.uri))
    if (firstDamaged) return firstDamaged.uri
  }
  return items[0].uri
}

watch(
  () => noteSlug.value,
  () => {
    selectedRevision.value = null
    restoreError.value = ''
  },
)

watch(
  [history, damagedUriSet, focusDamaged],
  ([items]) => {
    const next = pickInitialRevision(items)
    selectedRevision.value = next
    if (focusDamaged.value && next) void scrollSelectedIntoView()
  },
  { immediate: true },
)

async function restoreSelected() {
  if (!auth.agent || !note.value || previewContent.value === null || !selectedRevision.value) {
    return
  }
  if (selectedIsCurrent.value) return

  const when = history.value[selectedIndex.value]?.createdAt
  const label = when ? formatDocumentDate(when) : 'selected revision'
  if (
    !window.confirm(
      `Replace the current page with the version from ${label}? This saves a new edit — it does not delete history.`,
    )
  ) {
    return
  }

  restoreError.value = ''
  restoring.value = true
  try {
    await lichen.queueOrSaveNoteEdit(
      auth.agent,
      note.value,
      note.value.title,
      previewContent.value,
      `Restored version from ${label}`,
      handle.value,
      wikiSlug.value,
    )
    await router.push(`/@${handle.value}/${wikiSlug.value}/${note.value.slug}`)
  } catch (err) {
    restoreError.value = err instanceof Error ? err.message : 'Could not restore this version'
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="history-page">
    <div class="history-inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}/${noteSlug}`" class="muted">← Back to article</RouterLink>
        <h1>Revision history</h1>
        <p class="muted">{{ note?.title }}</p>
      </header>

      <div
        v-if="note && damagedInHistory.length"
        class="damaged-callout"
        role="status"
      >
        <p>
          {{ damagedInHistory.length === 1 ? '1 edit' : `${damagedInHistory.length} edits` }}
          never made it into the page.
          <template v-if="focusDamaged"> Jumping to {{ damagedInHistory.length === 1 ? 'it' : 'the latest' }}.</template>
        </p>
        <div v-if="damagedInHistory.length > 1" class="damaged-callout-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="selectDamagedByOffset(-1)">
            Previous
          </button>
          <span class="muted damaged-count">
            {{ (damagedFocusIndex >= 0 ? damagedFocusIndex : 0) + 1 }}
            /
            {{ damagedInHistory.length }}
          </span>
          <button type="button" class="btn btn-ghost btn-sm" @click="selectDamagedByOffset(1)">
            Next
          </button>
        </div>
      </div>

      <div v-if="lichen.loading" class="muted">Loading…</div>
      <div v-else-if="!note" class="error-text">Article not found</div>

      <div v-else class="history-layout">
        <ul ref="revisionListEl" class="revision-list card">
          <li
            v-for="revision in history"
            :key="revision.uri"
            :class="{
              active: selectedRevision === revision.uri,
              damaged: damagedUriSet.has(revision.uri),
            }"
            :data-revision-active="selectedRevision === revision.uri ? 'true' : undefined"
          >
            <button type="button" class="revision-btn" @click="selectRevision(revision.uri)">
              <time>{{ formatDocumentDate(revision.createdAt) }}</time>
              <span v-if="revision.message" class="message">{{ revision.message }}</span>
              <span v-if="damagedUriSet.has(revision.uri)" class="damaged-badge">
                Could not apply
              </span>
            </button>
          </li>
        </ul>

        <div v-if="previewContent !== null" class="preview card">
          <div class="preview-header">
            <h2>{{ compareMode === 'diff' ? 'Changes' : 'Snapshot' }}</h2>
            <div class="preview-actions">
              <div class="preview-tabs">
                <button
                  type="button"
                  class="tab"
                  :class="{ active: compareMode === 'diff' }"
                  @click="compareMode = 'diff'"
                >
                  Diff
                </button>
                <button
                  type="button"
                  class="tab"
                  :class="{ active: compareMode === 'snapshot' }"
                  @click="compareMode = 'snapshot'"
                >
                  Snapshot
                </button>
              </div>
              <button
                v-if="canRestore"
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="restoring || selectedIsCurrent"
                :title="
                  selectedIsCurrent
                    ? 'This is already the current version'
                    : 'Make this version the live page'
                "
                @click="restoreSelected"
              >
                {{ restoring ? 'Restoring…' : selectedIsCurrent ? 'Current version' : 'Restore this version' }}
              </button>
            </div>
          </div>

          <p v-if="selectedIsDamaged" class="damaged-preview-note">
            This edit did not apply, so the preview may not show what it tried to change.
            Try a nearby revision to restore.
          </p>

          <p v-if="restoreError" class="error-text">{{ restoreError }}</p>

          <RevisionDiff
            v-if="compareMode === 'diff'"
            :old-text="previousContent"
            :new-text="previewContent"
          />
          <div v-else class="snapshot">
            <MarkdownRenderer
              :source="previewContent"
              :wiki-slug="wikiSlug"
              :owner-handle="handle"
              :owner-did="lichen.currentWiki?.ownerDid"
            />
          </div>
        </div>
        <div v-else class="preview card muted">
          Select a revision to preview its content.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-page {
  padding: 2rem 1.25rem 4rem;
}

.history-inner {
  max-width: 1000px;
  margin: 0 auto;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.damaged-callout {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid color-mix(in srgb, var(--pckt-red) 35%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-red) 8%, var(--pckt-bg));
  border-radius: var(--pckt-radius, 8px);
}

.damaged-callout p {
  margin: 0;
  font-size: 0.9375rem;
}

.damaged-callout-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.65rem;
}

.damaged-count {
  font-size: 0.8125rem;
}

.history-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 1rem;
  margin-top: 1.5rem;
}

@media (max-width: 768px) {
  .history-layout {
    grid-template-columns: 1fr;
  }
}

.revision-list {
  list-style: none;
  margin: 0;
  padding: 0.5rem;
  max-height: min(70vh, 36rem);
  overflow: auto;
}

.revision-list li {
  border-bottom: 1px solid var(--pckt-border);
}

.revision-list li:last-child {
  border-bottom: none;
}

.revision-list li.active .revision-btn {
  background: var(--pckt-accent-soft);
}

.revision-list li.damaged .revision-btn {
  box-shadow: inset 3px 0 0 color-mix(in srgb, var(--pckt-red) 70%, transparent);
}

.revision-btn {
  width: 100%;
  text-align: left;
  padding: 0.75rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.revision-btn time {
  display: block;
  font-size: 0.875rem;
  color: var(--pckt-text-muted);
}

.message {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.9375rem;
}

.damaged-badge {
  display: inline-block;
  margin-top: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: color-mix(in srgb, var(--pckt-red) 85%, var(--pckt-text));
}

.preview {
  padding: 1.25rem;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.preview-header h2 {
  margin: 0;
  font-size: 1rem;
}

.preview-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.preview-tabs {
  display: flex;
  gap: 0.25rem;
}

.tab {
  border: 1px solid var(--pckt-border);
  background: var(--pckt-bg);
  padding: 0.35rem 0.75rem;
  border-radius: var(--pckt-radius-pill);
  font-size: 0.8125rem;
  cursor: pointer;
}

.tab.active {
  background: var(--pckt-accent-soft);
  border-color: color-mix(in srgb, var(--pckt-red) 30%, transparent);
  font-weight: 600;
}

.damaged-preview-note {
  margin: 0 0 0.85rem;
  padding: 0.65rem 0.75rem;
  font-size: 0.875rem;
  border-radius: var(--pckt-radius, 8px);
  background: color-mix(in srgb, var(--pckt-red) 8%, var(--pckt-bg));
  border: 1px solid color-mix(in srgb, var(--pckt-red) 25%, var(--pckt-border));
}

.snapshot {
  margin-top: 0.5rem;
}

.error-text {
  margin: 0 0 0.75rem;
}
</style>
