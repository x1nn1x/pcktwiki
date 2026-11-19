<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { EditorView } from '@codemirror/view'
import SilkdownEditor from '@/components/SilkdownEditor.vue'
import WikiEditorSuggest from '@/components/WikiEditorSuggest.vue'
import WikiEditorTools from '@/components/WikiEditorTools.vue'
import WikiHeaderLinks from '@/components/WikiHeaderLinks.vue'
import { useAuthStore } from '@/stores/auth'
import { useLichenStore } from '@/stores/lichen'
import { useWikiEditMode } from '@/composables/useWikiEditMode'
import { useEditorDraft } from '@/composables/useEditorDraft'
import { useKeyboardInset } from '@/composables/useKeyboardInset'
import { useMediaQuery } from '@/composables/useMediaQuery'
import {
  clearSessionBlobPreviews,
  resolveBlobDisplayUrl,
  setSessionBlobPreview,
  uploadBlob,
} from '@/lib/atproto/blobs'
import { prepareImageUploadPair } from '@/lib/media/prepare-image-upload'
import {
  serializeImageTitle,
  serializeMarkdownImage,
} from '@/lib/editor/image-align'
import { imageFilesFromDrop } from '@/lib/editor/drop-files'
import {
  collectSessionBlobsForContent,
  type SessionBlobMap,
} from '@/lib/atproto/bluesky-post'
import {
  applyEditPatchToView,
  applyEditorActionToView,
  createCodemirrorTarget,
} from '@/lib/editor-codemirror'
import {
  activeActions,
  type ActionContext,
  type EditorActionId,
} from '@/lib/editor/actions'
import {
  rankSuggestions,
  wikilinkContextForRange,
  type SuggestCandidate,
  type SuggestSource,
  type WikilinkContext,
} from '@/lib/editor/suggest'
import { shortcutAction, type ToolbarCommand } from '@/lib/editor/toolbar'
import { computeWikiCategories } from '@/lib/lichen/categories'
import { isTalkSlug, parseNoteContent, talkSlugFor } from '@/lib/lichen/content-meta'
import { readPostToBlueskyPref, writePostToBlueskyPref } from '@/lib/bluesky-prefs'
import { setFrontmatterField } from '@/lib/lichen/frontmatter'
import type {
  LichenApprovedMediaRecord,
  LichenHeaderLink,
  LichenNoteWithContent,
  WikiImageMode,
} from '@/types/lichen'
import type { Extension } from '@codemirror/state'

const props = withDefaults(
  defineProps<{
    modelValue: string
    title: string
    editSummary?: string
    ownerHandle: string
    wikiSlug: string
    noteSlug: string
    /** Existing note — when absent, subheader links are staged until publish. */
    note?: LichenNoteWithContent | null
    ownerDid?: string
    placeholder?: string
    canPublish?: boolean
    publishing?: boolean
    hasTalkPage?: boolean
    id?: string
    draftKey?: string | null
    /** Show “Also post images to Bluesky” next to Save. */
    showPostToBluesky?: boolean
    /** Match read-page layout; float edit chrome so content doesn’t jump. */
    inline?: boolean
    /** Skip the “what changed?” popover and save on the first click. */
    immediatePublish?: boolean
    /**
     * Hide Cancel when an enclosing chrome already owns discard (edit-mode
     * header Cancel). Save stays so it can alias the same commit path.
     */
    hideCancel?: boolean
    /**
     * Wiki image policy for this contributor. 'none' hides image tools and
     * refuses uploads; 'approved' hides them too but offers the approved
     * photos strip instead; 'any' is the default open behaviour.
     */
    imageMode?: WikiImageMode
    /** Registry backing the approved-photos strip. */
    approvedMedia?: LichenApprovedMediaRecord[]
  }>(),
  {
    editSummary: '',
    note: null,
    ownerDid: '',
    placeholder: 'Start writing your article…',
    canPublish: true,
    publishing: false,
    hasTalkPage: false,
    draftKey: undefined,
    showPostToBluesky: false,
    inline: false,
    immediatePublish: false,
    hideCancel: false,
    imageMode: 'any',
    approvedMedia: () => [],
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:title': [value: string]
  'update:editSummary': [value: string]
  publish: []
  cancel: []
}>()

const auth = useAuthStore()
const lichen = useLichenStore()
const { active: editModeActive } = useWikiEditMode()

const silkdownRef = ref<InstanceType<typeof SilkdownEditor> | null>(null)
const viewRef = shallowRef<EditorView | null>(null)
const surfaceRef = ref<HTMLElement | null>(null)
const surfaceDragOver = ref(false)
const subheaderRef = ref<HTMLElement | null>(null)
const subheaderLinksRef = ref<InstanceType<typeof WikiHeaderLinks> | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const publishButtonRef = ref<HTMLElement | null>(null)
const summaryPopoverRef = ref<HTMLElement | null>(null)
const summaryInputRef = ref<HTMLInputElement | null>(null)
const summaryOpen = ref(false)
const baseline = ref(props.modelValue)
const historyTick = ref(0)
const active = ref<Set<EditorActionId>>(new Set())
const uploading = ref(false)
const uploadError = ref('')
/** Progress while one or more images are uploading. */
const uploadProgress = ref<{ current: number; total: number; name: string } | null>(null)
const subheaderOpen = ref(false)
/** Staged while creating a page (no note record yet). Survives closing the editor row. */
const stagedSubheaderLinks = ref<LichenHeaderLink[]>([])
const postToBluesky = ref(readPostToBlueskyPref())
const sessionBlobs: SessionBlobMap = new Map()
/** `blob:cid` keys this editor registered for object-URL preview. */
const sessionPreviewKeys: string[] = []
const keyboardInset = useKeyboardInset()
const isNarrow = useMediaQuery('(max-width: 768px)')

watch(postToBluesky, (value) => writePostToBlueskyPref(value))

const titleRef = computed({
  get: () => props.title,
  set: (value: string) => emit('update:title', value),
})
const contentRef = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})
const draftKeyRef = computed(() => props.draftKey ?? null)
const { recovered, sync, restore, dismiss, clear } = useEditorDraft(
  draftKeyRef,
  titleRef,
  contentRef,
)

const isTalk = computed(() => isTalkSlug(props.noteSlug))
const talkSlug = computed(() => talkSlugFor(props.noteSlug))

/**
 * Draft pages are only visible to people who can publish this wiki, so the
 * switch lives in the editor where the owner actually writes the page.
 */
const isDraftPage = computed(() => parseNoteContent(props.modelValue).status === 'draft')
const showDraftToggle = computed(() => !isTalk.value && !props.noteSlug.includes(':'))

