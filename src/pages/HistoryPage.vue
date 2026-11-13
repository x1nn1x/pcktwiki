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

const isOwner = computed(
  () => !!auth.did && !!lichen.currentWiki && lichen.currentWiki.ownerDid === auth.did,
)
const eraseText = ref('')
const eraseReplacement = ref('')
const eraseFindings = ref<{ revisionsAffected: number; occurrencesInCurrent: number } | null>(null)
const eraseArmed = ref(false)
const erasing = ref(false)
const eraseError = ref('')
const eraseDone = ref('')

function findEraseText() {
  eraseError.value = ''
  if (!note.value || !eraseText.value.trim()) return
  eraseFindings.value = lichen.findTextInHistory(note.value.uri, eraseText.value)
  eraseArmed.value = false
  if (eraseFindings.value.revisionsAffected === 0 && eraseFindings.value.occurrencesInCurrent === 0) {
    eraseError.value = 'That exact text does not appear in this page\u2019s history or current content.'
  }
}

async function eraseFromHistory() {
  if (!auth.agent || !note.value || !eraseArmed.value || erasing.value) return
  erasing.value = true
  eraseError.value = ''
  try {
    const written = await lichen.redactTextFromHistory(
      auth.agent,
      note.value,
      eraseText.value,
      eraseReplacement.value,
    )
    eraseDone.value = `Erased from ${written} revision${written === 1 ? '' : 's'} — the text no longer exists in this page's saved history.`
    eraseText.value = ''
    eraseReplacement.value = ''
    eraseFindings.value = null
    eraseArmed.value = false
    await load()
  } catch (err) {
    eraseError.value = err instanceof Error ? err.message : 'Could not erase the text'
  } finally {
    erasing.value = false
  }
}

const purgeArmed = ref(false)
const purgeConfirmText = ref('')
const purging = ref(false)
const purgeError = ref('')
const purgeDone = ref(false)
const canPurge = computed(() => isOwner.value && (history.value.length > 1 || purgeDone.value))

