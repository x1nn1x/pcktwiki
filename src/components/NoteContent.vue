<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { LichenNoteWithContent, LichenHeaderLink } from '@/types/lichen'
import type { StandardSiteDocument, StandardSitePublication } from '@/types/lichen'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import TableOfContents from '@/components/TableOfContents.vue'
import BlogListEmbed from '@/components/BlogListEmbed.vue'
import BacklinksPanel from '@/components/BacklinksPanel.vue'
import ArticleKnowledgeGraph from '@/components/ArticleKnowledgeGraph.vue'
import ReferencedByPanel from '@/components/ReferencedByPanel.vue'
import RelationshipsPanel from '@/components/RelationshipsPanel.vue'
import TalkCommentsPanel from '@/components/TalkCommentsPanel.vue'
import CategoryTagList from '@/components/CategoryTagList.vue'
import WikiHeaderLinks from '@/components/WikiHeaderLinks.vue'
import WikiEditable from '@/components/WikiEditable.vue'
import WikiInlineNoteEditor from '@/components/WikiInlineNoteEditor.vue'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import type { Backlink } from '@/lib/lichen/backlinks'
import {
  isTalkSlug,
  parseNoteContent,
  subjectSlugFromTalk,
} from '@/lib/lichen/content-meta'
import { findWikiNoteForBlogPost } from '@/lib/blog-sync'
import { templateLabel } from '@/lib/lichen/templates'
import { collectWikiRelations, relationsForNote } from '@/lib/lichen/relations'
import { useReaderPrefs } from '@/composables/useReaderPrefs'
import {
  extractTocFromMarkdown,
  headingIdCounts,
  splitLeadSection,
  type TocEntry,
} from '@/lib/toc'

const props = defineProps<{
  note: LichenNoteWithContent
  ownerHandle: string
  wikiSlug: string
  backlinks: Backlink[]
  referenceSubjects?: string[]
  blogPosts?: StandardSiteDocument[]
  publications?: StandardSitePublication[]
  wikiNotes?: LichenNoteWithContent[]
  subheaderLinks?: LichenHeaderLink[]
  ownerDid?: string
  canEdit?: boolean
  canManage?: boolean
}>()

const emit = defineEmits<{
  'save-talk': [content: string]
}>()

const auth = useAuthStore()
const lichen = useLichenStore()
const { active: editModeActive, openTarget, closeModal, enter } = useWikiEditMode()
const { hideNonMain } = useReaderPrefs()
const spoilerRevealed = ref(false)
const keepingCurrent = ref(false)
const keepError = ref('')
const damageDismissed = ref(false)

/** Article editor is the edit-mode surface — not a click-to-open modal. */
const editingNote = computed(() => !!props.canEdit && editModeActive.value)
/** Damage warnings are admin-only housekeeping — readers never see them. */
const showDamageBanner = computed(
  () => !!props.canManage && !!props.note.damagedRevisions && !damageDismissed.value,
)
const canKeepCurrent = computed(() => !!props.canEdit && !!auth.agent)
const showSubheaderEditable = computed(
  () =>
    !!props.subheaderLinks?.length ||
    (!!props.canEdit && (editModeActive.value || openTarget.value === 'subheaderLinks')),
)

const parsed = computed(() => parseNoteContent(props.note.content))
const bodyIsEmpty = computed(() => !parsed.value.body.trim())

/**
 * Wikipedia places the Contents box after the lead section, before the first
 * `##` heading. To do that, the article renders as two markdown chunks with
 * the box between them — but only when there is a table of contents worth
 * showing (two or more sections).
 */