function toggleDraftPage(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  emit('update:modelValue', setFrontmatterField(props.modelValue, 'status', checked ? 'draft' : null))
}
const titleBaseline = ref(props.title)
const dirty = computed(
  () => props.modelValue !== baseline.value || props.title !== titleBaseline.value,
)
const articleSlug = computed(() =>
  isTalk.value ? props.noteSlug.replace(/^talk:/, '') || 'note' : props.noteSlug,
)
/**
 * Every control that commits reads "Save", so the same word means the same
 * action wherever it appears.
 */
const publishLabel = computed(() => (props.publishing ? 'Saving…' : 'Save'))
/** Inline edits ask for a summary first; create / immediatePublish skip that step. */
const barPublishLabel = computed(() =>
  props.publishing || !props.inline || props.immediatePublish ? publishLabel.value : 'Save…',
)

/** Prefer the live store note so subheader saves refresh immediately. */
const liveNote = computed(() => {
  const fromStore = lichen.getNoteBySlug(props.noteSlug)
  if (fromStore) return fromStore
  return props.note ?? null
})
const ownerDidResolved = computed(
  () => props.ownerDid || lichen.currentWiki?.ownerDid || '',
)
const canEditSubheader = computed(
  () => !!ownerDidResolved.value && !isTalk.value,
)
const hasSubheaderLinks = computed(
  () =>
    (liveNote.value?.subheaderLinks?.length ?? 0) > 0 ||
    stagedSubheaderLinks.value.length > 0,
)
const showSubheaderEditor = computed(() => canEditSubheader.value && subheaderOpen.value)
const displayedSubheaderLinks = computed(
  () => liveNote.value?.subheaderLinks ?? stagedSubheaderLinks.value,
)

watch(
  () => props.noteSlug,
  () => {
    stagedSubheaderLinks.value = []
    // Open by default when the page already has subheader links.
    subheaderOpen.value = (liveNote.value?.subheaderLinks?.length ?? 0) > 0
  },
  { immediate: true },
)

const noteSources = computed<SuggestSource[]>(() =>
  lichen.notes
    .filter((note) => !isTalkSlug(note.slug) && !note.slug.includes(':'))
    .map((note) => ({ slug: note.slug, title: note.title || note.slug })),
)
const categorySources = computed<SuggestSource[]>(() =>
  computeWikiCategories(lichen.notes).map((cat) => ({ slug: cat.name, title: cat.name })),
)

function getView(): EditorView | null {
  return viewRef.value ?? silkdownRef.value?.getView() ?? null
}

const editorTarget = computed(() => {
  historyTick.value
  const view = getView()
  return view ? createCodemirrorTarget(view) : null
})
const canUndo = computed(() => {
  historyTick.value
  return editorTarget.value?.canUndo() ?? false
})
const canRedo = computed(() => {
  historyTick.value
  return editorTarget.value?.canRedo() ?? false
})

function onEditorReady(view: EditorView) {
  viewRef.value = view
  historyTick.value += 1
  refreshActive()
}

/* ------------------------------------------------------------------ */
/* Suggestions                                                         */
/* ------------------------------------------------------------------ */

const suggestContext = ref<WikilinkContext | null>(null)
const suggestItems = ref<SuggestCandidate[]>([])
const suggestIndex = ref(0)
const suggestAnchor = ref({ top: 0, left: 0 })

const suggestOpen = computed(() => suggestItems.value.length > 0)

function closeSuggestions() {
  suggestContext.value = null
  suggestItems.value = []
  suggestIndex.value = 0
}

function refreshActive() {
  const view = getView()
  if (!view) {
    active.value = new Set()
    return
  }
  const { from, to } = view.state.selection.main
  active.value = activeActions(view.state.doc.toString(), from, to)
}

function refreshSuggestions() {
  const view = getView()
  if (!view) return closeSuggestions()

  const sel = view.state.selection.main
  const doc = view.state.doc.toString()
  // A selection is only interesting if it sits inside `[[ … ]]` — then the
  // selected text seeds the query so the author can confirm or pick a target.
  const context = wikilinkContextForRange(doc, sel.from, sel.to)
  if (!context) return closeSuggestions()

  const source = context.mode === 'category' ? categorySources.value : noteSources.value
  const items = rankSuggestions(source, context.query)
  if (!items.length) return closeSuggestions()

  suggestContext.value = context
  suggestItems.value = items
  suggestIndex.value = 0

  // Anchor the dropdown at the start of the selection/caret.
  const anchorPos = context.queryStart
  const coords = view.coordsAtPos(anchorPos)
  const host = surfaceRef.value?.getBoundingClientRect()
  if (coords && host) {
    suggestAnchor.value = {
      top: coords.bottom - host.top + 4,
      left: Math.max(0, coords.left - host.left),
    }
  }
}

