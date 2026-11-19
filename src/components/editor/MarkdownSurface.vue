<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  applyAction as buildAction,
  activeActions,
  type ActionContext,
  type EditorActionId,
  type EditPatch,
} from '@/lib/editor/actions'
import { continueBlock, indentLines } from '@/lib/editor/typing'
import { imageFilesFromDrop } from '@/lib/editor/drop-files'
import { highlightMarkdown } from '@/lib/editor/highlight'
import { shortcutAction } from '@/lib/editor/toolbar'
import {
  rankSuggestions,
  wikilinkContextAt,
  type SuggestCandidate,
  type SuggestSource,
  type WikilinkContext,
} from '@/lib/editor/suggest'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** Pages offered by the `[[` typeahead. */
    notes?: SuggestSource[]
    /** Category names offered inside `[[Category:`. */
    categories?: string[]
    minHeight?: string
    spellcheck?: boolean
    ariaLabel?: string
    id?: string
  }>(),
  {
    placeholder: 'Start writing…',
    notes: () => [],
    categories: () => [],
    minHeight: '12rem',
    spellcheck: true,
    ariaLabel: 'Page content',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'active-change': [active: Set<EditorActionId>]
  'image-files': [files: File[]]
  'suggest-change': [open: boolean]
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const highlightRef = ref<HTMLPreElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const highlighted = computed(() => highlightMarkdown(props.modelValue))

/* ------------------------------------------------------------------ */
/* Applying edits                                                      */
/* ------------------------------------------------------------------ */

function selection() {
  const el = textareaRef.value
  return { from: el?.selectionStart ?? 0, to: el?.selectionEnd ?? 0 }
}

/**
 * Applies a patch through `insertText` so the browser keeps it on its own undo
 * stack — that is what makes Cmd+Z work for toolbar actions too.
 */
function applyPatch(patch: EditPatch) {
  const el = textareaRef.value
  if (!el) return

  el.focus()
  el.setSelectionRange(patch.from, patch.to)

  let handled = false
  try {
    handled = patch.insert
      ? document.execCommand('insertText', false, patch.insert)
      : document.execCommand('delete')
  } catch {
    handled = false
  }

  if (!handled) {
    el.setRangeText(patch.insert, patch.from, patch.to, 'end')
  }

  el.setSelectionRange(patch.selectionStart, patch.selectionEnd)
  if (el.value !== props.modelValue) emit('update:modelValue', el.value)
  refreshState()
}

function applyAction(id: EditorActionId, context: ActionContext = {}) {
  const el = textareaRef.value
  if (!el) return
  const { from, to } = selection()
  applyPatch(buildAction(el.value, from, to, id, context))
  if (id === 'wikilink') void nextTick(refreshSuggestions)
}

function setSelection(from: number, to = from) {
  const el = textareaRef.value
  if (!el) return
  el.focus()
  el.setSelectionRange(from, to)
  refreshState()
}

function focus() {
  textareaRef.value?.focus()
}

/* ------------------------------------------------------------------ */
/* Wikilink typeahead                                                  */
/* ------------------------------------------------------------------ */

const suggestContext = ref<WikilinkContext | null>(null)
const suggestItems = ref<SuggestCandidate[]>([])
const suggestIndex = ref(0)
const suggestAnchor = ref({ top: 0, left: 0 })
const focused = ref(false)

const suggestOpen = computed(() => suggestItems.value.length > 0 && focused.value)

watch(suggestOpen, (open) => emit('suggest-change', open))

const categorySources = computed<SuggestSource[]>(() =>
  props.categories.map((name) => ({ slug: name, title: name })),
)

function closeSuggestions() {
  suggestContext.value = null
  suggestItems.value = []
  suggestIndex.value = 0
}

function refreshSuggestions() {
  const el = textareaRef.value
  if (!el || el.selectionStart !== el.selectionEnd) return closeSuggestions()

  const context = wikilinkContextAt(el.value, el.selectionStart)
  if (!context) return closeSuggestions()

  const source = context.mode === 'category' ? categorySources.value : props.notes
  const items = rankSuggestions(source, context.query)
  if (!items.length) return closeSuggestions()

  suggestContext.value = context
  suggestItems.value = items
  suggestIndex.value = Math.min(suggestIndex.value, items.length - 1)
  void nextTick(() => positionSuggestions(context.queryStart))
}

/** Measure the caret against the highlight layer, which mirrors the textarea exactly. */
function positionSuggestions(offset: number) {
  const pre = highlightRef.value
  const root = rootRef.value
  if (!pre || !root) return

  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node = walker.nextNode() as Text | null

  while (node) {
    if (remaining <= node.data.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      const rect = range.getBoundingClientRect()
      const base = root.getBoundingClientRect()
      suggestAnchor.value = {
        top: rect.bottom - base.top + 4,
        left: Math.min(rect.left - base.left, base.width - 240),
      }
      return
    }
    remaining -= node.data.length
    node = walker.nextNode() as Text | null
  }
}

function acceptSuggestion(index: number) {
  const context = suggestContext.value
  const item = suggestItems.value[index]
  const el = textareaRef.value
  if (!context || !item || !el) return

  const insert = `${item.value}]]`
  applyPatch({
    from: context.queryStart,
    to: context.replaceEnd,
    insert,
    selectionStart: context.queryStart + insert.length,
    selectionEnd: context.queryStart + insert.length,
  })
  closeSuggestions()
}

function moveSuggestion(delta: number) {
  const count = suggestItems.value.length
  if (!count) return
  suggestIndex.value = (suggestIndex.value + delta + count) % count
}

/* ------------------------------------------------------------------ */
/* Input handling                                                      */
/* ------------------------------------------------------------------ */

function refreshState() {
  const el = textareaRef.value
  if (!el) return
  emit('active-change', activeActions(el.value, el.selectionStart, el.selectionEnd))
}

function onInput(event: Event) {
  const el = event.target as HTMLTextAreaElement
  emit('update:modelValue', el.value)
  refreshState()
  void nextTick(refreshSuggestions)
}

function onKeydown(event: KeyboardEvent) {
  const el = textareaRef.value
  if (!el) return

  if (suggestOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      return moveSuggestion(1)
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      return moveSuggestion(-1)
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      return acceptSuggestion(suggestIndex.value)
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      return closeSuggestions()
    }
  }

  const shortcut = shortcutAction(event)
  if (shortcut) {
    event.preventDefault()
    return applyAction(shortcut)
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    const patch = continueBlock(el.value, el.selectionStart, el.selectionEnd)
    if (patch) {
      event.preventDefault()
      applyPatch(patch)
    }
    return
  }

  if (event.key === 'Tab') {
    const patch = indentLines(el.value, el.selectionStart, el.selectionEnd, event.shiftKey)
    if (patch) {
      event.preventDefault()
      applyPatch(patch)
    }
    // Otherwise Tab keeps moving focus, which keyboard users depend on.
  }
}

