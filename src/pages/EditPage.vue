<script setup lang="ts">
import { appUrl } from '@/lib/base-url'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { loadWikiByHandle } from '@/lib/atproto/wiki-loader'
import { normalizeHandle } from '@/lib/config'
import { isValidSlug } from '@/lib/atproto/lichen'
import { findDisallowedImages } from '@/lib/lichen/collab'
import {
  isTalkSlug,
  noteKind,
  parseNoteContent,
  subjectSlugFromTalk,
  talkSlugFor,
} from '@/lib/lichen/content-meta'
import { postNewWikiImagesToBluesky } from '@/lib/atproto/bluesky-post'
import {
  branchNameFromSlug,
  createBranchSlug,
  isBranchSlug,
  listBranches,
  parentSlugFromBranch,
} from '@/lib/lichen/branches'
import { NOTE_TEMPLATES, type NoteTemplateId } from '@/lib/lichen/templates'
import {
  readEditPresence,
  startPresenceHeartbeat,
  type EditPresence,
} from '@/lib/lichen/presence'
import WikiEditor from '@/components/WikiEditor.vue'
import OfflineBanner from '@/components/OfflineBanner.vue'

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const auth = useAuthStore()
const lichen = useLichenStore()
const route = useRoute()
const router = useRouter()

const handle = computed(() => normalizeHandle(route.params.handle as string))
const wikiSlug = computed(() => route.params.wikiSlug as string)
const noteSlug = computed(() => route.params.noteSlug as string)

const title = ref('')
const body = ref('')
const message = ref('')
const baselineBody = ref('')
const isNewTalk = ref(false)
const isNewNote = ref(false)
const editorReady = ref(false)
const editorRef = ref<InstanceType<typeof WikiEditor> | null>(null)
const templateId = ref<NoteTemplateId>('blank')
const presenceOther = ref<EditPresence | null>(null)
const blueskyNotice = ref('')
const merging = ref(false)
const mergeError = ref('')
const deleting = ref(false)
const deleteError = ref('')
const suggestionBusy = ref(false)
const purgeOnSave = ref(false)
let stopPresence: (() => void) | null = null
let presencePoll: number | undefined

/**
 * Publishing means writing to the wiki's repo, which only the owner's session
 * can do. Everyone else with propose rights submits suggestions instead —
 * same editor, different save destination.
 */
const isOwner = computed(
  () => !!auth.did && !!lichen.currentWiki && lichen.currentWiki.ownerDid === auth.did,
)
const noteCaps = computed(() => lichen.capabilitiesForNote(noteSlug.value))
const canPublishHere = computed(() => isOwner.value)
const canSuggestHere = computed(() => !isOwner.value && noteCaps.value.canSuggest)
const canContributeHere = computed(() => canPublishHere.value || canSuggestHere.value)

const showPostToBluesky = computed(
  () =>
    !!auth.agent &&
    lichen.currentWiki?.visibility === 'public' &&
    !isTalkSlug(noteSlug.value) &&
    isOwner.value,
)

const hasTalkPage = computed(() => {
  const talkSlug = talkSlugFor(noteSlug.value)
  return lichen.notes.some((n) => n.slug === talkSlug)
})

const queryTemplate = computed(() => {
  const raw = route.query.template
  return typeof raw === 'string' ? raw : null
})

function applyTemplate(id: NoteTemplateId) {
  const template = NOTE_TEMPLATES.find((item) => item.id === id) ?? NOTE_TEMPLATES[0]
  templateId.value = template.id
  if (!title.value.trim()) title.value = template.defaultTitle
  if (!body.value.trim()) body.value = template.buildContent(title.value || template.defaultTitle)
}