function pickSuggestion(item: SuggestCandidate) {
  const view = getView()
  const context = suggestContext.value
  if (!view || !context) return

  applyEditPatchToView(view, {
    from: context.queryStart,
    to: context.replaceEnd,
    insert: `${item.value}]]`,
    selectionStart: context.queryStart + item.value.length + 2,
    selectionEnd: context.queryStart + item.value.length + 2,
  })
  emit('update:modelValue', view.state.doc.toString())
  closeSuggestions()
  historyTick.value += 1
  refreshActive()
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function onBodyUpdate(value: string) {
  historyTick.value += 1
  emit('update:modelValue', value)
  void nextTick(() => {
    refreshActive()
    refreshSuggestions()
  })
}

function runAction(id: EditorActionId, context: ActionContext = {}) {
  const view = getView()
  if (!view) return
  applyEditorActionToView(view, id, context)
  emit('update:modelValue', view.state.doc.toString())
  historyTick.value += 1
  refreshActive()
  if (id === 'wikilink' || id === 'category') {
    void nextTick(refreshSuggestions)
  }
}

interface UploadOptions {
  /** Two or more images land as one masonry gallery run (folder-drop flow). */
  asGallery?: boolean
  /** Insert at the very top of the page — the "set as thumbnail" zone. */
  atStart?: boolean
}

async function uploadImages(files: File[], options: UploadOptions = {}) {
  if (!auth.agent || !files.length) return
  if (!uploadsAllowed.value) {
    alertImagePolicy()
    return
  }
  const view = getView()
  if (!view) return

  const images = files.filter((file) => file.type.startsWith('image/'))
  if (!images.length) return

  const asGallery = !!options.asGallery && images.length > 1
  uploading.value = true
  uploadError.value = ''
  uploadProgress.value = {
    current: 0,
    total: images.length,
    name: images[0]?.name ?? 'image',
  }
  try {
    // Same pattern as subheader link images: upload the blob, keep a local
    // object-URL preview, and store a portable `blob:cid` in markdown. Fresh
    // PDS uploads are not fetchable via getBlob until a record references them.
    const galleryParts: string[] = []
    for (let index = 0; index < images.length; index += 1) {
      const file = images[index]
      uploadProgress.value = {
        current: index + 1,
        total: images.length,
        name: file.name,
      }
      try {
        const { full, thumb, width, height } = await prepareImageUploadPair(file)
        const uploaded = await uploadBlob(auth.agent, full)
        sessionBlobs.set(uploaded.url, uploaded.blob)
        setSessionBlobPreview(uploaded.url, URL.createObjectURL(full))
        sessionPreviewKeys.push(uploaded.url)

        let thumbUrl: string | undefined
        if (thumb !== full) {
          const uploadedThumb = await uploadBlob(auth.agent, thumb)
          sessionBlobs.set(uploadedThumb.url, uploadedThumb.blob)
          setSessionBlobPreview(uploadedThumb.url, URL.createObjectURL(thumb))
          sessionPreviewKeys.push(uploadedThumb.url)
          thumbUrl = uploadedThumb.url
        }

        const title = serializeImageTitle({
          thumbUrl,
          width,
          height,
          // Folder/multi drops become a gallery immediately (reference flow).
          masonry: asGallery,
        })

        if (asGallery) {
          galleryParts.push(
            serializeMarkdownImage({
              alt: file.name.replace(/\.[^.]+$/, ''),
              url: uploaded.url,
              title,
            }),
          )
        } else {
          applyEditorActionToView(view, 'image', {
            url: uploaded.url,
            alt: file.name.replace(/\.[^.]+$/, ''),
            title: title ?? undefined,
          })
        }
      } catch (err) {
        uploadError.value =
          err instanceof Error ? err.message : 'Failed to upload image'
      }
    }

    if (galleryParts.length >= 2) {
      // Insert the whole run as one block so the gallery renders immediately.
      const target = options.atStart ? 0 : view.state.selection.main.to
      const before = view.state.doc.sliceString(0, target)
      const after = view.state.doc.sliceString(target)
      const padBefore = !options.atStart && before.trim() ? '\n\n' : ''
      const padAfter = after.trim() ? '\n\n' : ''
      const insert = `${padBefore}${galleryParts.join('\n')}${padAfter}`
      view.dispatch({
        changes: { from: target, to: target, insert },
        selection: { anchor: target + insert.length },
        scrollIntoView: true,
      })
    }
    emit('update:modelValue', view.state.doc.toString())
    historyTick.value += 1
  } finally {
    uploading.value = false
    uploadProgress.value = null
  }
}

function getSessionBlobs(): SessionBlobMap {
  return new Map(sessionBlobs)
}

/** Blob refs to attach on the next note revision write. */
function getContentBlobs(): Record<string, unknown>[] {
  const view = getView()
  const content = view?.state.doc.toString() ?? props.modelValue
  return collectSessionBlobsForContent(content, sessionBlobs)
}

function shouldPostToBluesky(): boolean {
  return postToBluesky.value
}

/** Current subheader rows — from the open editor, staged create draft, or saved note. */
function getSubheaderLinks(): LichenHeaderLink[] {
  if (subheaderLinksRef.value) return subheaderLinksRef.value.getLinks()
  if (stagedSubheaderLinks.value.length) return stagedSubheaderLinks.value
  return liveNote.value?.subheaderLinks ?? []
}

defineExpose({
  shouldPostToBluesky,
  getSessionBlobs,
  getContentBlobs,
  getSubheaderLinks,
  requestPublish,
})

function onToolSelect(id: ToolbarCommand) {
  if (id === 'upload') {
    if (!uploadsAllowed.value) {
      alertImagePolicy()
      return
    }
    fileInputRef.value?.click()
    return
  }
  if (id === 'subheaderLinks') {
    openSubheaderEditor()
    return
  }
  runAction(id)
}

/** New blob uploads only make sense when the wiki accepts fresh images. */
const uploadsAllowed = computed(() => props.imageMode === 'any')

function alertImagePolicy() {
  window.alert(
    props.imageMode === 'approved'
      ? 'This wiki only allows approved photos — pick one from the approved photos strip below the toolbar.'
      : 'This wiki only accepts text-only edits, so images can’t be added here.',
  )
}

/**
 * Approved photos, with resolved thumbnail URLs. Their blobs are referenced
 * by the wiki's approved-media records, so they render straight from the
 * owner's PDS — no session preview needed.
 */
const approvedThumbs = ref<{ imageCid: string; alt: string; src: string | null }[]>([])

watch(
  () => [props.approvedMedia, props.ownerDid] as const,
  async ([media, ownerDid]) => {
    if (!media.length || props.imageMode !== 'approved') {
      approvedThumbs.value = []
      return
    }
    const rows = await Promise.all(
      media.map(async (item) => ({
        imageCid: item.imageCid,
        alt: item.alt || 'Approved photo',
        src: ownerDid
          ? await resolveBlobDisplayUrl(ownerDid, `blob:${item.imageCid}`)
          : null,
      })),
    )
    approvedThumbs.value = rows
  },
  { immediate: true, deep: false },
)

function insertApprovedImage(item: { imageCid: string; alt: string; src: string | null }) {
  const view = getView()
  if (!view) return
  applyEditorActionToView(view, 'image', {
    url: `blob:${item.imageCid}`,
    alt: item.alt,
  })
  emit('update:modelValue', view.state.doc.toString())
  historyTick.value += 1
}

function openSubheaderEditor() {
  if (!canEditSubheader.value) return
  subheaderOpen.value = true
  void nextTick(() => {
    subheaderRef.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'))
  input.value = ''
  void uploadImages(files, { asGallery: files.length > 1 })
}

/** True when the drag payload includes files (types are available during dragover). */
function dragHasFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false
  return Array.from(transfer.types).includes('Files')
}

function imageFilesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer?.files?.length) return []
  return Array.from(transfer.files).filter((file) => file.type.startsWith('image/'))
}

/**
 * Claim file drags so the browser never navigates to / opens the dropped file.
 * Call on dragenter/dragover (required for drop to fire) and on drop.
 */
function claimFileDrag(event: DragEvent): boolean {
  if (!dragHasFiles(event.dataTransfer) && !event.dataTransfer?.files?.length) return false
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer && event.type !== 'drop') {
    event.dataTransfer.dropEffect = 'copy'
  }
  return true
}

function placeCaretAtPoint(clientX: number, clientY: number) {
  const view = getView()
  if (!view) return
  const pos = view.posAtCoords({ x: clientX, y: clientY })
  if (pos != null) {
    view.dispatch({ selection: { anchor: pos } })
  }
}

function onSurfaceDrag(event: DragEvent) {
  if (!claimFileDrag(event)) return
  surfaceDragOver.value = true
}

function onSurfaceDragLeave(event: DragEvent) {
  const next = event.relatedTarget
  if (next instanceof Node && surfaceRef.value?.contains(next)) return
  surfaceDragOver.value = false
}

