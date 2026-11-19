<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { isBranchSlug } from '@/lib/lichen/branches'
import {
  isTalkSlug,
  parseNoteContent,
  subjectSlugFromTalk,
} from '@/lib/lichen/content-meta'
import { appUrl } from '@/lib/base-url'
import { postWikiPageToBluesky } from '@/lib/atproto/bluesky-post'
import { readPostToBlueskyPref } from '@/lib/bluesky-prefs'
import WikiEditor from '@/components/WikiEditor.vue'
import type { LichenNoteWithContent } from '@/types/lichen'

const props = defineProps<{
  mode: 'create' | 'edit'
  note?: LichenNoteWithContent | null
  createSlug?: string | null
  ownerHandle: string
  wikiSlug: string
}>()

const auth = useAuthStore()
const lichen = useLichenStore()
const router = useRouter()
const {
  active: editModeActive,
  closeModal,
  exit,
  registerCommit,
  unregisterCommit,
  commitAndExit,
  setSessionSaveHandler,
  saving: editSaving,
} = useWikiEditMode()

const title = ref('')
const body = ref('')
const message = ref('')
const publishing = ref(false)
const error = ref('')
const editorRef = ref<InstanceType<typeof WikiEditor> | null>(null)

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function defaultsForCreate(slug: string): { title: string; body: string } {
  if (isTalkSlug(slug)) {
    const subject = subjectSlugFromTalk(slug) ?? 'note'
    return {
      title: `Talk: ${subject}`,
      body: `Discussion for [[${subject}]].\n\nShare feedback and suggested edits here.`,
    }
  }
  return { title: titleFromSlug(slug), body: '' }
}

const noteSlug = computed(() =>
  props.mode === 'create' ? (props.createSlug ?? '') : (props.note?.slug ?? ''),
)

watch(
  () => [props.mode, props.note?.uri, props.note?.cid, props.createSlug] as const,
  () => {
    error.value = ''
    message.value = ''
    if (props.mode === 'create' && props.createSlug) {
      const defaults = defaultsForCreate(props.createSlug)
      title.value = defaults.title
      body.value = defaults.body
      return
    }
    if (props.mode === 'edit' && props.note) {
      title.value = props.note.title
      body.value = props.note.content
    }
  },
  { immediate: true },
)

/** Returns false so a caller committing several editors can stop on failure. */
/** Auto-post rule shared with the full editor: public wikis, owner only. */
async function maybePostToBluesky(
  previousContent: string,
  nextContent: string,
  slug: string,
  title: string,
): Promise<void> {
  if (!auth.agent || !readPostToBlueskyPref()) return
  if (!lichen.currentWiki || lichen.currentWiki.visibility !== 'public') return
  if (lichen.currentWiki.ownerDid !== auth.did) return
  if (isTalkSlug(slug) || isBranchSlug(slug)) return
  const parsed = parseNoteContent(nextContent)
  if (parsed.status === 'draft') return
  try {
    await postWikiPageToBluesky(auth.agent, {
      title,
      noteUrl: appUrl(`/@${props.ownerHandle}/${props.wikiSlug}/${slug}`),
      wikiSlug: props.wikiSlug,
      categories: parsed.categories,
      previousContent,
      nextContent,
      sessionBlobs: editorRef.value?.getSessionBlobs() ?? new Map(),
    })
  } catch {
    // The save already succeeded; a failed share should not block the page.
  }
}

