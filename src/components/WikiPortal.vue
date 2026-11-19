<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { LichenNoteWithContent } from '@/types/lichen'
import type { RecentChange } from '@/lib/lichen/recent-changes'
import type { WikiCategory } from '@/lib/lichen/categories'
import WikiPortalBox from '@/components/WikiPortalBox.vue'
import RecentChangesList from '@/components/RecentChangesList.vue'
import CategoryTagList from '@/components/CategoryTagList.vue'
import NewNoteTemplatePicker from '@/components/NewNoteTemplatePicker.vue'
import { parseNoteContent } from '@/lib/lichen/content-meta'
import { NOTE_TEMPLATES } from '@/lib/lichen/templates'
import { filterNotes } from '@/lib/lichen/timeline'
import { computeMaintenanceReport } from '@/lib/lichen/maintenance'
import { useReaderPrefs } from '@/composables/useReaderPrefs'
import { isBranchSlug } from '@/lib/lichen/branches'
import { isTalkSlug } from '@/lib/lichen/content-meta'

const props = defineProps<{
  ownerHandle: string
  wikiSlug: string
  notes: LichenNoteWithContent[]
  recentChanges: RecentChange[]
  categories: WikiCategory[]
  canEdit?: boolean
}>()

const { hideNonMain, toggleHideNonMain } = useReaderPrefs()

const templateFilter = ref<string | null>(null)

const randomNote = computed(() => {
  const pool = filteredNotes.value.filter(
    (note) => note.slug !== 'home' && !isTalkSlug(note.slug) && !isBranchSlug(note.slug),
  )
  if (pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
})

const filteredNotes = computed(() =>
  filterNotes(props.notes, {
    template: templateFilter.value,
    hideNonMain: hideNonMain.value,
  }),
)

const featuredNotes = computed(() =>
  filteredNotes.value
    .filter((note) => note.slug !== 'home' && !isTalkSlug(note.slug) && !isBranchSlug(note.slug))
    .slice(0, 5),
)

const maintenance = computed(() => computeMaintenanceReport(props.notes, props.wikiSlug))

const templateCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const note of props.notes) {
    const template = parseNoteContent(note.content).template
    if (!template) continue
    counts.set(template, (counts.get(template) ?? 0) + 1)
  }
  return NOTE_TEMPLATES
    .filter((item) => item.id !== 'blank' && (counts.get(item.id) ?? 0) > 0)
    .map((item) => ({ id: item.id, label: item.label, count: counts.get(item.id) ?? 0 }))
})

function setTemplate(id: string | null) {
  templateFilter.value = templateFilter.value === id ? null : id
}
</script>

<template>
  <div class="wiki-portal">
    <WikiPortalBox v-if="canEdit" title="Create" accent="red">
      <NewNoteTemplatePicker
        :owner-handle="ownerHandle"
        :wiki-slug="wikiSlug"
        :existing-slugs="notes.map((n) => n.slug)"
      />
      <RouterLink class="portal-more" :to="`/@${ownerHandle}/${wikiSlug}/inbox`">
        Open inbox →
      </RouterLink>
    </WikiPortalBox>

    <WikiPortalBox title="Filters" accent="yellow">
      <div class="filter-row">
        <button
          type="button"
          class="chip"
          :class="{ active: hideNonMain }"
          @click="toggleHideNonMain"
        >
          Main canon only
        </button>
        <button
          v-for="item in templateCounts"
          :key="item.id"
          type="button"
          class="chip"
          :class="{ active: templateFilter === item.id }"
          @click="setTemplate(item.id)"
        >
          {{ item.label }} ({{ item.count }})
        </button>
      </div>
    </WikiPortalBox>

    <WikiPortalBox title="World tools" accent="green">
      <ul class="explore-list">
        <li>
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/special/maintenance`">
            Maintenance
            <span v-if="maintenance.wanted.length" class="muted">
              · {{ maintenance.wanted.length }} wanted
            </span>
          </RouterLink>
        </li>
        <li>
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/special/timeline`">Timeline</RouterLink>
        </li>
        <li>
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/special/graph`">Relationships</RouterLink>
        </li>
        <li>
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/special/map`">Map</RouterLink>
        </li>
        <li>
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/special/import`">Import</RouterLink>
        </li>
      </ul>
    </WikiPortalBox>

    <WikiPortalBox title="Recent changes" accent="green">
      <RecentChangesList
        :changes="recentChanges"
        :owner-handle="ownerHandle"
        :wiki-slug="wikiSlug"
      />
      <RouterLink
        class="portal-more"
        :to="`/@${ownerHandle}/${wikiSlug}/recent`"
      >
        All recent changes →
      </RouterLink>
    </WikiPortalBox>

    <WikiPortalBox title="Categories" accent="yellow">
      <CategoryTagList
        v-if="categories.length"
        :categories="categories"
        :owner-handle="ownerHandle"
        :wiki-slug="wikiSlug"
      />
      <p v-else class="muted">Add <code>[[Category:Name]]</code> to articles to organize topics.</p>
    </WikiPortalBox>

    <WikiPortalBox title="Explore" accent="red">
      <ul class="explore-list">
        <li v-if="randomNote">
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/${randomNote.slug}`">
            Random article: {{ randomNote.title }}
          </RouterLink>
        </li>
        <li v-for="note in featuredNotes" :key="note.uri">
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/${note.slug}`">
            {{ note.title }}
          </RouterLink>
        </li>
      </ul>
    </WikiPortalBox>
  </div>
</template>

<style scoped>
.wiki-portal {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  min-width: 0;
}

.portal-more {
  display: inline-block;
  margin-top: 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
}

.explore-list {
  margin: 0;
  padding-left: 1.125rem;
}

.explore-list li {
  margin: 0.35rem 0;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.chip {
  border: 1px solid var(--pckt-border);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  font-size: 0.75rem;
  cursor: pointer;
}

.chip.active {
  border-color: var(--pckt-red);
  background: var(--pckt-accent-soft);
  color: var(--pckt-red);
  font-weight: 700;
}

code {
  font-family: var(--pckt-font-mono);
  font-size: 0.85em;
}

@media (max-width: 1100px) {
  .wiki-portal {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.875rem;
  }
}
</style>