async function onSurfaceDrop(event: DragEvent) {
  claimFileDrag(event)
  surfaceDragOver.value = false
  // Expands folders dragged from the desktop (webkitGetAsEntry traversal).
  const { files, fromFolders } = await imageFilesFromDrop(event.dataTransfer)
  if (!files.length) return
  placeCaretAtPoint(event.clientX, event.clientY)
  void uploadImages(files, { asGallery: files.length > 1 || fromFolders })
}

/** The "set as thumbnail" strip: uploaded images land at the top of the page. */
async function onThumbZoneDrop(event: DragEvent) {
  claimFileDrag(event)
  surfaceDragOver.value = false
  const { files } = await imageFilesFromDrop(event.dataTransfer)
  if (!files.length) return
  void uploadImages(files, { asGallery: files.length > 1, atStart: true })
}

/** Window-level guard: file drops outside CM still must not open a new tab. */
function onWindowFileDrag(event: DragEvent) {
  if (!dragHasFiles(event.dataTransfer) && !event.dataTransfer?.files?.length) return
  // Only intercept while this editor is mounted in the document.
  if (!surfaceRef.value) return
  event.preventDefault()
}

function undo() {
  const view = getView()
  if (!view) return
  createCodemirrorTarget(view).undo()
  historyTick.value += 1
  emit('update:modelValue', view.state.doc.toString())
  refreshActive()
}

function redo() {
  const view = getView()
  if (!view) return
  createCodemirrorTarget(view).redo()
  historyTick.value += 1
  emit('update:modelValue', view.state.doc.toString())
  refreshActive()
}

async function onPublish() {
  const view = getView()
  if (view) {
    const latest = view.state.doc.toString()
    if (latest !== props.modelValue) {
      emit('update:modelValue', latest)
    }
  }

  // The open subheader row has no Save of its own. Outside edit mode this
  // publish owns the write. In edit mode the row stays registered so saveAll
  // commits it once — closing it here would unregister before that runs.
  if (showSubheaderEditor.value && subheaderLinksRef.value) {
    stagedSubheaderLinks.value = subheaderLinksRef.value.getLinks()
    if (!editModeActive.value) {
      const ok = await subheaderLinksRef.value.commit()
      if (!ok) return
      subheaderOpen.value = false
    }
  }

  clear()
  baseline.value = props.modelValue
  titleBaseline.value = props.title
  summaryOpen.value = false
  emit('publish')
}

/**
 * Inline editing has no room for a persistent summary field without covering
 * the page, so the bar button opens the summary popover and confirming there
 * publishes. Create-page and full-page editors publish on the first click.
 * Skip the popover when nothing in the note changed (chrome-only Save).
 */
function onPublishClick() {
  if (
    !props.inline ||
    summaryOpen.value ||
    props.immediatePublish ||
    !dirty.value
  ) {
    void onPublish()
    return
  }
  summaryOpen.value = true
  void nextTick(() => summaryInputRef.value?.focus())
}

/** Same path as the bar Save — used by the edit-mode header Save. */
function requestPublish() {
  onPublishClick()
}

function closeSummary() {
  summaryOpen.value = false
}

function onSummaryKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    if (props.canPublish && !props.publishing) void onPublish()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeSummary()
  }
}

function onSummaryOutsidePointer(event: PointerEvent) {
  const target = event.target as Node | null
  if (!target) return
  if (summaryPopoverRef.value?.contains(target)) return
  // The bar button toggles on click; closing here would just reopen it.
  if (publishButtonRef.value?.contains(target)) return
  closeSummary()
}

function restoreDraft() {
  const stored = restore()
  if (!stored) return

  // Writable computed emits update the parent, but CodeMirror only syncs from
  // props after a tick — patch the live view immediately so Restore feels instant.
  const view = getView()
  if (view && view.state.doc.toString() !== stored.content) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: stored.content },
      selection: { anchor: Math.min(stored.content.length, view.state.selection.main.head) },
    })
  }

  historyTick.value += 1
  refreshActive()
}

function discardDraft() {
  dismiss()
}

/* ------------------------------------------------------------------ */
/* CodeMirror extensions: shortcuts, paste, drop, selection            */
/* ------------------------------------------------------------------ */

const editorExtensions = computed<Extension[]>(() => [
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (suggestOpen.value) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          suggestIndex.value = (suggestIndex.value + 1) % suggestItems.value.length
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          suggestIndex.value =
            (suggestIndex.value - 1 + suggestItems.value.length) % suggestItems.value.length
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          const item = suggestItems.value[suggestIndex.value]
          if (item) pickSuggestion(item)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeSuggestions()
          return true
        }
      }

      const action = shortcutAction(event)
      if (action) {
        event.preventDefault()
        applyEditorActionToView(view, action)
        emit('update:modelValue', view.state.doc.toString())
        historyTick.value += 1
        refreshActive()
        return true
      }
      return false
    },
    paste(event, view) {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      )
      if (files.length) {
        event.preventDefault()
        void uploadImages(files)
        return true
      }

      const text = event.clipboardData?.getData('text/plain').trim() ?? ''
      const sel = view.state.selection.main
      if (
        text &&
        sel.from !== sel.to &&
        /^(https?:\/\/|mailto:)\S+$/i.test(text) &&
        !/\s/.test(text)
      ) {
        event.preventDefault()
        applyEditorActionToView(view, 'link', { url: text })
        emit('update:modelValue', view.state.doc.toString())
        historyTick.value += 1
        return true
      }
      return false
    },
    // dragover/dragenter must preventDefault or the browser won't fire drop —
    // and may navigate to the file instead.
    dragenter(event) {
      if (!claimFileDrag(event)) return false
      surfaceDragOver.value = true
      return true
    },
    dragover(event) {
      if (!claimFileDrag(event)) return false
      surfaceDragOver.value = true
      return true
    },
    dragleave(event) {
      const next = event.relatedTarget
      if (next instanceof Node && surfaceRef.value?.contains(next)) return false
      surfaceDragOver.value = false
      return false
    },
    drop(event, view) {
      const hadFiles = claimFileDrag(event)
      surfaceDragOver.value = false
      if (!hadFiles) return false

      const files = imageFilesFromTransfer(event.dataTransfer)
      if (!files.length) return true

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos != null) {
        view.dispatch({ selection: { anchor: pos } })
      }
      void uploadImages(files)
      return true
    },
  }),
  EditorView.updateListener.of((update) => {
    if (update.selectionSet || update.docChanged) {
      refreshActive()
      refreshSuggestions()
      historyTick.value += 1
    }
  }),
])

watch(
  () => props.modelValue,
  (value, oldValue) => {
    if (value === baseline.value) return
    const wasDirty = oldValue !== baseline.value
    if (!wasDirty) baseline.value = value
  },
)