function imageFilesFrom(list: FileList | null | undefined): File[] {
  if (!list) return []
  return Array.from(list).filter((file) => file.type.startsWith('image/'))
}

function onPaste(event: ClipboardEvent) {
  const el = textareaRef.value
  if (!el || !event.clipboardData) return

  const images = imageFilesFrom(event.clipboardData.files)
  if (images.length) {
    event.preventDefault()
    emit('image-files', images)
    return
  }

  // Pasting a URL over selected text turns it into a link instead of replacing it.
  const text = event.clipboardData.getData('text/plain').trim()
  if (!text || el.selectionStart === el.selectionEnd) return
  if (!/^(https?:\/\/|mailto:)\S+$/i.test(text) || /\s/.test(text)) return

  event.preventDefault()
  applyAction('link', { url: text })
}

async function onDrop(event: DragEvent) {
  // Expands folders dragged from the desktop (webkitGetAsEntry traversal).
  const { files } = await imageFilesFromDrop(event.dataTransfer)
  if (!files.length) return
  event.preventDefault()
  emit('image-files', files)
}

function onSelectionChange() {
  if (document.activeElement !== textareaRef.value) return
  refreshState()
  refreshSuggestions()
}

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange)
  refreshState()
})

onUnmounted(() => {
  document.removeEventListener('selectionchange', onSelectionChange)
})

defineExpose({ applyAction, applyPatch, setSelection, focus, selection })
</script>

<template>
  <div ref="rootRef" class="ms" :style="{ '--ms-min-height': minHeight }">
    <pre ref="highlightRef" class="ms-layer" aria-hidden="true" v-html="highlighted" />

    <textarea
      :id="id"
      ref="textareaRef"
      class="ms-input"
      :value="modelValue"
      :placeholder="placeholder"
      :spellcheck="spellcheck"
      :aria-label="ariaLabel"
      autocapitalize="sentences"
      autocorrect="on"
      autocomplete="off"
      wrap="soft"
      @input="onInput"
      @keydown="onKeydown"
      @paste="onPaste"
      @drop="onDrop"
      @focus="focused = true"
      @blur="focused = false"
    />

    <ul
      v-if="suggestOpen"
      class="ms-suggest"
      role="listbox"
      aria-label="Page suggestions"
      :style="{ top: `${suggestAnchor.top}px`, left: `${suggestAnchor.left}px` }"
    >
      <li v-for="(item, index) in suggestItems" :key="item.value + index">
        <button
          type="button"
          role="option"
          class="ms-suggest-item"
          :class="{ 'is-active': index === suggestIndex }"
          :aria-selected="index === suggestIndex"
          @mousedown.prevent="acceptSuggestion(index)"
          @touchstart.prevent="acceptSuggestion(index)"
        >
          <span class="ms-suggest-label">{{ item.label }}</span>
          <span v-if="item.detail" class="ms-suggest-detail">{{ item.detail }}</span>
          <span v-if="item.isNew" class="ms-suggest-badge">new</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/*
 * The <pre> defines the box; the textarea is stretched over it. Because both
 * render the same characters with identical metrics, the highlight can never
 * drift out of alignment and no scroll syncing is needed.
 */