async function loadEditor() {
  editorReady.value = false
  stopPresence?.()
  stopPresence = null

  if (!auth.agent) {
    router.replace('/')
    return
  }

  title.value = ''
  body.value = ''
  baselineBody.value = ''
  message.value = ''
  blueskyNotice.value = ''
  isNewTalk.value = false
  isNewNote.value = false
  templateId.value = 'blank'

  const did = await loadWikiByHandle(lichen, {
    handle: handle.value,
    wikiSlug: wikiSlug.value,
    viewerDid: auth.did,
    authAgent: auth.agent,
  })
  if (!did) return

  if (!canContributeHere.value) {
    router.replace(`/@${handle.value}/${wikiSlug.value}`)
    return
  }

  const note = lichen.getNoteBySlug(noteSlug.value)
  if (!note && isTalkSlug(noteSlug.value)) {
    isNewTalk.value = true
    const subject = subjectSlugFromTalk(noteSlug.value) ?? 'note'
    title.value = `Talk: ${subject}`
    body.value = `Discussion for [[${subject}]].\n\nShare feedback and suggested edits here.`
    baselineBody.value = body.value
    editorReady.value = true
    return
  }

  if (!note && noteSlug.value.includes(':') && !isTalkSlug(noteSlug.value) && !isBranchSlug(noteSlug.value)) {
    router.replace(`/@${handle.value}/${wikiSlug.value}`)
    return
  }

  if (!note) {
    if (!isValidSlug(noteSlug.value)) {
      router.replace(`/@${handle.value}/${wikiSlug.value}`)
      return
    }
    isNewNote.value = true
    title.value = titleFromSlug(noteSlug.value)
    body.value = ''
    baselineBody.value = ''
    if (queryTemplate.value) {
      applyTemplate(queryTemplate.value as NoteTemplateId)
    }
    editorReady.value = true
    return
  }

  title.value = note.title
  body.value = note.content
  baselineBody.value = note.content
  editorReady.value = true
  beginPresence()
}

function beginPresence() {
  if (!auth.did || !lichen.currentWiki) return
  stopPresence?.()
  stopPresence = startPresenceHeartbeat(() => ({
    noteSlug: noteSlug.value,
    wikiUri: lichen.currentWiki!.uri,
    did: auth.did!,
    handle: auth.handle ?? undefined,
    updatedAt: Date.now(),
  }))
  const poll = () => {
    if (!lichen.currentWiki) return
    presenceOther.value = readEditPresence(lichen.currentWiki.uri, noteSlug.value, auth.did)
  }
  poll()
  presencePoll = window.setInterval(poll, 5000)
}

onMounted(loadEditor)
watch(() => route.fullPath, loadEditor)
onUnmounted(() => {
  stopPresence?.()
  if (presencePoll) window.clearInterval(presencePoll)
})

async function maybePostImagesToBluesky(opts: {
  queued: boolean
  previousContent: string
  nextContent: string
  noteSlug: string
  title: string
}): Promise<void> {
  blueskyNotice.value = ''
  if (!auth.agent) return
  if (!editorRef.value?.shouldPostToBluesky()) return
  if (!showPostToBluesky.value) return
  if (isTalkSlug(opts.noteSlug)) return

  const parsed = parseNoteContent(opts.nextContent)
  if (parsed.status === 'draft') return

  if (opts.queued) {
    const msg =
      'Note saved offline. Images were not posted to Bluesky — publish again when online.'
    blueskyNotice.value = msg
    window.alert(msg)
    return
  }

  try {
    const noteUrl = appUrl(`/@${handle.value}/${wikiSlug.value}/${opts.noteSlug}`)
    await postNewWikiImagesToBluesky(auth.agent, {
      title: opts.title,
      noteUrl,
      wikiSlug: wikiSlug.value,
      categories: parsed.categories,
      previousContent: opts.previousContent,
      nextContent: opts.nextContent,
      sessionBlobs: editorRef.value.getSessionBlobs(),
    })
  } catch (err) {
    const msg =
      err instanceof Error
        ? `Note saved, but Bluesky post failed: ${err.message}`
        : 'Note saved, but Bluesky post failed.'
    blueskyNotice.value = msg
    window.alert(msg)
  }
}