watch(
  () => props.noteSlug,
  () => {
    baseline.value = props.modelValue
    titleBaseline.value = props.title
    sync(props.modelValue)
  },
)

watch(
  () => props.publishing,
  (now, before) => {
    if (before && !now) {
      baseline.value = props.modelValue
      titleBaseline.value = props.title
      clear()
    }
  },
)

watch(summaryOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onSummaryOutsidePointer, true)
  } else {
    document.removeEventListener('pointerdown', onSummaryOutsidePointer, true)
  }
})

onMounted(() => {
  sync(props.modelValue)
  void nextTick(refreshActive)
  // Capture-phase: stop the browser from navigating to a dropped file anywhere
  // on the page while this editor is open.
  window.addEventListener('dragover', onWindowFileDrag, true)
  window.addEventListener('drop', onWindowFileDrag, true)
})

onUnmounted(() => {
  closeSuggestions()
  document.removeEventListener('pointerdown', onSummaryOutsidePointer, true)
  window.removeEventListener('dragover', onWindowFileDrag, true)
  window.removeEventListener('drop', onWindowFileDrag, true)
  viewRef.value = null
  for (const key of sessionPreviewKeys) clearSessionBlobPreviews(key)
  sessionPreviewKeys.length = 0
})
</script>

<template>
  <div
    class="wiki-editor"
    :class="{
      card: !inline,
      'wiki-editor--inline': inline,
      'is-narrow': isNarrow,
      'has-keyboard': keyboardInset > 0,
    }"
    :style="isNarrow ? { '--wiki-keyboard-inset': `${keyboardInset}px` } : undefined"
  >
    <header class="wiki-editor-bar">
      <div v-if="!inline" class="wiki-editor-crumbs">
        <span class="wiki-editor-kicker">Editing</span>
        <nav class="wiki-editor-context" aria-label="Page views">
          <RouterLink
            class="wiki-editor-context-link"
            :to="`/@${ownerHandle}/${wikiSlug}/${noteSlug}`"
          >
            Read
          </RouterLink>
          <span class="wiki-editor-context-sep" aria-hidden="true">·</span>
          <RouterLink
            class="wiki-editor-context-link"
            :to="`/@${ownerHandle}/${wikiSlug}/${noteSlug}/history`"
          >
            History
          </RouterLink>
        </nav>
      </div>
      <p v-else class="wiki-editor-inline-label">Editing page</p>

      <div class="wiki-editor-bar-actions">
        <span
          class="wiki-save-state"
          :class="{ 'wiki-save-state-dirty': dirty }"
          :title="dirty ? 'Unsaved changes' : 'Matches last loaded version'"
        >
          <span class="wiki-save-dot" aria-hidden="true" />
          <span class="wiki-save-label">{{ dirty ? 'Unsaved' : 'Saved' }}</span>
        </span>

        <label
          v-if="showDraftToggle"
          class="wiki-post-bluesky"
          title="Draft pages are visible only to people who can publish this wiki"
        >
          <input type="checkbox" :checked="isDraftPage" @change="toggleDraftPage" />
          <span>Draft page</span>
        </label>

        <label
          v-if="showPostToBluesky"
          class="wiki-post-bluesky"
          title="Post new pages and substantial edits to your Bluesky profile with wiki hashtags"
        >
          <input v-model="postToBluesky" type="checkbox" />
          <span>Post to Bluesky</span>
        </label>

        <button
          v-if="inline && !hideCancel"
          type="button"
          class="btn btn-ghost btn-sm"
          :disabled="publishing"
          @click="emit('cancel')"
        >
          Cancel
        </button>

        <button
          ref="publishButtonRef"
          type="button"
          class="btn btn-primary btn-sm wiki-publish"
          :disabled="!canPublish || publishing"
          :aria-haspopup="inline && !immediatePublish ? 'dialog' : undefined"
          :aria-expanded="inline && !immediatePublish ? summaryOpen : undefined"
          @click="onPublishClick"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 10.5 8 14.5 16 5.5"
            />
          </svg>
          {{ barPublishLabel }}
        </button>
      </div>

      <div
        v-if="inline && summaryOpen"
        ref="summaryPopoverRef"
        class="wiki-summary-popover"
        role="dialog"
        aria-label="Describe your change"
      >
        <label class="wiki-summary-label" :for="id ? `${id}-summary` : 'wiki-summary'">
          What did you change?
          <span class="wiki-summary-optional">optional</span>
        </label>
        <input
          :id="id ? `${id}-summary` : 'wiki-summary'"
          ref="summaryInputRef"
          class="wiki-summary-input"
          type="text"
          :value="editSummary"
          placeholder="e.g. Fixed a typo, added a new section"
          @input="emit('update:editSummary', ($event.target as HTMLInputElement).value)"
          @keydown="onSummaryKeydown"
        />
        <div class="wiki-summary-popover-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeSummary">Back</button>
          <button
            type="button"
            class="btn btn-primary btn-sm wiki-publish"
            :disabled="!canPublish || publishing"
            @click="onPublish"
          >
            {{ publishLabel }}
          </button>
        </div>
      </div>
    </header>

    <div class="wiki-editor-tools-shell">
      <WikiEditorTools
        :active="active"
        :can-undo="canUndo"
        :can-redo="canRedo"
        :uploading="uploading"
        :can-subheader-links="canEditSubheader"
        :image-mode="imageMode"
        @select="onToolSelect"
        @undo="undo"
        @redo="redo"
      />
      <div
        v-if="approvedThumbs.length"
        class="wiki-editor-approved-strip"
        aria-label="Approved photos"
      >
        <span class="wiki-editor-approved-label">Approved photos</span>
        <button
          v-for="item in approvedThumbs"
          :key="item.imageCid"
          type="button"
          class="wiki-editor-approved-thumb"
          :title="item.alt"
          @click="insertApprovedImage(item)"
        >
          <img v-if="item.src" :src="item.src" :alt="item.alt" loading="lazy" />
          <span v-else class="wiki-editor-approved-fallback">{{ item.alt }}</span>
        </button>
      </div>
      <div
        v-if="uploading && uploadProgress"
        class="wiki-editor-upload-status"
        role="status"
        aria-live="polite"
      >
        <span class="wiki-editor-upload-spinner" aria-hidden="true" />
        <span class="wiki-editor-upload-status-text">
          Uploading
          <template v-if="uploadProgress.total > 1">
            {{ uploadProgress.current }} of {{ uploadProgress.total }}
          </template>
          <span class="wiki-editor-upload-status-name">{{ uploadProgress.name }}</span>
        </span>
      </div>
      <p v-if="uploadError" class="wiki-editor-upload-error" role="alert">{{ uploadError }}</p>
    </div>

    <div class="wiki-editor-body">
      <nav v-if="!inline" class="wiki-editor-tabs" aria-label="Namespaces">
        <span v-if="!isTalk" class="wiki-editor-tab wiki-editor-tab-active">Article</span>
        <RouterLink
          v-if="!isTalk"
          class="wiki-editor-tab"
          :to="
            hasTalkPage
              ? `/@${ownerHandle}/${wikiSlug}/${talkSlug}`
              : `/@${ownerHandle}/${wikiSlug}/edit/${talkSlug}`
          "
        >
          Talk
        </RouterLink>
        <template v-else>
          <RouterLink class="wiki-editor-tab" :to="`/@${ownerHandle}/${wikiSlug}/${articleSlug}`">
            Article
          </RouterLink>
          <span class="wiki-editor-tab wiki-editor-tab-active">Talk</span>
        </template>
      </nav>

      <input
        :id="id ? `${id}-title` : undefined"
        class="wiki-editor-title"
        type="text"
        :value="title"
        placeholder="Give your page a title"
        aria-label="Page title"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      />

      <div
        v-if="canEditSubheader"
        ref="subheaderRef"
        class="wiki-editor-subheader"
      >
        <WikiHeaderLinks
          v-if="showSubheaderEditor"
          ref="subheaderLinksRef"
          editing
          defer-commit
          kind="subheader"
          :links="displayedSubheaderLinks"
          :owner-did="ownerDidResolved"
          :owner-handle="ownerHandle"
          :wiki-slug="wikiSlug"
          :note="liveNote"
        />
        <template v-else-if="hasSubheaderLinks">
          <WikiHeaderLinks
            kind="subheader"
            :links="displayedSubheaderLinks"
            :owner-did="ownerDidResolved"
            :owner-handle="ownerHandle"
            :wiki-slug="wikiSlug"
          />
          <button
            type="button"
            class="wiki-editor-subheader-add wiki-editor-subheader-edit"
            @click="openSubheaderEditor"
          >
            Edit subheader links
          </button>
        </template>
        <button
          v-else
          type="button"
          class="wiki-editor-subheader-add"
          @click="openSubheaderEditor"
        >
          + Add subheader links
        </button>
      </div>

      <div v-if="recovered" class="wiki-editor-draft">
        <p>
          Local draft from
          {{ new Date(recovered.savedAt).toLocaleString() }} —
          restore unsaved work?
        </p>
        <div class="wiki-editor-draft-actions">
          <button type="button" class="btn btn-primary btn-sm" @click="restoreDraft">
            Restore
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="discardDraft">
            Discard
          </button>
        </div>
      </div>

      <div
        ref="surfaceRef"
        class="wiki-editor-surface"
        :class="{
          'is-file-drag': surfaceDragOver,
          'is-uploading': uploading,
        }"
        @dragenter="onSurfaceDrag"
        @dragover="onSurfaceDrag"
        @dragleave="onSurfaceDragLeave"
        @drop="onSurfaceDrop"
      >
        <div
          v-if="surfaceDragOver && uploadsAllowed"
          class="wiki-editor-thumbzone"
          @dragenter.stop.prevent
          @dragover.stop.prevent
          @drop.stop.prevent="onThumbZoneDrop"
        >
          Drop here to set as thumbnail
        </div>
        <div
          v-if="uploading && uploadProgress"
          class="wiki-editor-upload-overlay"
          role="status"
          aria-live="polite"
        >
          <span class="wiki-editor-upload-spinner wiki-editor-upload-spinner-lg" aria-hidden="true" />
          <p class="wiki-editor-upload-overlay-title">
            Uploading image<template v-if="uploadProgress.total > 1">s</template>…
          </p>
          <p class="wiki-editor-upload-overlay-detail">
            <template v-if="uploadProgress.total > 1">
              {{ uploadProgress.current }} of {{ uploadProgress.total }} —
            </template>
            {{ uploadProgress.name }}
          </p>
        </div>
        <SilkdownEditor
          ref="silkdownRef"
          :model-value="modelValue"
          class="wiki-editor-silkdown"
          :placeholder="placeholder"
          :min-height="inline ? '12rem' : '28rem'"
          :extensions="editorExtensions"
          :owner-did="ownerDidResolved"
          :block-drag="true"
          @update:model-value="onBodyUpdate"
          @ready="onEditorReady"
        />

        <WikiEditorSuggest
          v-if="suggestOpen"
          :items="suggestItems"
          :index="suggestIndex"
          :top="suggestAnchor.top"
          :left="suggestAnchor.left"
          @pick="pickSuggestion"
          @hover="suggestIndex = $event"
        />
      </div>
    </div>

    <footer v-if="!inline" class="wiki-editor-footer">
      <label class="wiki-summary-label" :for="id ? `${id}-summary` : 'wiki-summary'">
        What did you change?
        <span class="wiki-summary-optional">optional</span>
      </label>
      <input
        :id="id ? `${id}-summary` : 'wiki-summary'"
        class="wiki-summary-input"
        type="text"
        :value="editSummary"
        placeholder="e.g. Fixed a typo, added a new section"
        @input="emit('update:editSummary', ($event.target as HTMLInputElement).value)"
      />
      <p class="wiki-summary-hint">A short note helps others follow the page history.</p>
    </footer>

    <input
      ref="fileInputRef"
      class="wiki-editor-file"
      type="file"
      accept="image/*"
      multiple
      tabindex="-1"
      aria-hidden="true"
      @change="onFilePicked"
    />
  </div>