.ms {
  position: relative;
  isolation: isolate;
}

.ms-layer,
.ms-input {
  margin: 0;
  padding: var(--ms-padding, 1.25rem clamp(1rem, 3vw, 1.75rem));
  border: 0;
  font-family: var(--pckt-font-mono);
  font-size: var(--ms-font-size, 0.9375rem);
  line-height: var(--ms-line-height, 1.7);
  letter-spacing: normal;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
}

.ms-layer {
  position: relative;
  z-index: 1;
  min-height: var(--ms-min-height);
  pointer-events: none;
  color: var(--pckt-text);
}

.ms-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  resize: none;
  overflow: hidden;
  background: transparent;
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: var(--pckt-accent);
}

.ms-input:focus {
  outline: none;
}

.ms-input::placeholder {
  color: var(--pckt-text-subtle);
  -webkit-text-fill-color: var(--pckt-text-subtle);
}

/* Translucent so the highlighted text underneath stays readable. */
.ms-input::selection {
  background: color-mix(in srgb, var(--pckt-blue) 32%, transparent);
}

/* --- syntax colours ------------------------------------------------ */

.ms-layer :deep(.hl-mark) {
  color: var(--pckt-text-subtle);
}

/*
 * Only weight, style and colour may vary here: the mono face keeps identical
 * advance widths across those, whereas a different font-size would push the
 * overlay out of step with the textarea underneath.
 */
.ms-layer :deep(.hl-heading) {
  font-weight: 700;
  color: var(--pckt-text);
}

.ms-layer :deep(.hl-h1),
.ms-layer :deep(.hl-h2) {
  color: var(--pckt-accent);
}

.ms-layer :deep(.hl-strong) {
  font-weight: 700;
}

.ms-layer :deep(.hl-em) {
  font-style: italic;
}

.ms-layer :deep(.hl-strike) {
  text-decoration: line-through;
  color: var(--pckt-text-muted);
}

.ms-layer :deep(.hl-wikilink) {
  color: var(--pckt-red);
  font-weight: 600;
}

.ms-layer :deep(.hl-link) {
  color: var(--pckt-blue-active);
}

.ms-layer :deep(.hl-url) {
  color: var(--pckt-text-subtle);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--pckt-text-subtle) 45%, transparent);
}

.ms-layer :deep(.hl-code-inline),
.ms-layer :deep(.hl-code-block),
.ms-layer :deep(.hl-code-lang) {
  color: var(--pckt-green-active);
}

.ms-layer :deep(.hl-quote) {
  color: var(--pckt-text-muted);
  font-style: italic;
}

.ms-layer :deep(.hl-bullet) {
  color: var(--pckt-accent);
  font-weight: 700;
}

.ms-layer :deep(.hl-task) {
  color: var(--pckt-blue-active);
  font-weight: 700;
}

.ms-layer :deep(.hl-template),
.ms-layer :deep(.hl-meta) {
  color: var(--pckt-blue-active);
}

.ms-layer :deep(.hl-rule) {
  color: var(--pckt-text-subtle);
}

.ms-layer :deep(.hl-section) {
  color: var(--pckt-green-active);
  font-weight: 700;
}

/* --- typeahead ----------------------------------------------------- */

.ms-suggest {
  position: absolute;
  z-index: 20;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  width: min(17rem, calc(100% - 2rem));
  max-height: 15rem;
  overflow-y: auto;
  border: 1px solid var(--pckt-border);
  border-radius: var(--pckt-radius-sm);
  background: var(--pckt-bg-elevated);
  box-shadow: var(--pckt-shadow-md);
  overscroll-behavior: contain;
}

.ms-suggest-item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: none;
  border-radius: calc(var(--pckt-radius-sm) - 4px);
  background: transparent;
  color: var(--pckt-text);
  font-family: var(--pckt-font-ui);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.ms-suggest-item.is-active,
.ms-suggest-item:hover {
  background: var(--pckt-bg-muted);
}

.ms-suggest-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-suggest-detail {
  flex-shrink: 0;
  font-family: var(--pckt-font-mono);
  font-size: 0.75rem;
  color: var(--pckt-text-subtle);
}

.ms-suggest-badge {
  flex-shrink: 0;
  padding: 0.05rem 0.375rem;
  border-radius: var(--pckt-radius-pill);
  background: var(--pckt-accent-soft);
  color: var(--pckt-accent);
  font-size: 0.625rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* Docked above the on-screen keyboard where a caret popover cannot be reached. */
@media (max-width: 767px) {
  .ms-suggest {
    position: fixed;
    top: auto !important;
    left: 0 !important;
    right: 0;
    bottom: calc(var(--pw-kb-inset, 0px) + var(--pw-toolbar-height, 3rem));
    width: 100%;
    max-height: 11rem;
    border-radius: 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
  }
}
</style>
