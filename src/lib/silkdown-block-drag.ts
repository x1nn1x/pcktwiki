import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type DecorationSet,
} from '@codemirror/view'
import {
  getMovableBlocks,
  parseEditorBlocks,
  reorderEditorBlocks,
  type EditorBlock,
} from '@/lib/editor-blocks'
import { createImageDragZones } from '@/lib/editor/drag-zones'
import {
  findMarkdownImages,
  moveImageToPosition,
  removeImageFromDoc,
} from '@/lib/editor/image-align'
import { isAtprotoBlobUrl, resolveBlobSrcSync } from '@/lib/atproto/blobs'

const HANDLE_ICON =
  '<svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true"><circle cx="2" cy="2" r="1.5" fill="currentColor"/><circle cx="8" cy="2" r="1.5" fill="currentColor"/><circle cx="2" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="2" cy="14" r="1.5" fill="currentColor"/><circle cx="8" cy="14" r="1.5" fill="currentColor"/></svg>'

interface BlockDragState {
  draggingIndex: number | null
  dropIndex: number | null
}

const setBlockDrag = StateEffect.define<BlockDragState>()

const blockDragState = StateField.define<BlockDragState>({
  create: () => ({ draggingIndex: null, dropIndex: null }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlockDrag)) return effect.value
    }
    return value
  },
})

class BlockHandleMarker extends GutterMarker {
  blockIndex: number

  constructor(blockIndex: number) {
    super()
    this.blockIndex = blockIndex
  }

  eq(other: GutterMarker) {
    return other instanceof BlockHandleMarker && other.blockIndex === this.blockIndex
  }

  toDOM() {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'wiki-editor-block-handle'
    button.dataset.blockIndex = String(this.blockIndex)
    button.setAttribute('aria-label', 'Drag to reorder block')
    button.setAttribute('title', 'Drag to reorder')
    button.innerHTML = HANDLE_ICON
    return button
  }
}

function movableBlockMarkers(view: EditorView) {
  const blocks = parseEditorBlocks(view.state.doc.toString())
  const movable = getMovableBlocks(blocks)
  const builder = new RangeSetBuilder<GutterMarker>()

  for (const block of movable) {
    const line = view.state.doc.lineAt(block.start)
    builder.add(line.from, line.from, new BlockHandleMarker(block.index))
  }

  return builder.finish()
}

function dropIndexFromPointer(
  view: EditorView,
  clientY: number,
  blocks: EditorBlock[],
): number | null {
  const movable = getMovableBlocks(blocks)
  if (movable.length === 0) return null

  for (const block of movable) {
    const line = view.state.doc.lineAt(block.start)
    const rect = view.lineBlockAt(line.from)
    const midpoint = rect.top + rect.height / 2
    if (clientY < midpoint) return block.index
  }

  return movable[movable.length - 1]?.index ?? null
}

function blockLineDecorations(view: EditorView): DecorationSet {
  const drag = view.state.field(blockDragState)
  if (drag.draggingIndex === null && drag.dropIndex === null) {
    return Decoration.none
  }

  const blocks = parseEditorBlocks(view.state.doc.toString())
  const builder = new RangeSetBuilder<Decoration>()

  if (drag.draggingIndex !== null) {
    const dragging = blocks[drag.draggingIndex]
    if (dragging) {
      const startLine = view.state.doc.lineAt(dragging.start).number
      const endLine = view.state.doc.lineAt(Math.max(dragging.end - 1, dragging.start)).number
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber)
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: 'wiki-editor-block-dragging' }),
        )
      }
    }
  }

  if (drag.dropIndex !== null && drag.draggingIndex !== null && drag.dropIndex !== drag.draggingIndex) {
    const target = blocks[drag.dropIndex]
    if (target) {
      const line = view.state.doc.lineAt(target.start)
      const dropClass =
        drag.dropIndex > drag.draggingIndex
          ? 'wiki-editor-block-drop-after'
          : 'wiki-editor-block-drop-before'
      builder.add(line.from, line.from, Decoration.line({ class: dropClass }))
    }
  }

  return builder.finish()
}

class EmptyGutterSpacer extends GutterMarker {
  toDOM() {
    return document.createElement('div')
  }
}

const blockDragGutter = gutter({
  class: 'cm-block-drag-gutter',
  markers: (view) => movableBlockMarkers(view),
  initialSpacer: () => new EmptyGutterSpacer(),
})

const blockDragDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = blockLineDecorations(view)
    }

    update(update: import('@codemirror/view').ViewUpdate) {
      if (
        update.docChanged ||
        update.state.field(blockDragState) !== update.startState.field(blockDragState)
      ) {
        this.decorations = blockLineDecorations(update.view)
      }
    }
  },
  { decorations: (value) => value.decorations },
)

const blockDragInteraction = (ownerDid: string | undefined) =>
  ViewPlugin.define((view) => createBlockDragInteraction(view, ownerDid))

function createBlockDragInteraction(view: EditorView, ownerDid: string | undefined) {
  let dragGhost: HTMLElement | null = null
  let draggingIndex: number | null = null
  let dropIndex: number | null = null
  // Set while the pointer hovers the thumbnail/delete zones on an image drag.
  let zoneMode: 'thumbnail' | 'delete' | null = null
  let draggedImageFrom: number | null = null
  const zones = createImageDragZones()

  function imageBlockAt(blocks: EditorBlock[], index: number) {
    const block = blocks[index]
    if (!block) return null
    const slice = view.state.doc.sliceString(block.start, block.end)
    if (/^\s*$/.test(slice.replace(/!\[[^\]]*\]\([^)]*\)/g, ''))) {
      const images = findMarkdownImages(slice)
      if (images.length === 1) {
        return { block, image: { ...images[0]!, offset: block.start } }
      }
    }
    return null
  }

  function resolveSrc(url: string): string | null {
    if (isAtprotoBlobUrl(url)) {
      return resolveBlobSrcSync(url, ownerDid) ?? null
    }
    return /^https?:\/\//i.test(url) ? url : null
  }

  function setDragState(next: BlockDragState) {
    view.dispatch({ effects: setBlockDrag.of(next) })
  }

  function clearDragState() {
    draggingIndex = null
    dropIndex = null
    setDragState({ draggingIndex: null, dropIndex: null })
  }

  function removeGhost() {
    dragGhost?.remove()
    dragGhost = null
  }

  function onPointerMove(event: PointerEvent) {
    if (draggingIndex === null) return
    const blocks = parseEditorBlocks(view.state.doc.toString())

    // Thumbnail/delete zones take priority on image-block drags.
    if (draggedImageFrom !== null) {
      const hit = zones.hitTest(event.clientX, event.clientY)
      zoneMode = hit
      zones.setTarget(hit)
      if (hit) {
        setDragState({ draggingIndex, dropIndex: null })
      }
    }

    if (!zoneMode) {
      dropIndex = dropIndexFromPointer(view, event.clientY, blocks)
      setDragState({ draggingIndex, dropIndex })
    }

    if (dragGhost) {
      const rect = dragGhost.getBoundingClientRect()
      dragGhost.style.top = `${event.clientY - rect.height / 2}px`
    }
  }

  function onPointerUp() {
    const fromIndex = draggingIndex
    const toIndex = dropIndex
    const mode = zoneMode
    const imageFrom = draggedImageFrom

    removeGhost()
    zones.destroy()
    zoneMode = null
    draggedImageFrom = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
    clearDragState()

    // Zone drops win over block reordering.
    if (mode && imageFrom !== null) {
      const doc = view.state.doc.toString()
      const image = findMarkdownImages(doc).find((item) => item.from === imageFrom)
      if (image) {
        if (mode === 'delete') {
          view.dispatch({
            changes: { from: 0, to: doc.length, insert: applyRemoval(doc, image) },
          })
          view.focus()
          return
        }
        const patch = moveImageToPosition(doc, image, 0)
        if (patch) {
          view.dispatch({
            changes: { from: patch.from, to: patch.to, insert: patch.insert },
            selection: { anchor: patch.selectionStart, head: patch.selectionEnd },
          })
          view.focus()
          return
        }
      }
    }

    if (fromIndex === null || toIndex === null || fromIndex === toIndex) return

    const source = view.state.doc.toString()
    const next = reorderEditorBlocks(source, fromIndex, toIndex)
    if (next === source) return

    view.dispatch({
      changes: { from: 0, to: source.length, insert: next },
    })
    view.focus()
  }

  function applyRemoval(doc: string, image: ReturnType<typeof findMarkdownImages>[number]) {
    const removal = removeImageFromDoc(doc, image)
    return doc.slice(0, removal.from) + doc.slice(removal.to)
  }

  function onHandlePointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>('.wiki-editor-block-handle')
    if (!handle || !view.dom.contains(handle)) return

    const blockIndex = Number(handle.dataset.blockIndex)
    if (Number.isNaN(blockIndex) || blockIndex < 0) return

    event.preventDefault()
    event.stopPropagation()

    draggingIndex = blockIndex
    dropIndex = blockIndex
    setDragState({ draggingIndex, dropIndex })

    const blocks = parseEditorBlocks(view.state.doc.toString())
    const block = blocks[blockIndex]
    if (block) {
      const lineRect = view.lineBlockAt(block.start)
      const contentRect = view.contentDOM.getBoundingClientRect()
      dragGhost = document.createElement('div')
      dragGhost.style.width = `${contentRect.width}px`
      dragGhost.style.left = `${contentRect.left}px`
      dragGhost.style.top = `${lineRect.top}px`

      const imageHit = imageBlockAt(blocks, blockIndex)
      if (imageHit) {
        // Polaroid ghost for image blocks, matching the gallery drag flow.
        const src = resolveSrc(imageHit.image.url)
        draggedImageFrom = imageHit.block.start + imageHit.image.from
        if (src) {
          dragGhost.className = 'sd-image-polaroid-ghost'
          const img = document.createElement('img')
          img.src = src
          img.alt = imageHit.image.alt
          dragGhost.appendChild(img)
        } else {
          dragGhost.className = 'wiki-editor-block-ghost'
          dragGhost.textContent = imageHit.image.alt || 'image'
        }
        // Thumbnail/delete strips appear above/below the editor while dragging.
        zones.mount(() => {
          const rect = view.contentDOM.getBoundingClientRect()
          const stripHeight = 40
          return {
            top: new DOMRect(rect.left, rect.top - stripHeight - 6, rect.width, stripHeight),
            bottom: new DOMRect(rect.left, rect.bottom + 6, rect.width, stripHeight),
          }
        })
      } else {
        dragGhost.className = 'wiki-editor-block-ghost'
        dragGhost.textContent = view.state.doc
          .sliceString(block.start, Math.min(block.end, block.start + 120))
          .replace(/\s+/g, ' ')
          .trim()
      }
      document.body.appendChild(dragGhost)
    }

    handle.setPointerCapture(event.pointerId)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  view.dom.addEventListener('pointerdown', onHandlePointerDown)

  return {
    destroy() {
      view.dom.removeEventListener('pointerdown', onHandlePointerDown)
      removeGhost()
      zones.destroy()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    },
  }
}

