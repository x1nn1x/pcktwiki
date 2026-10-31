<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { formatDocumentDate } from '@/lib/standardsite/blog'
import { rewindPlanIsNoop } from '@/lib/lichen/wiki-versions'
import { toUserFacingNetworkError } from '@/lib/http-retry'
import RevisionDiff from '@/components/RevisionDiff.vue'

const route = useRoute()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)

const selectedTime = ref<string | null>(null)
const restoring = ref(false)
const errorText = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())

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

const canManage = computed(() => lichen.access === 'admin')
const timeline = computed(() => lichen.getWikiTimeline())

const plan = computed(() =>
  selectedTime.value ? lichen.getRewindPlan(selectedTime.value) : null,
)

const isCurrent = computed(
  () => !!plan.value && rewindPlanIsNoop(plan.value),
)

const selectedLabel = computed(() =>
  selectedTime.value ? new Date(selectedTime.value).toLocaleString() : null,
)

function selectEntry(createdAt: string) {
  selectedTime.value = createdAt
  expanded.value = new Set()
}

function toggle(uri: string) {
  const next = new Set(expanded.value)
  if (next.has(uri)) next.delete(uri)
  else next.add(uri)
  expanded.value = next
}

async function restore() {
  if (!auth.agent || !selectedTime.value) return
  const target = plan.value
  if (!target) return
  const removeCount = target.remove.length
  const restoreCount = target.restore.length
  const message =
    `Rewind the whole wiki to ${selectedLabel.value}?\n\n` +
    `${restoreCount} note${restoreCount === 1 ? '' : 's'} will be rolled back` +
    (removeCount
      ? ` and ${removeCount} note${removeCount === 1 ? '' : 's'} created later will be deleted.`
      : '.') +
    `\n\nContent rollbacks are reversible from this page; deletions are not.`
  if (!confirm(message)) return

  restoring.value = true
  errorText.value = null
  try {
    await lichen.rewindWikiToTime(auth.agent, selectedTime.value)
    await load()
    selectedTime.value = null
  } catch (err) {
    errorText.value = toUserFacingNetworkError(err)
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="versions-page">
    <div class="versions-inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Back to wiki</RouterLink>
        <h1>Wiki versions</h1>
        <p class="muted">
          Every note revision across <code>{{ wikiSlug }}</code>. Pick a point to preview or
          rewind the entire wiki to that moment.
        </p>
      </header>

      <div v-if="lichen.loading" class="muted">Loading…</div>
      <div v-else-if="!lichen.currentWiki" class="error-text">Wiki not found</div>
      <div v-else-if="!canManage" class="error-text">
        Only wiki admins can view and restore versions.
      </div>

      <div v-else class="versions-layout">
        <ul class="timeline card">
          <li v-if="!timeline.length" class="muted timeline-empty">No revisions yet.</li>
          <li
            v-for="entry in timeline"
            :key="entry.revisionUri"
            :class="{ active: selectedTime === entry.createdAt }"
          >
            <button type="button" class="timeline-btn" @click="selectEntry(entry.createdAt)">
              <time>{{ formatDocumentDate(entry.createdAt) }}</time>
              <span class="timeline-note">{{ entry.noteTitle }}</span>
              <span v-if="entry.message" class="timeline-message muted">{{ entry.message }}</span>
            </button>
          </li>
        </ul>

        <div v-if="plan" class="rewind card">
          <div class="rewind-header">
            <div>
              <h2>Wiki as of {{ selectedLabel }}</h2>
              <p class="muted">
                {{ plan.restore.length }} changed · {{ plan.remove.length }} created later ·
                {{ plan.unchanged.length }} unchanged
              </p>
            </div>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="restoring || isCurrent"
              @click="restore"
            >
              {{ restoring ? 'Rewinding…' : 'Rewind to here' }}
            </button>
          </div>

          <p v-if="errorText" class="error-text">{{ errorText }}</p>
          <p v-if="isCurrent" class="muted">The wiki already matches this point.</p>

          <div v-if="plan.restore.length" class="rewind-group">
            <h3>Will roll back</h3>
            <ul class="rewind-list">
              <li v-for="state in plan.restore" :key="state.note.uri">
                <button type="button" class="rewind-item" @click="toggle(state.note.uri)">
                  <span class="rewind-caret" :class="{ open: expanded.has(state.note.uri) }">›</span>
                  {{ state.note.title }}
                  <code>{{ state.note.slug }}</code>
                </button>
                <div v-if="expanded.has(state.note.uri)" class="rewind-diff">
                  <p class="muted rewind-diff-label">Current → this version</p>
                  <RevisionDiff :old-text="state.note.content" :new-text="state.contentAtTime" />
                </div>
              </li>
            </ul>
          </div>

          <div v-if="plan.remove.length" class="rewind-group">
            <h3>Will be deleted (created after this point)</h3>
            <ul class="rewind-list">
              <li v-for="state in plan.remove" :key="state.note.uri" class="rewind-remove">
                {{ state.note.title }} <code>{{ state.note.slug }}</code>
              </li>
            </ul>
          </div>
        </div>
        <div v-else class="rewind card muted">
          Select a point in the timeline to preview a wiki-wide rewind.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.versions-page {
  padding: 2rem 1.25rem 4rem;
}

.versions-inner {
  max-width: 1000px;
  margin: 0 auto;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.versions-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 1rem;
  margin-top: 1.5rem;
}

@media (max-width: 768px) {
  .versions-layout {
    grid-template-columns: 1fr;
  }
}

.timeline {
  list-style: none;
  margin: 0;
  padding: 0.5rem;
  max-height: 70vh;
  overflow: auto;
}

.timeline-empty {
  padding: 0.75rem;
}

.timeline li {
  border-bottom: 1px solid var(--pckt-border);
}

.timeline li:last-child {
  border-bottom: none;
}

.timeline li.active .timeline-btn {
  background: var(--pckt-accent-soft);
}

.timeline-btn {
  width: 100%;
  text-align: left;
  padding: 0.625rem 0.75rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.timeline-btn time {
  display: block;
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
}

.timeline-note {
  display: block;
  margin-top: 0.2rem;
  font-weight: 600;
  font-size: 0.9375rem;
}

.timeline-message {
  display: block;
  margin-top: 0.15rem;
  font-size: 0.8125rem;
}

.rewind {
  padding: 1.25rem;
}

.rewind-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.rewind-header h2 {
  margin: 0;
  font-size: 1rem;
}

.rewind-header p {
  margin: 0.2rem 0 0;
  font-size: 0.8125rem;
}

.rewind-group {
  margin-top: 1rem;
}

.rewind-group h3 {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--pckt-text-muted);
}

.rewind-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.rewind-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: none;
  padding: 0.3rem 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
}

.rewind-caret {
  display: inline-block;
  transition: transform 0.15s ease;
}

.rewind-caret.open {
  transform: rotate(90deg);
}

.rewind-remove {
  font-size: 0.9375rem;
  color: var(--pckt-text-muted);
}

.rewind-diff {
  margin: 0.4rem 0 0.6rem;
}

.rewind-diff-label {
  margin: 0 0 0.35rem;
  font-size: 0.75rem;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.8125em;
}
</style>