</template>

<style scoped>
.wiki-editor {
  --pw-toolbar-height: 3rem;
  overflow: hidden;
  padding: 0;
  padding-bottom: 0;
}

.wiki-editor-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--pckt-bg-elevated);
  border-bottom: 1px solid var(--pckt-border);
}

.wiki-editor-crumbs {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  min-width: 0;
}

.wiki-editor-kicker {
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--pckt-accent);
}

.wiki-editor-context {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
}

.wiki-editor-context-link {
  color: var(--pckt-text-muted);
}

.wiki-editor-context-link:hover {
  color: var(--pckt-text);
  text-decoration: none;
}

.wiki-editor-context-sep {
  color: var(--pckt-text-subtle);
}

.wiki-editor-bar-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.wiki-save-state {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  color: var(--pckt-text-subtle);
}

.wiki-save-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--pckt-green);
}

.wiki-save-state-dirty {
  color: var(--pckt-text-muted);
}

.wiki-save-state-dirty .wiki-save-dot {
  background: var(--pckt-yellow);
}

.wiki-publish {
  font-weight: 700;
}

.wiki-post-bluesky {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 12rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--pckt-text-muted);
  cursor: pointer;
  user-select: none;
}

.wiki-post-bluesky input {
  margin: 0;
  flex-shrink: 0;
}

.wiki-editor-tools-shell {
  position: sticky;
  top: 3.5rem;
  z-index: 4;
  border-bottom: 1px solid var(--pckt-border);
  background: var(--pckt-bg-elevated);
}

