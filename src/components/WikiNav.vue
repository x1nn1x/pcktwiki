<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import type { LichenNoteWithContent } from '@/types/lichen'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { createBlockDragController } from '@/lib/block-drag'
import {
  hiddenNotesForSidebar,
  noteNavLabel,
  orderNotesForSidebar,
} from '@/lib/lichen/sidebar-order'

const props = defineProps<{
  notes: LichenNoteWithContent[]
  ownerHandle: string
  wikiSlug: string
  activeSlug?: string
  canManage?: boolean
  sidebarOrder?: string[]
}>()

const auth = useAuthStore()
const lichen = useLichenStore()
const editMode = useWikiEditMode()

const COMMIT_ID = 'wiki-sidebar-order'

/** Local draft while edit mode is open; null means use saved order. */
const draftOrder = ref<string[] | null>(null)
/** Draft sidebar labels keyed by slug; empty string = clear custom label. */
const draftNavTitles = ref<Record<string, string> | null>(null)

const effectiveOrder = computed(() => draftOrder.value ?? props.sidebarOrder)

const orderedNotes = computed(() =>
  orderNotesForSidebar(props.notes, effectiveOrder.value),
)

const hiddenNotes = computed(() =>
  hiddenNotesForSidebar(props.notes, effectiveOrder.value),
)

const reorderable = computed(
  () => Boolean(props.canManage) && editMode.active.value,
)

const basePath = computed(
  () => `/@${encodeURIComponent(props.ownerHandle)}/${encodeURIComponent(props.wikiSlug)}`,
)

const navListRef = ref<HTMLElement | null>(null)

function sameOrder(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((slug, index) => slug === right[index])
}

function slugsFromNotes(notes: LichenNoteWithContent[]): string[] {
  return notes.map((note) => note.slug)
}

function savedNavTitles(): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const note of props.notes) {
    if (note.navTitle?.trim()) titles[note.slug] = note.navTitle.trim()
  }
  return titles
}

function beginDraft() {
  draftOrder.value = slugsFromNotes(orderNotesForSidebar(props.notes, props.sidebarOrder))
  draftNavTitles.value = savedNavTitles()
}

function discardDraft() {
  draftOrder.value = null
  draftNavTitles.value = null
}

function displayLabel(note: LichenNoteWithContent): string {
  if (draftNavTitles.value && Object.prototype.hasOwnProperty.call(draftNavTitles.value, note.slug)) {
    const draft = draftNavTitles.value[note.slug]?.trim()
    return draft || note.title
  }
  return noteNavLabel(note)
}

function draftNavTitleValue(note: LichenNoteWithContent): string {
  if (draftNavTitles.value && Object.prototype.hasOwnProperty.call(draftNavTitles.value, note.slug)) {
    return draftNavTitles.value[note.slug] ?? ''
  }
  return note.navTitle ?? ''
}

function setDraftNavTitle(slug: string, value: string) {
  if (!draftNavTitles.value) draftNavTitles.value = savedNavTitles()
  draftNavTitles.value = { ...draftNavTitles.value, [slug]: value }
}

async function commitSidebarOrder(): Promise<boolean> {
  if (!auth.agent) return false

  try {
    if (draftOrder.value) {
      const saved = props.sidebarOrder
      const alphabetical = slugsFromNotes(orderNotesForSidebar(props.notes, null))
      const orderUnchanged =
        (saved !== undefined && sameOrder(draftOrder.value, saved)) ||
        (saved === undefined && sameOrder(draftOrder.value, alphabetical))
      // Entering edit mode seeds a full A–Z draft; don't persist that unless the
      // wiki already had a custom order or the user actually changed the list.
      if (!orderUnchanged) {
        await lichen.setWikiSidebarOrder(auth.agent, draftOrder.value)
      }
    }

    if (draftNavTitles.value) {
      const previous = savedNavTitles()
      const next = draftNavTitles.value
      const slugs = new Set([...Object.keys(previous), ...Object.keys(next)])
      for (const slug of slugs) {
        const before = (previous[slug] ?? '').trim()
        const after = (next[slug] ?? '').trim()
        if (before === after) continue
        const note = props.notes.find((item) => item.slug === slug)
        if (!note) continue
        await lichen.setNoteNavTitle(auth.agent, note, after)
      }
    }

    draftOrder.value = null
    draftNavTitles.value = null
    return true
  } catch {
    return false
  }
}

