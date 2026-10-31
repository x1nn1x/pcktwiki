<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { normalizeHandle } from '@/lib/config'
import { computeMaintenanceReport } from '@/lib/lichen/maintenance'
import { canEdit } from '@/lib/lichen/collections'
import type { LichenNoteWithContent } from '@/types/lichen'

const route = useRoute()
const auth = useAuthStore()
const lichen = useLichenStore()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const canEditWiki = computed(() => canEdit(lichen.access))

const report = computed(() =>
  computeMaintenanceReport(lichen.notes, wikiSlug.value),
)

/** rkey is the only thing that tells two same-slug records apart. */
function rkeyOf(uri: string): string {
  return uri.split('/').pop() ?? uri
}

const deleting = ref('')
const deleteError = ref('')
const migrating = ref('')
const migrateError = ref('')

/**
 * Branches written with the old `/` separator match no route, so they cannot be
 * opened, merged, or deleted from the UI until their slug is moved onto the
 * current format. The record keeps its URI and history — only the slug changes.
 */
async function migrateBranch(note: LichenNoteWithContent) {
  if (!auth.agent) return
  migrateError.value = ''
  migrating.value = note.uri
  try {
    await lichen.migrateBranchSlug(auth.agent, note)
  } catch (err) {
    migrateError.value = err instanceof Error ? err.message : 'Failed to update the slug'
  } finally {
    migrating.value = ''
  }
}

/**
 * Deleting a record is destructive and cannot be undone, so it is always an
 * explicit per-record action behind a confirmation — never automatic, and never
 * applied in bulk.
 */
async function deleteRecord(note: LichenNoteWithContent, kind: string) {
  if (!auth.agent) return
  const revisions = lichen.getHistory(note.uri).length
  const ok = window.confirm(
    `Permanently delete this ${kind} "${note.slug}" record (${rkeyOf(note.uri)})?\n\n` +
      `It holds ${note.content.length} characters of content across ${revisions} ` +
      `revision${revisions === 1 ? '' : 's'}, which are deleted with it. This cannot be undone.`,
  )
  if (!ok) return

  deleteError.value = ''
  deleting.value = note.uri
  try {
    await lichen.removeNote(auth.agent, note)
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : 'Failed to delete the record'
  } finally {
    deleting.value = ''
  }
}

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
</script>