.wiki-editor-upload-error {
  margin: 0;
  padding: 0.5rem 1rem;
  color: var(--pckt-danger, #b42318);
  font-size: 0.8125rem;
}

.wiki-editor-approved-strip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border-top: 1px solid var(--pckt-border);
  overflow-x: auto;
}

.wiki-editor-approved-label {
  flex: none;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--pckt-text-muted);
}

.wiki-editor-approved-thumb {
  flex: none;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--pckt-border);
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  background: var(--pckt-bg-elevated);
}

.wiki-editor-approved-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wiki-editor-approved-fallback {
  display: block;
  font-size: 0.5625rem;
  padding: 0.125rem;
  color: var(--pckt-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-editor-upload-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--pckt-border);
  background: color-mix(in srgb, var(--pckt-blue) 8%, var(--pckt-bg-elevated));
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
}

.wiki-editor-upload-status-text {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem;
  min-width: 0;
}

.wiki-editor-upload-status-name {
  font-weight: 500;
  color: var(--pckt-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 18rem;
}

.wiki-editor-upload-spinner {
  flex-shrink: 0;
  width: 0.875rem;
  height: 0.875rem;
  border: 2px solid color-mix(in srgb, var(--pckt-blue) 25%, transparent);
  border-top-color: var(--pckt-blue);
  border-radius: 50%;
  animation: wiki-editor-spin 0.7s linear infinite;
}

.wiki-editor-upload-spinner-lg {
  width: 1.5rem;
  height: 1.5rem;
  border-width: 2.5px;
}

@keyframes wiki-editor-spin {
  to {
    transform: rotate(360deg);
  }
}

.wiki-editor-body {
  padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 0.5rem;
}

.wiki-editor-tabs {
  display: flex;
  gap: 0.375rem;
  margin-bottom: 0.75rem;
}

.wiki-editor-tab {
  padding: 0.25rem 0.75rem;
  border-radius: var(--pckt-radius-pill);
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--pckt-text-muted);
  background: var(--pckt-bg-muted);
}

.wiki-editor-tab:hover {
  color: var(--pckt-text);
  text-decoration: none;
}

.wiki-editor-tab-active {
  color: var(--pckt-accent);
  background: var(--pckt-accent-soft);
}

.wiki-editor-title {
  display: block;
  width: 100%;
  margin: 0 0 0.75rem;
  padding: 0.25rem 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-family: var(--pckt-font-content);
  font-size: clamp(1.75rem, 4vw, 2.375rem);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--pckt-text);
}

.wiki-editor-title::placeholder {
  color: var(--pckt-text-subtle);
}

.wiki-editor-title:focus {
  outline: none;
  border-bottom-color: var(--pckt-accent);
}

.wiki-editor-subheader {
  margin: 0 0 1rem;
}

.wiki-editor-subheader :deep(.wiki-header-links.is-subheader) {
  justify-content: flex-start;
  padding: 0.25rem 0 0.5rem;
  /* The wrapper owns the gap below. Leaving the nav's base 1.75rem margin here
     would collapse through and push the body 0.75rem lower than the read view. */
  margin: 0;
}

.wiki-editor-subheader-add {
  display: inline-flex;
  align-items: center;
  margin: 0 0 0.25rem;
  padding: 0.5rem 0.75rem;
  border: 1px dashed var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: transparent;
  color: var(--pckt-text-muted);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    color 0.12s ease,
    background 0.12s ease;
}

.wiki-editor-subheader-add:hover,
.wiki-editor-subheader-add:focus-visible {
  color: var(--pckt-text);
  border-color: color-mix(in srgb, var(--pckt-blue) 55%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-blue) 6%, transparent);
  outline: none;
}

.wiki-editor-subheader-edit {
  margin-top: 0.375rem;
}

.wiki-editor-draft {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.625rem;
  margin-bottom: 1rem;
  padding: 0.75rem 0.875rem;
  border-radius: var(--pckt-radius-sm);
  background: color-mix(in srgb, var(--pckt-yellow) 12%, var(--pckt-bg-elevated));
  border: 1px solid color-mix(in srgb, var(--pckt-yellow) 35%, transparent);
}

.wiki-editor-draft p {
  margin: 0;
  flex: 1 1 12rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--pckt-text-muted);
}

.wiki-editor-draft-actions {
  display: flex;
  gap: 0.375rem;
}

.wiki-editor-surface {
  position: relative;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius);
  background: var(--pckt-bg-elevated);
  overflow: visible;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.wiki-editor-surface:focus-within {
  border-color: color-mix(in srgb, var(--pckt-accent) 55%, var(--pckt-border));
  box-shadow: 0 0 0 3px var(--pckt-accent-soft);
}

.wiki-editor-surface.is-file-drag {
  border-color: color-mix(in srgb, var(--pckt-blue) 55%, var(--pckt-border));
  background: color-mix(in srgb, var(--pckt-blue) 6%, var(--pckt-bg-elevated));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pckt-blue) 16%, transparent);
}

/* "Drop here to set as thumbnail" strip shown while files hover the editor. */
.wiki-editor-thumbzone {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  right: 0.5rem;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 2.5rem;
  padding: 0.4rem 0.75rem;
  box-sizing: border-box;
  border: 1.5px dashed color-mix(in srgb, var(--pckt-blue) 60%, var(--pckt-border));
  border-radius: var(--pckt-radius-btn);
  background: color-mix(in srgb, var(--pckt-blue) 10%, var(--pckt-bg-elevated));
  color: var(--pckt-blue-active, var(--pckt-blue));
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: copy;
}

.wiki-editor-surface.is-uploading {
  border-color: color-mix(in srgb, var(--pckt-blue) 45%, var(--pckt-border));
}

.wiki-editor-upload-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1.5rem;
  background: color-mix(in srgb, var(--pckt-bg-elevated) 82%, transparent);
  backdrop-filter: blur(2px);
  text-align: center;
  pointer-events: none;
}

.wiki-editor-upload-overlay-title {
  margin: 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--pckt-text);
}

.wiki-editor-upload-overlay-detail {
  margin: 0;
  max-width: 24rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--pckt-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-editor-silkdown :deep(.cm-content) {
  padding: 1.5rem clamp(1rem, 3vw, 2rem) 2.5rem;
  max-width: 46rem;
  font-size: 1.0625rem;
  line-height: 1.75;
  min-height: 28rem;
  box-sizing: border-box;
}

.wiki-editor-silkdown :deep(.cm-editor),
.wiki-editor-silkdown :deep(.cm-scroller) {
  min-height: 28rem;
}

.wiki-editor-silkdown :deep(.cm-editor) {
  --silkdown-link-color: var(--pckt-red);
}

.wiki-editor-footer {
  padding: 1.25rem clamp(1rem, 4vw, 2.5rem) 1.75rem;
}

.wiki-summary-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--pckt-text);
}