async function purgeHistory() {
  if (!auth.agent || !note.value || !purgeArmed.value || purging.value) return
  purging.value = true
  purgeError.value = ''
  try {
    await lichen.purgeNoteHistory(auth.agent, note.value)
    purgeArmed.value = false
    purgeConfirmText.value = ''
    purgeDone.value = true
    // Reload the (now single-revision) history.
    await load()
  } catch (err) {
    purgeError.value = err instanceof Error ? err.message : 'Could not purge history'
  } finally {
    purging.value = false
  }
}
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

      <section v-if="isOwner" class="erase-zone card">
        <h2>Erase text from history</h2>
        <p class="muted purge-warning">
          Permanently removes an exact piece of text from every saved revision of this page —
          diffs, snapshots, and edit messages — while keeping the rest of the changelog intact.
          The text is rewritten out of the records on your PDS, so no app can reconstruct it.
          Exact match, case-sensitive.
        </p>
        <div class="erase-form">
          <input
            v-model="eraseText"
            class="input"
            type="text"
            placeholder="Exact text to erase"
            :disabled="erasing"
            aria-label="Text to erase"
          />
          <input
            v-model="eraseReplacement"
            class="input"
            type="text"
            placeholder="Replace with (optional — blank removes it)"
            :disabled="erasing"
            aria-label="Replacement text"
          />
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="!eraseText.trim() || erasing"
            @click="findEraseText"
          >
            Find occurrences
          </button>
        </div>
        <p v-if="eraseFindings" class="muted erase-findings">
          Found in {{ eraseFindings.revisionsAffected }} saved revision{{
            eraseFindings.revisionsAffected === 1 ? '' : 's'
          }}<template v-if="eraseFindings.occurrencesInCurrent">
            and {{ eraseFindings.occurrencesInCurrent }} place{{
              eraseFindings.occurrencesInCurrent === 1 ? '' : 's'
            }}
            on the current page</template
          >. Erasing rewrites those records permanently.
        </p>
        <div v-if="eraseFindings" class="erase-actions">
          <label class="erase-confirm-label">
            <input v-model="eraseArmed" type="checkbox" />
            <span>I understand this permanently rewrites the saved history.</span>
          </label>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            :disabled="!eraseArmed || erasing"
            @click="eraseFromHistory"
          >
            {{ erasing ? 'Erasing…' : 'Erase permanently' }}
          </button>
        </div>
        <p v-if="eraseDone" class="muted erase-done">{{ eraseDone }}</p>
        <p v-if="eraseError" class="error-text">{{ eraseError }}</p>
      </section>

      <section v-if="isOwner" class="purge-zone card">
        <h2>Purge edit history</h2>
        <p class="muted purge-warning">
          The nuclear option — deletes
          <strong>every</strong> revision of this page from your PDS and keeps only the current
          text as a single fresh revision. Use the erase tool above to remove specific text
          instead; purging throws away the whole changelog. This cannot be undone: export a
          backup first if you might want the history. Note that third-party services that
          already fetched these records may have retained copies.
        </p>
        <p class="muted purge-warning">
          Permanently deletes every revision of this page from your PDS and keeps only the
          current text as a single fresh revision. The changelog — including any removed text —
          becomes unreadable to everyone, including via lichen.wiki. This cannot be undone:
          export a backup first if you might want the history. Note that third-party services
          that already fetched these records may have retained copies.
        </p>
        <p v-if="!purgeDone && canPurge" class="muted purge-count">
          {{ history.length }} revision{{ history.length === 1 ? '' : 's' }} will be permanently deleted.
        </p>
        <p v-if="purgeDone" class="muted">History purged — this page now has a single clean revision.</p>
        <p class="muted purge-warning">
          To remove a specific passage instead of everything, use
          <strong>Erase text from history</strong> above.
        </p>
        <button
          v-if="!purgeArmed && canPurge"
          type="button"
          class="btn btn-danger-outline btn-sm"
          @click="purgeArmed = true"
        >
          Purge edit history…
        </button>
        <div v-if="purgeArmed" class="purge-confirm">
          <input
            v-model="purgeConfirmText"
            class="input"
            type="text"
            :placeholder="`Type PURGE to confirm`"
            :disabled="purging"
            aria-label="Type PURGE to confirm"
          />
          <div class="purge-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="purging"
              @click="purgeArmed = false"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              :disabled="purging || purgeConfirmText.trim().toUpperCase() !== 'PURGE'"
              @click="purgeHistory"
            >
              {{ purging ? 'Purging…' : 'Delete all revisions permanently' }}
            </button>
          </div>
        </div>
        <p v-if="purgeError" class="error-text">{{ purgeError }}</p>
      </section>

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

.erase-zone {
  padding: 1rem 1.25rem;
  border-color: color-mix(in srgb, var(--pckt-accent, var(--pckt-red)) 30%, var(--pckt-border));
}

.erase-zone h2 {
  margin: 0 0 0.375rem;
  font-size: 1rem;
}

.erase-zone > p {
  margin: 0 0 0.5rem;
}

.erase-form {
  display: grid;
  gap: 0.5rem;
  max-width: 30rem;
}

.erase-findings {
  font-size: 0.875rem;
}

.erase-actions {
  display: grid;
  gap: 0.5rem;
  justify-items: start;
}

.erase-confirm-label {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.8125rem;
}

.erase-done {
  font-size: 0.875rem;
}

.purge-zone {
  padding: 1rem 1.25rem;
  border-color: color-mix(in srgb, var(--pckt-danger) 35%, var(--pckt-border));
}

.purge-zone h2 {
  margin: 0 0 0.375rem;
  font-size: 1rem;
  color: var(--pckt-danger);
}

.purge-warning {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.purge-count {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
}

.purge-confirm {
  display: grid;
  gap: 0.5rem;
  max-width: 26rem;
}

.purge-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn-danger {
  border-color: color-mix(in srgb, var(--pckt-danger) 55%, transparent);
  background: var(--pckt-danger);
  color: #fff;
}

</style>