const articleSplit = computed<{
  lead: string
  rest: string
  entries: TocEntry[]
  leadHeadingCounts: Map<string, number>
} | null>(() => {
  const body = parsed.value.body
  const entries = extractTocFromMarkdown(body)
  if (entries.length < 2 || bodyIsEmpty.value) return null
  const { lead, rest } = splitLeadSection(body)
  return {
    lead,
    rest,
    entries,
    leadHeadingCounts: headingIdCounts(lead),
  }
})
const showBlogList = computed(() => props.note.slug === 'blog')
const isTalk = computed(() => isTalkSlug(props.note.slug))
const talkSubjectSlug = computed(() => subjectSlugFromTalk(props.note.slug))
const templateName = computed(() => templateLabel(parsed.value.template))
const showMetaRow = computed(
  () =>
    !!templateName.value ||
    (!!parsed.value.canon && parsed.value.canon !== 'main') ||
    parsed.value.status === 'draft' ||
    parsed.value.status === 'stub' ||
    !!parsed.value.date ||
    !!parsed.value.era ||
    parsed.value.categories.length > 0,
)

const hiddenByCanon = computed(() => {
  if (!hideNonMain.value) return false
  const canon = parsed.value.canon ?? 'main'
  return canon !== 'main' && !spoilerRevealed.value
})

const relationEdges = computed(() =>
  collectWikiRelations(props.wikiNotes ?? [props.note]),
)
const noteRelations = computed(() =>
  relationsForNote(relationEdges.value, props.note.slug),
)

const blogWikiLinks = computed(() => {
  if (!props.blogPosts?.length || !props.wikiNotes?.length) return new Map<string, LichenNoteWithContent>()
  const map = new Map<string, LichenNoteWithContent>()
  for (const post of props.blogPosts) {
    const wikiNote = findWikiNoteForBlogPost(post, props.wikiNotes)
    if (wikiNote) map.set(post.uri, wikiNote)
  }
  return map
})

function startWriting() {
  enter()
}

async function keepCurrentVersion() {
  keepError.value = ''
  if (!canKeepCurrent.value || !auth.agent) {
    damageDismissed.value = true
    return
  }
  keepingCurrent.value = true
  try {
    await lichen.acceptCurrentNoteContent(
      auth.agent,
      props.note,
      props.ownerHandle,
      props.wikiSlug,
    )
    damageDismissed.value = true
  } catch (err) {
    keepError.value = err instanceof Error ? err.message : 'Could not keep this version'
  } finally {
    keepingCurrent.value = false
  }
}

function dismissDamageBanner() {
  damageDismissed.value = true
}
</script>