<template>
  <div class="maintenance-page">
    <div class="inner">
      <header>
        <RouterLink :to="`/@${handle}/${wikiSlug}`" class="muted">← Wiki home</RouterLink>
        <h1>Maintenance</h1>
        <p class="muted">Wanted pages, stubs, drafts, and orphan notes.</p>
      </header>

      <section v-if="report.duplicates.length" class="card section">
        <h2>Duplicate slugs ({{ report.duplicates.length }})</h2>
        <p class="muted">
          Several records share one address. Only the first is reachable — the rest are
          stranded, but still count toward navigation and recent changes. Check the content
          size before deleting; anything written into a stranded record is lost with it.
        </p>
        <p v-if="deleteError" class="error-text">{{ deleteError }}</p>
        <div v-for="group in report.duplicates" :key="group.slug" class="dupe-group">
          <h3 class="dupe-slug">{{ group.slug }} · {{ group.notes.length }} records</h3>
          <ul class="list">
            <li v-for="note in group.notes" :key="note.uri">
              <div class="dupe-meta">
                <code>{{ rkeyOf(note.uri) }}</code>
                <span class="muted">
                  {{ note.content.length }} chars ·
                  {{ new Date(note.createdAt).toLocaleString() }}
                </span>
              </div>
              <span v-if="note.uri === group.reachable.uri" class="badge">reachable</span>
              <button
                v-else-if="canEditWiki"
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="deleting === note.uri"
                @click="deleteRecord(note, 'duplicate')"
              >
                {{ deleting === note.uri ? 'Deleting…' : 'Delete' }}
              </button>
              <span v-else class="muted">stranded</span>
            </li>
          </ul>
        </div>
      </section>

      <section v-if="report.branches.length" class="card section">
        <h2>Branches ({{ report.branches.length }})</h2>
        <p class="muted">
          Branches are kept out of the article list and reviewed from their parent page, so
          this is the only place they are listed. Ones whose parent article is gone have
          nothing left to merge into. Ones on the old slug format cannot be opened at all
          until their slug is updated.
        </p>
        <ul class="list">
          <li v-for="item in report.branches" :key="item.note.uri">
            <div class="dupe-meta">
              <span v-if="item.legacySlug">{{ item.note.title }}</span>
              <RouterLink v-else :to="`/@${handle}/${wikiSlug}/${item.note.slug}`">
                {{ item.note.title }}
              </RouterLink>
              <span class="muted">
                <code>{{ rkeyOf(item.note.uri) }}</code> ·
                {{ item.parentSlug ? `branch of ${item.parentSlug}` : 'no parent in slug' }} ·
                {{ item.note.content.length }} chars
              </span>
              <span v-if="item.legacySlug && item.migratedSlug" class="muted">
                <code>{{ item.note.slug }}</code> → <code>{{ item.migratedSlug }}</code>
              </span>
            </div>
            <span v-if="item.legacySlug" class="badge">unreachable</span>
            <span v-if="item.orphaned" class="badge">orphaned</span>
            <button
              v-if="canEditWiki && item.legacySlug && item.migratedSlug"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="migrating === item.note.uri"
              @click="migrateBranch(item.note)"
            >
              {{ migrating === item.note.uri ? 'Updating…' : 'Update slug' }}
            </button>
            <button
              v-if="canEditWiki"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="deleting === item.note.uri"
              @click="deleteRecord(item.note, 'branch')"
            >
              {{ deleting === item.note.uri ? 'Deleting…' : 'Delete' }}
            </button>
          </li>
        </ul>
        <p v-if="migrateError" class="error-text">{{ migrateError }}</p>
      </section>

      <section class="card section">
        <h2>Wanted pages ({{ report.wanted.length }})</h2>
        <ul v-if="report.wanted.length" class="list">
          <li v-for="item in report.wanted" :key="item.slug">
            <div>
              <strong>{{ item.label }}</strong>
              <span class="muted"> · linked from {{ item.referencedBy.length }} note{{ item.referencedBy.length === 1 ? '' : 's' }}</span>
            </div>
            <RouterLink
              v-if="canEditWiki"
              class="btn btn-secondary btn-sm"
              :to="`/@${handle}/${wikiSlug}/edit/${item.slug}`"
            >
              Create
            </RouterLink>
            <span v-else class="muted">{{ item.slug }}</span>
          </li>
        </ul>
        <p v-else class="muted">No red links — nice.</p>
      </section>

      <section class="card section">
        <h2>Stubs ({{ report.stubs.length }})</h2>
        <ul v-if="report.stubs.length" class="list">
          <li v-for="note in report.stubs" :key="note.uri">
            <RouterLink :to="`/@${handle}/${wikiSlug}/${note.slug}`">{{ note.title }}</RouterLink>
          </li>
        </ul>
        <p v-else class="muted">No stub notes.</p>
      </section>

      <section class="card section">
        <h2>Drafts ({{ report.drafts.length }})</h2>
        <ul v-if="report.drafts.length" class="list">
          <li v-for="note in report.drafts" :key="note.uri">
            <RouterLink :to="`/@${handle}/${wikiSlug}/${note.slug}`">{{ note.title }}</RouterLink>
          </li>
        </ul>
        <p v-else class="muted">No draft notes.</p>
      </section>

      <section class="card section">
        <h2>Orphan notes ({{ report.orphans.length }})</h2>
        <p class="muted">Notes with no inbound wikilinks (excluding home/talk/branches).</p>
        <ul v-if="report.orphans.length" class="list">
          <li v-for="note in report.orphans" :key="note.uri">
            <RouterLink :to="`/@${handle}/${wikiSlug}/${note.slug}`">{{ note.title }}</RouterLink>
          </li>
        </ul>
        <p v-else class="muted">No orphans.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.maintenance-page {
  padding: 2rem 1.25rem 4rem;
}

.inner {
  max-width: 720px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

header h1 {
  margin: 0.5rem 0 0.25rem;
  font-family: var(--pckt-font-content);
}

.section {
  padding: 1.25rem;
}

.section h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.list li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--pckt-border);
}

.dupe-group + .dupe-group {
  margin-top: 1rem;
}

.dupe-slug {
  margin: 0 0 0.25rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--pckt-text-muted);
}

.dupe-meta {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
  font-size: 0.8125rem;
}
</style>