async function publish(): Promise<boolean> {
  if (!auth.agent) {
    error.value = 'Sign in to save this page'
    return false
  }
  if (!noteSlug.value) {
    error.value = 'Missing page address — try Create this page again'
    return false
  }
  error.value = ''
  publishing.value = true
  try {
    const publishTitle = title.value.trim() || titleFromSlug(noteSlug.value) || noteSlug.value
    if (props.mode === 'create') {
      const created = await lichen.createNoteWithSlug(
        auth.agent,
        noteSlug.value,
        publishTitle,
        body.value,
        message.value || 'Initial revision',
        editorRef.value?.getContentBlobs(),
      )
      const stagedLinks = editorRef.value?.getSubheaderLinks() ?? []
      if (stagedLinks.length) {
        await lichen.setNoteSubheaderLinks(auth.agent, created, stagedLinks)
      }
      await maybePostToBluesky('', body.value, created.slug, publishTitle)
      closeModal()
      // Always land on the canonical slug — the URL may still be mixed-case,
      // spaced, or otherwise un-normalized from the missing-page link.
      await router.replace(`/@${props.ownerHandle}/${props.wikiSlug}/${created.slug}`)
      return true
    } else if (props.note) {
      const previousContent = props.note.content
      await lichen.queueOrSaveNoteEdit(
        auth.agent,
        props.note,
        publishTitle,
        body.value,
        message.value || undefined,
        props.ownerHandle,
        props.wikiSlug,
        editorRef.value?.getContentBlobs(),
      )
      await maybePostToBluesky(previousContent, body.value, props.note.slug, publishTitle)
    } else {
      throw new Error('Nothing to save')
    }
    // Edit-mode saveAll may still have logo/links committers after this note.
    // closeModal would unmount them; commitAndExit calls exit() once all succeed.
    if (!editModeActive.value) closeModal()
    return true
  } catch (err) {
    error.value =
      err instanceof Error
        ? err.message
        : props.mode === 'create'
          ? 'Failed to create page'
          : 'Failed to save page'
    return false
  } finally {
    publishing.value = false
  }
}

/**
 * Join the edit-mode commit set so any Save in the app writes this page too.
 * Registered per note so switching pages replaces the entry rather than stacking.
 */
const commitId = 'inline-note-editor'

watch(
  () => noteSlug.value,
  () => registerCommit(commitId, publish),
  { immediate: true },
)

onUnmounted(() => {
  unregisterCommit(commitId)
  setSessionSaveHandler(null)
})

/**
 * Header Save reuses this editor's publish prep (summary popover + CM flush)
 * so every Save control runs the same path.
 */
watch(
  () => [props.mode, editModeActive.value] as const,
  ([mode, active]) => {
    if (mode === 'edit' && active) {
      setSessionSaveHandler(() => {
        if (editorRef.value) {
          editorRef.value.requestPublish()
          return
        }
        void commitAndExit()
      })
    } else {
      setSessionSaveHandler(null)
    }
  },
  { immediate: true },
)

function cancel() {
  // Edit mode keeps the article editor open — Cancel leaves edit mode.
  if (editModeActive.value) exit()
  else closeModal()
}

/**
 * Create publishes this page directly. Edit mode uses commitAndExit so chrome
 * (links, logo) and the note body share one Save gesture that leaves edit mode.
 */
async function onEditorPublish() {
  if (props.mode === 'create') {
    await publish()
    return
  }
  await commitAndExit()
}
</script>

<template>
  <div class="inline-note-editor">
    <WikiEditor
      v-if="noteSlug"
      :key="`${mode}-${noteSlug}`"
      ref="editorRef"
      inline
      :immediate-publish="mode === 'create'"
      :hide-cancel="editModeActive"
      :model-value="body"
      :title="title"
      :edit-summary="message"
      :owner-handle="ownerHandle"
      :wiki-slug="wikiSlug"
      :note-slug="noteSlug"
      :note="mode === 'edit' ? note : null"
      :owner-did="lichen.currentWiki?.ownerDid"
      :can-publish="!!auth.agent"
      :publishing="publishing || editSaving"
      @update:model-value="body = $event"
      @update:title="title = $event"
      @update:edit-summary="message = $event"
      @publish="onEditorPublish"
      @cancel="cancel"
    />

    <p v-if="error" class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.inline-note-editor {
  min-width: 0;
  overflow: visible;
}

.error-text {
  margin: 0.75rem 0 0;
}
</style>