<template>
  <article class="page-content">
    <WikiInlineNoteEditor
      v-if="editingNote"
      mode="edit"
      :note="note"
      :owner-handle="ownerHandle"
      :wiki-slug="wikiSlug"
    />

    <template v-else>
      <header class="page-header">
        <div v-if="showDamageBanner" class="damaged-banner" role="status">
          <p class="damaged-banner-text">
            Missing
            {{ note.damagedRevisions === 1 ? '1 past edit' : `${note.damagedRevisions} past edits` }}.
            <RouterLink
              :to="{
                path: `/@${ownerHandle}/${wikiSlug}/${note.slug}/history`,
                query: { focus: 'damaged' },
              }"
            >
              Review missing edits
            </RouterLink>
          </p>
          <div class="damaged-banner-actions">
            <button
              v-if="canKeepCurrent"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="keepingCurrent"
              title="Save the text on this page as complete and hide this warning"
              @click="keepCurrentVersion"
            >
              {{ keepingCurrent ? 'Saving…' : 'Keep this version' }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-sm"
              @click="dismissDamageBanner"
            >
              Dismiss
            </button>
          </div>
          <p v-if="keepError" class="damaged-banner-error">{{ keepError }}</p>
        </div>
        <p v-if="isTalk" class="talk-banner">
          Discussion for
          <RouterLink :to="`/@${ownerHandle}/${wikiSlug}/${talkSubjectSlug}`">
            {{ talkSubjectSlug }}
          </RouterLink>
        </p>
        <div class="page-title-row">
          <h1>{{ note.title }}</h1>
          <button
            v-if="canEdit"
            type="button"
            class="article-edit-link"
            title="Edit this page"
            @click="startWriting"
          >
            Edit
          </button>
        </div>
        <WikiEditable
          v-if="showSubheaderEditable"
          target="subheaderLinks"
          auto-open
          :allowed="!!canEdit"
          label="Edit subheader links"
          seamless
        >
          <WikiHeaderLinks
            v-if="subheaderLinks?.length && ownerDid"
            :links="subheaderLinks"
            :owner-did="ownerDid"
            :owner-handle="ownerHandle"
            :wiki-slug="wikiSlug"
            kind="subheader"
          />
          <p v-else class="edit-empty muted">Add subheader links</p>
          <template #editor>
            <WikiHeaderLinks
              editing
              :links="subheaderLinks ?? []"
              :owner-did="ownerDid"
              :owner-handle="ownerHandle"
              :wiki-slug="wikiSlug"
              kind="subheader"
              :note="note"
              @saved="closeModal"
              @cancel="closeModal"
            />
          </template>
        </WikiEditable>
        <div v-if="showMetaRow" class="meta-row">
          <span v-if="templateName" class="badge badge-template">{{ templateName }}</span>
          <span v-if="parsed.canon && parsed.canon !== 'main'" class="badge badge-canon">
            {{ parsed.canon }}
          </span>
          <span v-if="parsed.status === 'draft'" class="badge">Draft</span>
          <span v-if="parsed.status === 'stub'" class="badge badge-muted">Stub</span>
          <span v-if="parsed.date || parsed.era" class="badge badge-muted">
            {{ [parsed.date, parsed.era].filter(Boolean).join(' · ') }}
          </span>
          <CategoryTagList
            v-if="parsed.categories.length"
            :categories="[]"
            :owner-handle="ownerHandle"
            :wiki-slug="wikiSlug"
            :note-categories="parsed.categories"
          />
        </div>
      </header>

      <div v-if="hiddenByCanon" class="canon-gate card">
        <p>
          This note is marked <strong>{{ parsed.canon }}</strong>.
          Main-canon filter is on.
        </p>
        <button type="button" class="btn btn-secondary btn-sm" @click="spoilerRevealed = true">
          Reveal anyway
        </button>
      </div>

      <template v-else>
        <button
          v-if="bodyIsEmpty && canEdit"
          type="button"
          class="start-writing"
          @click="startWriting"
        >
          Start writing your article…
        </button>
        <p v-else-if="bodyIsEmpty" class="start-writing start-writing--readonly muted">
          Nothing written yet.
        </p>
        <template v-else-if="articleSplit">
          <!-- Wikipedia order: lead section, Contents box, then the
               rest of the sections. The rest render seeds its heading ids
               from the lead so duplicate titles stay uniquely anchored. -->
          <MarkdownRenderer
            :source="articleSplit.lead"
            :wiki-slug="wikiSlug"
            :owner-handle="ownerHandle"
            :owner-did="ownerDid"
            :wiki-notes="wikiNotes"
            :can-edit="!!canEdit"
            @edit="startWriting"
          />
          <TableOfContents :entries="articleSplit.entries" />
          <MarkdownRenderer
            :source="articleSplit.rest"
            :wiki-slug="wikiSlug"
            :owner-handle="ownerHandle"
            :owner-did="ownerDid"
            :wiki-notes="wikiNotes"
            :heading-id-counts="articleSplit.leadHeadingCounts"
            :can-edit="!!canEdit"
            @edit="startWriting"
          />
        </template>
        <MarkdownRenderer
          v-else
          :source="note.content"
          :wiki-slug="wikiSlug"
          :owner-handle="ownerHandle"
          :owner-did="ownerDid"
          :wiki-notes="wikiNotes"
          :can-edit="!!canEdit"
          @edit="startWriting"
        />

        <ArticleKnowledgeGraph
          v-if="!isTalk && !bodyIsEmpty"
          :note="note"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
          :wiki-notes="wikiNotes"
          :backlinks="backlinks"
        />

        <RelationshipsPanel
          v-if="noteRelations.outgoing.length || noteRelations.incoming.length"
          :outgoing="noteRelations.outgoing"
          :incoming="noteRelations.incoming"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
        />

        <TalkCommentsPanel
          v-if="isTalk"
          :content="note.content"
          :can-edit="!!canEdit"
          @save="(next) => emit('save-talk', next)"
        />

        <BlogListEmbed
          v-if="showBlogList"
          :posts="blogPosts ?? []"
          :publications="publications ?? []"
          :wiki-note-links="blogWikiLinks"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
        />

        <BacklinksPanel
          :backlinks="backlinks"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
        />

        <ReferencedByPanel
          v-if="referenceSubjects?.length"
          :note="note"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
          :subjects="referenceSubjects"
          :can-manage="!!canManage"
        />
      </template>
    </template>
  </article>
</template>

<style scoped>
.page-content {
  padding: 1.5rem;
  border-radius: var(--pckt-radius-btn);
  border: 1px solid var(--pckt-border);
  background: var(--pckt-wiki-card-bg, transparent);
}

.page-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  margin: 0 0 0.75rem;
}

