<script setup lang="ts">
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, placeholder as placeholderExtension } from '@codemirror/view'
import { silkdown } from '@silkdown/core'
import '@silkdown/core/theme.css'
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { resolvePdsUrl } from '@/lib/atproto/pds'
import { createWikiUrlPolicy } from '@/lib/silkdown-url-policy'
import { wikiLinkExtension, wikiSyntaxTheme } from '@/lib/silkdown-wikilink'
import { infoboxExtension, infoboxTheme } from '@/lib/silkdown-infobox'
import { youtubeExtension, youtubeTheme } from '@/lib/silkdown-youtube'
import { blockDragExtension } from '@/lib/silkdown-block-drag'
import { imageAlignExtension } from '@/lib/silkdown-image-align'

const PROP_SYNC = Annotation.define<true>()

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    minHeight?: string
    blockDrag?: boolean
    pickMode?: boolean
    extensions?: Extension[]
    /** Wiki owner DID — rewrites `blob:cid` image srcs for live preview. */
    ownerDid?: string
  }>(),
  {
    placeholder: '',
    minHeight: undefined,
    blockDrag: false,
    pickMode: false,
    extensions: () => [],
    ownerDid: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  ready: [view: EditorView]
}>()

const hostRef = ref<HTMLDivElement | null>(null)
const viewRef = shallowRef<EditorView | null>(null)
const silkdownCompartment = new Compartment()
const imageCompartment = new Compartment()
const extensionsCompartment = new Compartment()
const editableCompartment = new Compartment()

function silkdownExtension(ownerDid: string | undefined) {
  return silkdown({ urlPolicy: createWikiUrlPolicy(ownerDid || undefined) })
}

function buildExtensions(
  extra: Extension[] = [],
  enableBlockDrag = false,
  pickMode = false,
  ownerDid = '',
) {
  return [
    editableCompartment.of(EditorView.editable.of(!pickMode)),
    silkdownCompartment.of(silkdownExtension(ownerDid)),
    imageCompartment.of(imageAlignExtension(ownerDid || undefined)),
    ...(props.placeholder ? [placeholderExtension(props.placeholder)] : []),
    wikiLinkExtension(),
    wikiSyntaxTheme,
    infoboxExtension(ownerDid || undefined),
    infoboxTheme,
    youtubeExtension(),
    youtubeTheme,
    ...(enableBlockDrag ? blockDragExtension(ownerDid || undefined) : []),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.some((tr) => tr.annotation(PROP_SYNC))) return
      emit('update:modelValue', update.state.doc.toString())
    }),
    EditorView.theme({
      '&': {
        minHeight: props.minHeight ?? '11rem',
        height: '100%',
        fontFamily: 'var(--pckt-font-content)',
        fontSize: '0.9375rem',
        lineHeight: '1.55',
      },
      '.cm-scroller': {
        overflow: 'auto',
        minHeight: '100%',
      },
      '.cm-content': {
        padding: '0.6875rem 1rem',
        // Fill the editor chrome so empty space below the last line is still clickable.
        minHeight: props.minHeight ?? '11rem',
        boxSizing: 'border-box',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-placeholder': {
        color: 'var(--pckt-text-subtle)',
      },
    }),
    extensionsCompartment.of(extra),
  ]
}

function reconfigureSilkdown(ownerDid: string | undefined) {
  viewRef.value?.dispatch({
    effects: [
      silkdownCompartment.reconfigure(silkdownExtension(ownerDid)),
      imageCompartment.reconfigure(imageAlignExtension(ownerDid)),
    ],
  })
}

onMounted(() => {
  const host = hostRef.value
  if (!host) return

  const view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: buildExtensions(
        props.extensions,
        props.blockDrag,
        props.pickMode,
        props.ownerDid,
      ),
    }),
    parent: host,
  })

  viewRef.value = view
  emit('ready', view)

  // Warm the PDS cache, then refresh decorations so blob: images can resolve.
  if (props.ownerDid) {
    void resolvePdsUrl(props.ownerDid)
      .then(() => reconfigureSilkdown(props.ownerDid))
      .catch(() => {
        /* leave raw markdown until the wiki load caches the PDS */
      })
  }
})

onUnmounted(() => {
  viewRef.value?.destroy()
  viewRef.value = null
})

watch(
  () => props.modelValue,
  (value) => {
    const view = viewRef.value
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: PROP_SYNC.of(true),
    })
  },
)

watch(
  () => props.extensions,
  (extensions) => {
    viewRef.value?.dispatch({
      effects: extensionsCompartment.reconfigure(extensions ?? []),
    })
  },
)

watch(
  () => props.pickMode,
  (pickMode) => {
    viewRef.value?.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!pickMode)),
    })
  },
)

watch(
  () => props.ownerDid,
  (ownerDid) => {
    if (!ownerDid) {
      reconfigureSilkdown(undefined)
      return
    }
    void resolvePdsUrl(ownerDid)
      .then(() => reconfigureSilkdown(ownerDid))
      .catch(() => reconfigureSilkdown(ownerDid))
  },
)

defineExpose({
  getView: () => viewRef.value,
})
</script>

<template>
  <div ref="hostRef" class="silkdown-editor-host" />
</template>

<style scoped>
.silkdown-editor-host {
  width: 100%;
  min-height: inherit;
  height: 100%;
}

.silkdown-editor-host :deep(.cm-editor) {
  background: transparent;
}

.silkdown-editor-host :deep(.cm-scroller),
.silkdown-editor-host :deep(.cm-content) {
  min-height: inherit;
}

.silkdown-editor-host :deep(.cm-gutters:not(.cm-block-drag-gutter)) {
  display: none;
}
</style>