async function save() {
  if (!auth.agent) return

  const previousContent = baselineBody.value
  const nextContent = body.value
  const nextTitle = title.value
  const slug = noteSlug.value

  if (canSuggestHere.value) {
    await submitAsSuggestion(previousContent, nextContent, nextTitle)
    return
  }

  let note = lichen.getNoteBySlug(slug)
  const stagedLinks = isNewNote.value
    ? (editorRef.value?.getSubheaderLinks() ?? [])
    : []

  if (!note && (isNewTalk.value || isNewNote.value)) {
    note = await lichen.createNoteWithSlug(
      auth.agent,
      slug,
      nextTitle,
      nextContent,
      message.value || (isNewTalk.value ? 'Start discussion' : 'Initial revision'),
      editorRef.value?.getContentBlobs(),
    )
    if (stagedLinks.length) {
      await lichen.setNoteSubheaderLinks(auth.agent, note, stagedLinks)
    }
    await maybePostImagesToBluesky({
      queued: false,
      previousContent,
      nextContent,
      noteSlug: note.slug,
      title: nextTitle,
    })
    router.push(`/@${handle.value}/${wikiSlug.value}/${note.slug}`)
    return
  }

  if (!note) return

  if (presenceOther.value) {
    const proceed = confirm(
      `@${presenceOther.value.handle ?? 'someone'} may also be editing this note. Save anyway?`,
    )
    if (!proceed) return
  }

  const result = await lichen.queueOrSaveNoteEdit(
    auth.agent,
    note,
    nextTitle,
    nextContent,
    message.value || undefined,
    handle.value,
    wikiSlug.value,
    editorRef.value?.getContentBlobs(),
    purgeOnSave.value,
  )

  await maybePostImagesToBluesky({
    queued: result === 'queued',
    previousContent,
    nextContent,
    noteSlug: note.slug,
    title: nextTitle,
  })

  router.push(`/@${handle.value}/${wikiSlug.value}/${note.slug}`)
}

/**
 * Suggestion-mode save: the proposal is filed as a `wiki.pckt.suggestion`
 * record in the contributor's own repo (the wiki repo is not writable by
 * them), where the wiki owner's review queue picks it up.
 */
async function submitAsSuggestion(previousContent: string, nextContent: string, nextTitle: string) {
  if (!auth.agent || !lichen.currentWiki) return

  const disallowed = findDisallowedImages(
    previousContent,
    nextContent,
    lichen.approvedMedia,
    noteCaps.value.imageMode,
  )
  if (disallowed.length) {
    const rule =
      noteCaps.value.imageMode === 'none'
        ? 'This wiki only accepts text-only edits'
        : 'This wiki only accepts approved photos'
    window.alert(
      `${rule} — your proposal adds ${disallowed.length === 1 ? 'an image' : `${disallowed.length} images`}.`,
    )
    return
  }

  const note = lichen.getNoteBySlug(noteSlug.value)
  const titleChanged = !note || nextTitle.trim() !== note.title
  suggestionBusy.value = true
  try {
    await lichen.submitSuggestion(auth.agent, {
      noteSlug: noteSlug.value,
      kind: 'edit',
      content: nextContent,
      title: titleChanged ? nextTitle : undefined,
      baseRevision: note?.latestRevisionUri ?? undefined,
      message: message.value.trim() || undefined,
    })
    window.alert(
      'Suggestion submitted. The wiki owner can review and publish it from the wiki’s suggestions page.',
    )
    router.push(`/@${handle.value}/${wikiSlug.value}${note ? `/${note.slug}` : ''}`)
  } catch (err) {
    window.alert(err instanceof Error ? err.message : 'Could not submit the suggestion')
  } finally {
    suggestionBusy.value = false
  }
}

async function createBranch() {
  if (!auth.agent) return
  const name = prompt('Branch name')
  if (!name?.trim()) return
  const slug = createBranchSlug(
    noteSlug.value,
    name.trim(),
    lichen.notes.map((n) => n.slug),
  )
  const note = lichen.getNoteBySlug(noteSlug.value)
  if (!note) return
  await lichen.createNoteWithSlug(
    auth.agent,
    slug,
    `${note.title} (${name.trim()})`,
    note.content,
    `Branch of ${noteSlug.value}`,
  )
  router.push(`/@${handle.value}/${wikiSlug.value}/edit/${slug}`)
}

/**
 * Merging deletes the branch, so the confirmation spells out both halves: the
 * history is preserved on the parent, the branch record itself is not.
 */
async function mergeBranchToMain() {
  if (!auth.agent) return
  const parent = parentSlugFromBranch(noteSlug.value)
  if (!parent) return
  const branchNote = lichen.getNoteBySlug(noteSlug.value)
  const parentNote = lichen.getNoteBySlug(parent)
  if (!branchNote || !parentNote) return

  const count = lichen.countMergeableRevisions(branchNote)
  const drifted = parentNote.content !== branchNote.content
  const ok = confirm(
    `Merge this branch into "${parent}"?\n\n` +
      `${count} revision${count === 1 ? '' : 's'} will be replayed onto "${parent}", ` +
      `which then takes the branch's content exactly` +
      `${drifted ? ', overwriting any edits made to it since the branch was taken' : ''}. ` +
      `The branch is deleted afterwards.`,
  )
  if (!ok) return

  mergeError.value = ''
  merging.value = true
  try {
    await lichen.mergeBranchIntoParent(auth.agent, branchNote, parentNote)
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : 'Failed to merge the branch'
    return
  } finally {
    merging.value = false
  }
  router.push(`/@${handle.value}/${wikiSlug.value}/${parent}`)
}