function ensureDraft(): string[] {
  if (!draftOrder.value) beginDraft()
  return draftOrder.value ?? []
}

function onReorder(fromIndex: number, toIndex: number) {
  const current = ensureDraft()
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= current.length ||
    toIndex >= current.length ||
    fromIndex === toIndex
  ) {
    return
  }
  const next = [...current]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  draftOrder.value = next
}

function removeFromSidebar(slug: string) {
  draftOrder.value = ensureDraft().filter((item) => item !== slug)
}

function addToSidebar(slug: string) {
  const current = ensureDraft()
  if (current.includes(slug)) return
  draftOrder.value = [...current, slug]
}

const drag = createBlockDragController({ onReorder })

async function refreshDragHandles() {
  const root = navListRef.value
  if (!root) return
  drag.detachHandles(root)
  if (!reorderable.value) return
  await nextTick()
  if (navListRef.value) drag.attachHandles(navListRef.value)
}

watch(
  () => editMode.active.value,
  (active) => {
    if (active && props.canManage) {
      beginDraft()
      editMode.registerCommit(COMMIT_ID, commitSidebarOrder)
    } else {
      editMode.unregisterCommit(COMMIT_ID)
      discardDraft()
    }
    void refreshDragHandles()
  },
)

watch(
  () => [props.canManage, props.sidebarOrder, props.notes] as const,
  () => {
    if (editMode.active.value && props.canManage && draftOrder.value === null) {
      beginDraft()
    }
    if (!editMode.active.value || !props.canManage) {
      editMode.unregisterCommit(COMMIT_ID)
    }
    void refreshDragHandles()
  },
  { deep: true },
)

watch(orderedNotes, () => {
  void refreshDragHandles()
})

onMounted(() => {
  if (editMode.active.value && props.canManage) {
    beginDraft()
    editMode.registerCommit(COMMIT_ID, commitSidebarOrder)
  }
  void refreshDragHandles()
})

onUnmounted(() => {
  if (navListRef.value) drag.detachHandles(navListRef.value)
  editMode.unregisterCommit(COMMIT_ID)
})
</script>

<template>
  <nav class="wiki-nav-wrap" aria-label="Wiki navigation">
    <div class="wiki-nav-tools">
      <RouterLink :to="`${basePath}/recent`" class="nav-tool">Recent</RouterLink>
      <RouterLink :to="`${basePath}/search`" class="nav-tool">Search</RouterLink>
    </div>

    <!-- Wikipedia renders sidebar sections as a plain heading over a link
         list — no collapsible button chrome, on desktop or mobile. -->
    <section class="wiki-nav-pages">
      <h2 class="wiki-nav-heading">Pages</h2>
      <div
        ref="navListRef"
        class="wiki-nav"
        :class="{ 'is-reordering': reorderable }"
        aria-label="Wiki articles"
      >
        <div
          v-for="(note, index) in orderedNotes"
          :key="note.uri"
          class="wiki-nav-row"
          :data-block-index="reorderable ? index : undefined"
        >
          <button
            v-if="reorderable"
            type="button"
            class="wiki-editor-block-handle wiki-nav-handle"
            :aria-label="`Drag to reorder ${displayLabel(note)}`"
            title="Drag to reorder"
          >
            <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
              <circle cx="2" cy="2" r="1.5" fill="currentColor" />
              <circle cx="8" cy="2" r="1.5" fill="currentColor" />
              <circle cx="2" cy="8" r="1.5" fill="currentColor" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" />
              <circle cx="2" cy="14" r="1.5" fill="currentColor" />
              <circle cx="8" cy="14" r="1.5" fill="currentColor" />
            </svg>
          </button>
          <input
            v-if="reorderable"
            class="wiki-nav-label-input"
            type="text"
            maxlength="64"
            :value="draftNavTitleValue(note)"
            :placeholder="note.title"
            :aria-label="`Sidebar label for ${note.title}`"
            title="Sidebar label — leave blank to use the page title"
            @input="setDraftNavTitle(note.slug, ($event.target as HTMLInputElement).value)"
          />
          <RouterLink
            v-else
            :to="`${basePath}/${note.slug}`"
            class="wiki-nav-link"
            :class="{ active: note.slug === activeSlug }"
          >
            {{ displayLabel(note) }}
          </RouterLink>
          <button
            v-if="reorderable"
            type="button"
            class="wiki-nav-remove"
            :aria-label="`Remove ${displayLabel(note)} from sidebar`"
            title="Remove from sidebar"
            @click="removeFromSidebar(note.slug)"
          >
            ×
          </button>
        </div>

        <p v-if="reorderable && !orderedNotes.length" class="wiki-nav-empty muted">
          No pages in the sidebar.
        </p>
        <p v-if="reorderable && orderedNotes.length" class="wiki-nav-hint muted">
          Edit a label to rename it in the sidebar. Leave blank to use the page title.
        </p>
      </div>

      <div
        v-if="reorderable && hiddenNotes.length"
        class="wiki-nav-hidden"
        aria-label="Pages hidden from sidebar"
      >
        <p class="wiki-nav-hidden-label">Add to sidebar</p>
        <button
          v-for="note in hiddenNotes"
          :key="note.uri"
          type="button"
          class="wiki-nav-add"
          @click="addToSidebar(note.slug)"
        >
          <span class="wiki-nav-add-plus" aria-hidden="true">+</span>
          {{ displayLabel(note) }}
        </button>
      </div>
    </section>
  </nav>