.page-title-row h1 {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-family: var(--pckt-font-content);
  font-size: clamp(1.75rem, 4vw, 2.25rem);
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

/* Quiet Wikipedia-style page Edit — sits with the title, not chrome. */
.article-edit-link {
  flex-shrink: 0;
  margin-top: 0.4em;
  padding: 0;
  border: none;
  background: none;
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
  cursor: pointer;
}

.article-edit-link:hover,
.article-edit-link:focus-visible {
  color: var(--pckt-text);
  text-decoration: underline;
  text-underline-offset: 0.15em;
  outline: none;
}

.page-header :deep(.wiki-header-links) {
  margin: 0 0 1rem;
}

.page-header :deep(.wiki-header-links.is-subheader) {
  justify-content: center;
  padding: 0.25rem 0 0.75rem;
  border-bottom: none;
}

.edit-empty {
  margin: 0 0 1rem;
  padding: 0.5rem 0.75rem;
  border: 1px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  font-size: 0.875rem;
}

.start-writing {
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 1rem;
  /* Match inline editor body — placeholder sits at the top, not centered.
     The 6px/2px sides mirror CodeMirror's own .cm-line padding, which the
     editor adds on top of .cm-content's, so the text doesn't shift on open. */
  padding: 0 2px 2rem 6px;
  min-height: 12rem;
  border: none;
  border-radius: var(--pckt-radius-btn);
  background: transparent;
  outline: var(--pckt-edit-dash);
  outline-offset: var(--pckt-edit-dash-offset);
  color: var(--pckt-text-subtle);
  font-family: var(--pckt-font-content);
  font-size: 1.0625rem;
  font-weight: 400;
  line-height: 1.75;
  text-align: left;
  cursor: pointer;
  transition: outline-color 0.12s ease, color 0.12s ease;
}

.start-writing:hover,
.start-writing:focus-visible {
  outline: var(--pckt-edit-dash-strong);
  outline-offset: var(--pckt-edit-dash-offset);
  color: var(--pckt-text-muted);
}

.start-writing--readonly {
  cursor: default;
  outline: 1.5px dashed color-mix(in srgb, var(--pckt-border) 80%, transparent);
}

.start-writing--readonly:hover,
.start-writing--readonly:focus-visible {
  outline: 1.5px dashed color-mix(in srgb, var(--pckt-border) 80%, transparent);
  color: var(--pckt-text-subtle);
}

.talk-banner {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
  color: var(--pckt-text-muted);
}

/* Content is knowingly incomplete — say so rather than render it as intact. */
.damaged-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin: 0 0 0.75rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid color-mix(in srgb, var(--pckt-yellow) 55%, var(--pckt-border));
  border-radius: var(--pckt-radius-btn);
  background: color-mix(in srgb, var(--pckt-yellow) 12%, transparent);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  color: var(--pckt-text);
}

.damaged-banner-text {
  margin: 0;
  flex: 1 1 12rem;
}

.damaged-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-left: auto;
}

.damaged-banner-error {
  flex: 1 1 100%;
  margin: 0;
  color: var(--pckt-danger);
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}

.badge-template {
  background: color-mix(in srgb, var(--pckt-accent-soft) 80%, transparent);
}

.badge-canon {
  text-transform: uppercase;
}

.canon-gate {
  padding: 1.25rem;
  display: grid;
  gap: 0.75rem;
}
</style>