const branchNotes = computed(() =>
  isBranchSlug(noteSlug.value)
    ? []
    : listBranches(lichen.notes, noteSlug.value),
)

/** "article" / "discussion" / "branch" — never the internal "note" or "page". */
const kindLabel = computed(() => noteKind(noteSlug.value))

/**
 * Deleting is unrecoverable — there is no note-level trash — so it names what
 * goes with the record and what is left stranded, following the same
 * per-record confirmation the Maintenance page uses for duplicates.
 */
async function deleteNote() {
  if (!auth.agent) return
  const note = lichen.getNoteBySlug(noteSlug.value)
  if (!note) return

  const revisionCount = lichen.getHistory(note.uri).length
  const orphaned = branchNotes.value.length
  const ok = confirm(
    `Permanently delete this ${kindLabel.value}, "${note.title}"?\n\n` +
      `Its ${revisionCount} revision${revisionCount === 1 ? '' : 's'} ` +
      `${revisionCount === 1 ? 'is' : 'are'} deleted with it. ` +
      (orphaned
        ? `${orphaned} branch${orphaned === 1 ? '' : 'es'} taken from it will be left ` +
          `with nothing to merge into. `
        : '') +
      `This cannot be undone.`,
  )
  if (!ok) return

  deleteError.value = ''
  deleting.value = true
  try {
    await lichen.removeNote(auth.agent, note)
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : `Failed to delete the ${kindLabel.value}`
    return
  } finally {
    deleting.value = false
  }

  // A branch or discussion belongs to a subject page; send the editor back
  // there rather than to the wiki root.
  const home = parentSlugFromBranch(noteSlug.value) ?? subjectSlugFromTalk(noteSlug.value)
  router.push(`/@${handle.value}/${wikiSlug.value}${home ? `/${home}` : ''}`)
}

const editingNote = computed(() =>
  isNewNote.value || isNewTalk.value ? null : lichen.getNoteBySlug(noteSlug.value) ?? null,
)
</script>