</template>

<style scoped>
.wiki-nav-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.wiki-nav-tools {
  display: flex;
  gap: 0.35rem;
}

.nav-tool {
  flex: 1;
  text-align: center;
  padding: 0.45rem 0.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  border-radius: var(--pckt-radius-sm);
  border: 1px solid var(--pckt-border);
  color: var(--pckt-text-muted);
  text-decoration: none;
}

.nav-tool:hover,
.nav-tool.router-link-active {
  background: color-mix(in srgb, var(--pckt-blue) 10%, var(--pckt-bg));
  color: var(--pckt-blue-active);
  text-decoration: none;
}

.wiki-nav-pages {
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  overflow: hidden;
}

.wiki-nav-heading {
  margin: 0;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--pckt-border);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pckt-text-muted);
}

.wiki-nav {
  display: flex;
  flex-direction: column;
  padding: 0.35rem;
  gap: 0.15rem;
}

.wiki-nav-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

.wiki-nav-link {
  flex: 1;
  min-width: 0;
  display: block;
  padding: 0.55rem 0.65rem;
  border-radius: var(--pckt-radius-sm);
  color: var(--pckt-text);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.wiki-nav-link:hover {
  background: color-mix(in srgb, var(--pckt-text) 6%, transparent);
  text-decoration: none;
}

.wiki-nav-link.active {
  background: color-mix(in srgb, var(--pckt-blue) 12%, transparent);
  color: var(--pckt-blue-active);
  font-weight: 700;
}

.wiki-nav-label-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.45rem 0.55rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.3;
}

.wiki-nav-label-input::placeholder {
  color: var(--pckt-text-muted);
  opacity: 0.85;
}

.wiki-nav-label-input:focus {
  outline: 2px solid var(--pckt-blue);
  outline-offset: -1px;
}

.wiki-nav.is-reordering .wiki-nav-row {
  padding: 0.15rem 0;
}

.wiki-nav-handle {
  flex-shrink: 0;
}

.wiki-nav-remove {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text-muted);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}

.wiki-nav-remove:hover {
  background: color-mix(in srgb, var(--pckt-text) 6%, transparent);
  color: var(--pckt-text);
}

.wiki-nav-empty,
.wiki-nav-hint {
  margin: 0.35rem 0.5rem 0.5rem;
  font-size: 0.75rem;
  line-height: 1.4;
}

.wiki-nav-hidden {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.5rem 0.5rem 0.65rem;
  border-top: 1px solid var(--pckt-border);
}

.wiki-nav-hidden-label {
  margin: 0 0 0.15rem;
  padding: 0 0.25rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pckt-text-muted);
}

.wiki-nav-add {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding: 0.45rem 0.55rem;
  border: none;
  border-radius: var(--pckt-radius-sm);
  background: transparent;
  color: var(--pckt-text);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.wiki-nav-add:hover {
  background: color-mix(in srgb, var(--pckt-text) 6%, transparent);
}

.wiki-nav-add-plus {
  color: var(--pckt-blue);
  font-weight: 700;
}
</style>