export const blockDragTheme = EditorView.baseTheme({
  '.cm-block-drag-gutter': {
    width: '1.5rem',
    background: 'transparent',
  },
  '.cm-block-drag-gutter .wiki-editor-block-handle': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.25rem',
    height: '1.5rem',
    padding: '0',
    border: 'none',
    borderRadius: 'var(--pckt-radius-sm)',
    background: 'transparent',
    color: 'var(--pckt-text-muted)',
    cursor: 'grab',
    opacity: '0',
    transition: 'opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease',
  },
  '.cm-block-drag-gutter:hover .wiki-editor-block-handle, .cm-focused .cm-block-drag-gutter .wiki-editor-block-handle':
    {
      opacity: '1',
    },
  '.cm-block-drag-gutter .wiki-editor-block-handle:hover': {
    background: 'color-mix(in srgb, var(--pckt-blue) 10%, var(--pckt-bg-elevated))',
    color: 'var(--pckt-blue-active)',
  },
  '.cm-block-drag-gutter .wiki-editor-block-handle:active': {
    cursor: 'grabbing',
  },
  '.cm-line.wiki-editor-block-dragging': {
    opacity: '0.35',
  },
  '.cm-line.wiki-editor-block-drop-before': {
    boxShadow: 'inset 0 2px 0 var(--pckt-blue)',
  },
  '.cm-line.wiki-editor-block-drop-after': {
    boxShadow: 'inset 0 -2px 0 var(--pckt-blue)',
  },
  '.wiki-editor-block-ghost': {
    position: 'fixed',
    left: '0',
    top: '0',
    zIndex: '100',
    pointerEvents: 'none',
    opacity: '0.85',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
    background: 'var(--pckt-bg-elevated)',
    borderRadius: 'var(--pckt-radius-sm)',
    padding: '0.5rem 0.75rem',
    fontFamily: 'var(--pckt-font-content)',
    fontSize: '0.875rem',
    maxWidth: '24rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

export function blockDragExtension(ownerDid?: string): Extension[] {
  return [
    blockDragState,
    blockDragGutter,
    blockDragDecorations,
    blockDragInteraction(ownerDid),
    blockDragTheme,
  ]
}