<template>
  <div class="edit-page">
    <div class="edit-inner">
      <OfflineBanner />

      <p v-if="presenceOther" class="presence-banner">
        Someone else may be editing
        <template v-if="presenceOther.handle"> (@{{ presenceOther.handle }})</template>
        — saves can conflict.
      </p>

      <p v-if="canSuggestHere" class="presence-banner suggest-banner">
        You’re proposing an edit to <strong>@{{ handle }}</strong>’s wiki. Saving files a
        suggestion on your own account for the wiki owner to review — nothing changes on the
        wiki until it’s approved.
        <template v-if="noteCaps.imageMode === 'none'"> This wiki accepts text-only edits.</template>
        <template v-else-if="noteCaps.imageMode === 'approved'">
          Only approved photos can be embedded.</template>
      </p>

      <div v-if="!editorReady" class="muted edit-loading">Loading editor…</div>

      <div v-if="editorReady && isNewNote" class="template-bar card">
        <label class="label" for="new-template">Start from template</label>
        <select
          id="new-template"
          class="select"
          :value="templateId"
          @change="applyTemplate(($event.target as HTMLSelectElement).value as NoteTemplateId)"
        >
          <option v-for="item in NOTE_TEMPLATES" :key="item.id" :value="item.id">
            {{ item.label }}
          </option>
        </select>
      </div>

      <WikiEditor
        v-if="editorReady"
        id="body"
        ref="editorRef"
        v-model="body"
        v-model:title="title"
        v-model:edit-summary="message"
        :owner-handle="handle"
        :wiki-slug="wikiSlug"
        :note-slug="noteSlug"
        :note="editingNote"
        :owner-did="lichen.currentWiki?.ownerDid"
        :has-talk-page="hasTalkPage"
        :can-publish="canContributeHere"
        :publishing="lichen.saving || suggestionBusy"
        :show-post-to-bluesky="showPostToBluesky"
        :draft-key="`${handle}/${wikiSlug}/${noteSlug}`"
        :image-mode="canPublishHere ? 'any' : noteCaps.imageMode"
        :approved-media="lichen.approvedMedia"
        placeholder="Start writing your article…"
        @publish="save"
      />

      <label v-if="editingNote" class="purge-check">
        <input v-model="purgeOnSave" type="checkbox" :disabled="lichen.saving" />
        <span>Purge edit history when saving — keeps only this version</span>
      </label>
      <p v-if="lichen.error" class="error-text edit-error">{{ lichen.error }}</p>
      <p v-if="blueskyNotice" class="error-text edit-error">{{ blueskyNotice }}</p>

      <section
        v-if="canPublishHere && !isNewNote && !isNewTalk"
        class="branch-panel card"
        aria-label="Branches"
      >
        <div class="branch-panel-head">
          <h2 class="branch-panel-title">Branches</h2>
          <p class="branch-panel-sub">
            Draft big changes on a copy, then merge them back.
          </p>
        </div>
        <div class="branch-actions">
          <button
            v-if="!isBranchSlug(noteSlug)"
            type="button"
            class="btn btn-secondary btn-sm"
            @click="createBranch"
          >
            + Create a branch
          </button>
          <button
            v-if="isBranchSlug(noteSlug)"
            type="button"
            class="btn btn-accent btn-sm"
            :disabled="merging"
            @click="mergeBranchToMain"
          >
            {{ merging ? 'Merging…' : 'Merge into main' }}
          </button>
          <RouterLink
            v-for="branch in branchNotes"
            :key="branch.slug"
            :to="`/@${handle}/${wikiSlug}/edit/${branch.slug}`"
            class="btn btn-ghost btn-sm"
          >
            {{ branchNameFromSlug(branch.slug) ?? branch.slug }}
          </RouterLink>
        </div>
        <p v-if="mergeError" class="error-text merge-error">{{ mergeError }}</p>
      </section>

      <section
        v-if="canPublishHere && !isNewNote && !isNewTalk"
        class="danger-panel card"
        :aria-label="`Delete ${kindLabel}`"
      >
        <div class="danger-panel-head">
          <h2 class="danger-panel-title">Delete this {{ kindLabel }}</h2>
          <p class="danger-panel-sub">
            Removes the {{ kindLabel }} and its full revision history. This cannot be undone.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm btn-delete"
          :disabled="deleting"
          @click="deleteNote"
        >
          {{ deleting ? 'Deleting…' : `Delete ${kindLabel}` }}
        </button>
        <p v-if="deleteError" class="error-text danger-error">{{ deleteError }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.edit-page {
  padding: 1rem 1.25rem 3rem;
}

.edit-inner {
  max-width: 900px;
  margin: 0 auto;
  display: grid;
  gap: 1rem;
}

.edit-loading {
  padding: 2rem 0;
}

.presence-banner {
  margin: 0;
  padding: 0.75rem 1rem;
  border: 1px solid color-mix(in srgb, var(--pckt-red) 35%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-red) 10%, transparent);
  border-radius: var(--pckt-radius-sm);
  font-size: 0.875rem;
}

.template-bar {
  padding: 0.875rem 1rem;
  display: grid;
  gap: 0.35rem;
}

.branch-panel {
  padding: 1rem 1.25rem;
}

.branch-panel-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.branch-panel-sub {
  margin: 0 0 0.75rem;
  color: var(--pckt-text-muted);
  font-size: 0.875rem;
}

.branch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.suggest-banner {
  border-color: color-mix(in srgb, var(--pckt-accent, var(--pckt-red)) 35%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-accent, var(--pckt-red)) 8%, transparent);
}

.purge-check {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--pckt-text-muted);
  cursor: pointer;
}

.edit-error {
.edit-error {
  margin: 0;
}

.merge-error {
  margin: 0.75rem 0 0;
}

.danger-panel {
  padding: 1rem 1.25rem;
}

.danger-panel-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.danger-panel-sub {
  margin: 0 0 0.75rem;
  color: var(--pckt-text-muted);
  font-size: 0.875rem;
}

.btn-delete {
  color: var(--pckt-danger);
  border-color: color-mix(in srgb, var(--pckt-danger) 40%, transparent);
}

.btn-delete:hover:not(:disabled) {
  background: color-mix(in srgb, var(--pckt-danger) 10%, transparent);
  border-color: var(--pckt-danger);
}

.danger-error {
  margin: 0.75rem 0 0;
}
</style>