.wiki-summary-optional {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pckt-text-subtle);
  background: var(--pckt-bg-muted);
  padding: 0.0625rem 0.4375rem;
  border-radius: var(--pckt-radius-pill);
}

.wiki-summary-input {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.9375rem;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.wiki-summary-input:focus {
  outline: none;
  border-color: var(--pckt-accent);
  box-shadow: 0 0 0 3px var(--pckt-accent-soft);
}

.wiki-summary-hint {
  margin: 0.5rem 0 0;
  font-family: var(--pckt-font-ui);
  font-size: 0.75rem;
  color: var(--pckt-text-subtle);
}

.wiki-editor-file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* Inline edit: match read-page layout; float chrome so content doesn’t shift. */
.wiki-editor--inline {
  position: relative;
  overflow: visible;
  background: transparent;
  border: none;
  box-shadow: none;
}

.wiki-editor--inline .wiki-editor-bar {
  position: absolute;
  top: -0.25rem;
  right: 0;
  left: auto;
  z-index: 30;
  flex-wrap: nowrap;
  gap: 0.5rem;
  width: max-content;
  max-width: min(100%, 28rem);
  padding: 0.35rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: var(--pckt-bg-elevated);
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.14);
}

.wiki-editor-inline-label {
  margin: 0;
  padding: 0 0.35rem;
  font-family: var(--pckt-font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pckt-text-muted);
  white-space: nowrap;
}

.wiki-editor--inline .wiki-editor-tools-shell {
  position: fixed;
  top: auto;
  right: auto;
  left: 50%;
  bottom: 5rem;
  z-index: 170;
  transform: translateX(-50%);
  width: max-content;
  max-width: calc(100vw - 2rem);
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: var(--pckt-bg-elevated);
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.14);
}

/* Summary popover: anchored under the bar's Save button, so it never
   reaches past the editing column into the sidebar. */
.wiki-summary-popover {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 1;
  width: min(22rem, calc(100vw - 2.5rem));
  padding: 0.875rem;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-btn);
  background: var(--pckt-bg-elevated);
  box-shadow: 0 8px 24px rgba(17, 24, 39, 0.14);
  text-align: left;
}

.wiki-summary-popover .wiki-summary-label {
  margin-bottom: 0.375rem;
}

.wiki-summary-popover-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.wiki-editor--inline .wiki-editor-body {
  padding: 0;
}

.wiki-editor--inline .wiki-editor-title {
  margin: 0 0 0.75rem;
  padding: 0;
  padding-right: min(14rem, 42%);
  border-bottom: none;
  font-size: clamp(1.75rem, 4vw, 2.25rem);
  font-weight: 900;
  letter-spacing: -0.02em;
  line-height: 1.15;
  box-sizing: border-box;
  /* Match WikiEditable’s dashed field outline (same size before/after open). */
  border-radius: var(--pckt-radius-btn);
  outline: var(--pckt-edit-dash);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-editor--inline .wiki-editor-title:focus {
  border-bottom-color: transparent;
  box-shadow: none;
  outline: var(--pckt-edit-dash-strong);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-editor--inline .wiki-editor-subheader :deep(.wiki-header-links.is-subheader) {
  justify-content: center;
  padding: 0.25rem 0 0.75rem;
  border-bottom: none;
  border-radius: var(--pckt-radius-btn);
  /* Keep the same outer dashed field as WikiEditable when the note editor
     replaces the page header — chip borders alone aren’t enough. */
  outline: var(--pckt-edit-dash);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-editor--inline .wiki-editor-subheader :deep(.wiki-header-links.is-subheader:focus-within) {
  outline: var(--pckt-edit-dash-strong);
  outline-offset: var(--pckt-edit-dash-offset);
}

/* Dashed outline marks the body as writable, matching WikiEditable's fields.
   An outline (not a border) keeps the text in the same place as the read view. */
.wiki-editor--inline .wiki-editor-surface {
  border: none;
  border-radius: var(--pckt-radius-btn);
  background: transparent;
  box-shadow: none;
  outline: var(--pckt-edit-dash);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-editor--inline .wiki-editor-surface:focus-within {
  border-color: transparent;
  box-shadow: none;
  outline: var(--pckt-edit-dash-strong);
  outline-offset: var(--pckt-edit-dash-offset);
}

.wiki-editor--inline .wiki-editor-silkdown :deep(.cm-content) {
  padding: 0 0 2rem;
  max-width: none;
  font-family: var(--pckt-font-content);
  font-size: 1.0625rem;
  line-height: 1.75;
  min-height: 12rem;
}

.wiki-editor--inline .wiki-editor-silkdown :deep(.cm-editor),
.wiki-editor--inline .wiki-editor-silkdown :deep(.cm-scroller) {
  min-height: 12rem;
}

@media (max-width: 768px) {
  .wiki-editor {
    /* Room for the bottom tool strip above the keyboard */
    padding-bottom: calc(var(--pw-toolbar-height) + var(--wiki-keyboard-inset, 0px) + 0.5rem);
  }

  .wiki-editor-bar {
    top: 0;
  }

  .wiki-editor-tools-shell {
    position: fixed;
    left: 0;
    right: 0;
    top: auto;
    bottom: var(--wiki-keyboard-inset, 0px);
    z-index: 40;
    border-top: 1px solid var(--pckt-border);
    border-bottom: none;
    box-shadow: 0 -6px 20px color-mix(in srgb, var(--pckt-text) 8%, transparent);
  }

  .wiki-save-label {
    display: none;
  }

  .wiki-editor-bar-actions {
    width: 100%;
    justify-content: space-between;
  }

  .wiki-editor-body {
    padding: 1rem 1rem 0.5rem;
  }

  .wiki-editor-silkdown :deep(.cm-content) {
    padding: 1rem 1rem 3rem;
    font-size: 1rem;
    line-height: 1.65;
  }

  .wiki-editor-footer {
    padding: 1rem 1rem 1.5rem;
  }

  .wiki-editor--inline {
    padding-bottom: calc(var(--pw-toolbar-height) + var(--wiki-keyboard-inset, 0px) + 0.5rem);
  }

  .wiki-editor--inline .wiki-editor-bar {
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-width: none;
    border-radius: var(--pckt-radius-btn);
  }

  .wiki-editor--inline .wiki-editor-tools-shell {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: var(--wiki-keyboard-inset, 0px);
    transform: none;
    width: auto;
    max-width: none;
    border-radius: 0;
  }

  .wiki-editor--inline .wiki-editor-body {
    padding: 0.75rem 0 0;
  }

  .wiki-editor--inline .wiki-editor-title {
    padding-right: 0;
  }

  .wiki-editor--inline .wiki-editor-silkdown :deep(.cm-content) {
    padding: 0 0 2rem;
  }
}
</style>
