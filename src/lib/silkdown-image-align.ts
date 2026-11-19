import {
  Prec,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  getSessionBlobPreview,
  isAtprotoBlobUrl,
  resolveBlobSrcSync,
} from '@/lib/atproto/blobs'
import { applyAction, type EditorActionId } from '@/lib/editor/actions'
import {
  findConsecutiveImageRun,
  findImageAt,
  findMarkdownImages,
  findMasonryRun,
  effectiveImageGap,
  moveImageToPosition,
  moveImageWithinRun,
  removeImageFromDoc,
  type ImageAlign,
  type ImageCrop,
  type ImageGap,
  type ImageSize,
  type MarkdownImage,
} from '@/lib/editor/image-align'
import { selectionTouchesRange } from '@/lib/silkdown-decorate'
import { createImageDragZones, type ImageDragZones } from '@/lib/editor/drag-zones'

const ALIGN_CLASSES: Record<ImageAlign, string> = {
  left: 'sd-image--left',
  center: 'sd-image--center',
  right: 'sd-image--right',
}

const SIZE_CLASSES: Record<Exclude<ImageSize, 'full'>, string> = {
  sm: 'sd-image-size--sm',
  md: 'sd-image-size--md',
  lg: 'sd-image-size--lg',
}

const CROP_CLASSES: Record<ImageCrop, string> = {
  rounded: 'sd-image-crop--rounded',
  circle: 'sd-image-crop--circle',
  square: 'sd-image-crop--square',
  wide: 'sd-image-crop--wide',
  tall: 'sd-image-crop--tall',
}

const ALL_ALIGN_CLASSES = Object.values(ALIGN_CLASSES)
const ALL_SIZE_CLASSES = Object.values(SIZE_CLASSES)
const ALL_CROP_CLASSES = Object.values(CROP_CLASSES)

interface GalleryThumb {
  from: number
  src: string
  alt: string
  current: boolean
  crop: ImageCrop | null
  size: ImageSize | null
}

/* ---------------------------------------------------------------------------
 * Gallery drag & drop (the pckt.blog reference flow): thumbs drag with a
 * tilted polaroid ghost, siblings reflow around a gap indicator, and the
 * "set as thumbnail" / "delete" strips appear above and below while dragging.
 * Pointer events (not HTML5 drag) so the identical interaction works with
 * touch on mobile. State is module-level because a drag crosses widget and
 * editor DOM boundaries that CodeMirror state cannot span.
 * ------------------------------------------------------------------------- */

interface ActiveImageDrag {
  view: EditorView
  /** Reveal widget root (drives the is-dragging visuals). Null when null. */
  root: HTMLElement | null
  /** Thumb strip — reorder gap indicators live here. */
  row: HTMLElement | null
  imageFrom: number
  thumbSrc: string
  thumbAlt: string
  pointerId: number
  ghost: HTMLElement | null
  zones: ImageDragZones
  mode: 'reorder' | 'thumbnail' | 'delete' | 'move' | null
  lastX: number
  lastY: number
  startX: number
  startY: number
  started: boolean
}

let activeImageDrag: ActiveImageDrag | null = null

function applyPatchToView(view: EditorView, patch: {
  from: number
  to: number
  insert: string
  selectionStart: number
  selectionEnd: number
}) {
  if (patch.insert === view.state.doc.sliceString(patch.from, patch.to)) return
  view.dispatch({
    changes: { from: patch.from, to: patch.to, insert: patch.insert },
    selection: { anchor: patch.selectionStart, head: patch.selectionEnd },
    scrollIntoView: true,
  })
  view.focus()
}

/** Tilted "polaroid" ghost that follows the cursor, like the reference editor. */
function makePolaroidGhost(src: string, alt: string): HTMLElement {
  const ghost = document.createElement('div')
  ghost.className = 'sd-image-polaroid-ghost'
  const img = document.createElement('img')
  img.src = src
  img.alt = alt
  ghost.appendChild(img)
  ghost.style.position = 'fixed'
  ghost.style.top = '-1000px'
  document.body.appendChild(ghost)
  return ghost
}

function clearDragVisuals(root: HTMLElement | null, row: HTMLElement | null) {
  root?.classList.remove('is-dragging')
  row?.querySelectorAll('.sd-gallery-thumb').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after')
  })
}

function thumbInsertIndex(row: HTMLElement, clientX: number): number {
  const thumbs = Array.from(row.querySelectorAll<HTMLElement>('.sd-gallery-thumb'))
  for (let i = 0; i < thumbs.length; i += 1) {
    const rect = thumbs[i]!.getBoundingClientRect()
    if (clientX < rect.left + rect.width / 2) return i
  }
  return thumbs.length
}

function markDropGap(row: HTMLElement | null, index: number | null) {
  if (!row) return
  const thumbs = Array.from(row.querySelectorAll<HTMLElement>('.sd-gallery-thumb'))
  thumbs.forEach((el, i) => {
    el.classList.toggle('drop-before', index === i)
    el.classList.toggle('drop-after', index === i + 1 && i + 1 === thumbs.length)
  })
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/** Zones sit just outside the widget box, like the reference editor. */
function galleryDragBounds(root: HTMLElement | null) {
  return () => {
    if (!root?.isConnected) return null
    const rect = root.getBoundingClientRect()
    const stripHeight = 40
    return {
      top: new DOMRect(rect.left, rect.top - stripHeight - 6, rect.width, stripHeight),
      bottom: new DOMRect(rect.left, rect.bottom + 6, rect.width, stripHeight),
    }
  }
}

function onGalleryDragMove(event: PointerEvent) {
  const drag = activeImageDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  drag.lastX = event.clientX
  drag.lastY = event.clientY

  if (!drag.started) {
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.hypot(dx, dy) < 6) return
    drag.started = true
    drag.ghost = makePolaroidGhost(drag.thumbSrc, drag.thumbAlt)
    drag.root?.classList.add('is-dragging')
    drag.zones.mount(galleryDragBounds(drag.root))
  }

  if (drag.ghost) {
    drag.ghost.style.left = `${event.clientX - drag.ghost.offsetWidth / 2}px`
    drag.ghost.style.top = `${event.clientY - drag.ghost.offsetHeight / 2}px`
  }

  const hit = drag.zones.hitTest(event.clientX, event.clientY)
  drag.zones.setTarget(hit)
  if (hit) {
    drag.mode = hit
    markDropGap(drag.row, null)
    return
  }

  if (drag.row) {
    const rowRect = drag.row.getBoundingClientRect()
    if (pointInRect(event.clientX, event.clientY, rowRect)) {
      drag.mode = 'reorder'
      markDropGap(drag.row, thumbInsertIndex(drag.row, event.clientX))
      return
    }
  }
  drag.mode = 'move'
  markDropGap(drag.row, null)
}

function onGalleryDragEnd(event: PointerEvent) {
  const drag = activeImageDrag
  if (!drag || event.pointerId !== drag.pointerId) return
  window.removeEventListener('pointermove', onGalleryDragMove)
  window.removeEventListener('pointerup', onGalleryDragEnd)
  window.removeEventListener('pointercancel', onGalleryDragEnd)
  drag.ghost?.remove()
  drag.zones.destroy()
  clearDragVisuals(drag.root, drag.row)
  activeImageDrag = null
  if (!drag.started) return // a tap, not a drag

  const view = drag.view
  const doc = view.state.doc.toString()
  const image = findMarkdownImages(doc).find((im) => im.from === drag.imageFrom)
  if (!image) return

  if (drag.mode === 'delete') {
    applyPatchToView(view, removeImageFromDoc(doc, image))
    return
  }
  if (drag.mode === 'thumbnail') {
    // The page thumbnail is the first body image — move it to the top.
    applyPatchToView(view, moveImageToPosition(doc, image, 0)!)
    return
  }
  if (drag.mode === 'reorder' && drag.row) {
    const run = image.masonry ? findMasonryRun(doc, image) : []
    if (run.length >= 2) {
      const fromIdx = run.findIndex((im) => im.from === image.from)
      const targetIdx = thumbInsertIndex(drag.row, drag.lastX)
      let toIdx = targetIdx
      if (fromIdx >= 0 && targetIdx > fromIdx) toIdx = targetIdx - 1
      const patch = moveImageWithinRun(doc, run, image, toIdx)
      if (patch) applyPatchToView(view, patch)
    }
    return
  }
  if (drag.mode === 'move') {
    const pos = view.posAtCoords({ x: drag.lastX, y: drag.lastY })
    if (pos != null) {
      const patch = moveImageToPosition(doc, image, pos)
      if (patch) applyPatchToView(view, patch)
    }
  }
}

function beginThumbDrag(
  event: PointerEvent,
  thumb: GalleryThumb,
  view: EditorView,
  root: HTMLElement | null,
  row: HTMLElement | null,
) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  activeImageDrag = {
    view,
    root,
    row,
    imageFrom: thumb.from,
    thumbSrc: thumb.src,
    thumbAlt: thumb.alt,
    pointerId: event.pointerId,
    ghost: null,
    zones: createImageDragZones(),
    mode: null,
    lastX: event.clientX,
    lastY: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
  }
  window.addEventListener('pointermove', onGalleryDragMove)
  window.addEventListener('pointerup', onGalleryDragEnd)
  window.addEventListener('pointercancel', onGalleryDragEnd)
}

function makeThumbDraggable(
  img: HTMLImageElement,
  thumb: GalleryThumb,
  view: EditorView,
  root: HTMLElement | null,
  row: HTMLElement | null = null,
) {
  img.addEventListener('pointerdown', (event) => beginThumbDrag(event, thumb, view, root, row))
}

/**
 * Draggable thumb strip for the reveal widget: reorder within the run, drop
 * on the thumbnail/delete zones, or drop anywhere in the text to place the
 * image inline — with hover ✕ remove per thumb.
 */
function buildGalleryThumbRow(
  view: EditorView,
  gallery: GalleryThumb[],
  root: HTMLElement,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'sd-gallery-thumbs'
  row.setAttribute('aria-label', 'Gallery images — drag to reorder')

  for (const thumb of gallery) {
    const cell = document.createElement('div')
    cell.className = 'sd-gallery-thumb'
    const img = document.createElement('img')
    img.src = thumb.src
    img.alt = thumb.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    applyPreviewLayout(img, thumb.size, thumb.crop)
    makeThumbDraggable(img, thumb, view, root, row)
    cell.appendChild(img)

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'sd-gallery-thumb-remove'
    remove.textContent = '✕'
    remove.title = 'Remove image'
    remove.setAttribute('aria-label', `Remove ${thumb.alt || 'image'}`)
    remove.addEventListener('pointerdown', (event) => event.stopPropagation())
    remove.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const doc = view.state.doc.toString()
      const image = findMarkdownImages(doc).find((im) => im.from === thumb.from)
      if (image) applyPatchToView(view, removeImageFromDoc(doc, image))
    })
    cell.appendChild(remove)
    row.appendChild(cell)
  }

  return row
}

function resolveImageSrc(url: string, ownerDid: string | undefined): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (isAtprotoBlobUrl(trimmed)) {
    return getSessionBlobPreview(trimmed) ?? resolveBlobSrcSync(trimmed, ownerDid)
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('blob:') && trimmed.includes('://')) return trimmed
  return null
}

function galleryThumbs(
  images: MarkdownImage[],
  currentFrom: number,
  ownerDid: string | undefined,
): GalleryThumb[] {
  const thumbs: GalleryThumb[] = []
  for (const image of images) {
    const src = resolveImageSrc(image.url, ownerDid)
    if (!src) continue
    thumbs.push({
      from: image.from,
      src,
      alt: image.alt,
      current: image.from === currentFrom,
      crop: image.crop,
      size: image.size,
    })
  }
  return thumbs
}

function applyPreviewLayout(img: HTMLImageElement, size: ImageSize | null, crop: ImageCrop | null) {
  if (size && size !== 'full') img.classList.add(SIZE_CLASSES[size])
  if (crop) img.classList.add(CROP_CLASSES[crop])
}

function appendGalleryPreview(
  parent: HTMLElement,
  thumbs: GalleryThumb[],
  gap: ImageGap,
  dragContext?: { view: EditorView; root: HTMLElement },
) {
  const stage = document.createElement('div')
  stage.className =
    thumbs.length > 1 ? 'sd-image-reveal-gallery' : 'sd-image-reveal-stage'
  if (thumbs.length > 1 && gap !== 'md') {
    stage.classList.add(`sd-image-gap--${gap}`)
  }

  for (const thumb of thumbs) {
    const img = document.createElement('img')
    img.className = 'sd-image-widget sd-image-reveal-preview'
    if (thumb.current && thumbs.length > 1) img.classList.add('is-current')
    applyPreviewLayout(img, thumb.size, thumb.crop)
    img.src = thumb.src
    img.alt = thumb.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    if (dragContext) makeThumbDraggable(img, thumb, dragContext.view, dragContext.root)
    stage.appendChild(img)
  }
  parent.appendChild(stage)
}

function dispatchImageAction(view: EditorView, from: number, id: EditorActionId) {
  const doc = view.state.doc.toString()
  const patch = applyAction(doc, from, from, id)
  const next = doc.slice(0, patch.from) + patch.insert + doc.slice(patch.to)
  if (next === doc) return

  view.dispatch({
    changes: { from: patch.from, to: patch.to, insert: patch.insert },
    selection: { anchor: patch.selectionStart, head: patch.selectionEnd },
    scrollIntoView: true,
  })
  view.focus()
}

function addToolbarButton(
  row: HTMLElement,
  label: string,
  title: string,
  active: boolean,
  onClick: () => void,
) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'sd-image-reveal-btn'
  if (active) btn.classList.add('is-active')
  btn.textContent = label
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.addEventListener('mousedown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  btn.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick()
  })
  row.appendChild(btn)
}

class ImageRevealWidget extends WidgetType {
  readonly src: string
  readonly alt: string
  readonly url: string
  readonly align: ImageAlign | null
  readonly size: ImageSize | null
  readonly crop: ImageCrop | null
  readonly masonry: boolean
  readonly gap: ImageGap
  readonly imageFrom: number
  readonly neighborCount: number
  readonly gallery: GalleryThumb[]
  readonly view: EditorView

  constructor(
    src: string,
    alt: string,
    url: string,
    align: ImageAlign | null,
    size: ImageSize | null,
    crop: ImageCrop | null,
    masonry: boolean,
    gap: ImageGap,
    imageFrom: number,
    neighborCount: number,
    gallery: GalleryThumb[],
    view: EditorView,
  ) {
    super()
    this.src = src
    this.alt = alt
    this.url = url
    this.align = align
    this.size = size
    this.crop = crop
    this.masonry = masonry
    this.gap = gap
    this.imageFrom = imageFrom
    this.neighborCount = neighborCount
    this.gallery = gallery
    this.view = view
  }

  override eq(other: ImageRevealWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.url === this.url &&
      other.align === this.align &&
      other.size === this.size &&
      other.crop === this.crop &&
      other.masonry === this.masonry &&
      other.gap === this.gap &&
      other.imageFrom === this.imageFrom &&
      other.neighborCount === this.neighborCount &&
      other.gallery.length === this.gallery.length &&
      other.gallery.every(
        (thumb, i) =>
          thumb.src === this.gallery[i]?.src &&
          thumb.alt === this.gallery[i]?.alt &&
          thumb.current === this.gallery[i]?.current &&
          thumb.crop === this.gallery[i]?.crop &&
          thumb.size === this.gallery[i]?.size,
      )
    )
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'sd-image-reveal'
    wrap.contentEditable = 'false'

    // Controls stay above the preview so pin/size/crop changes never shift the toolbar.
    const controls = document.createElement('div')
    controls.className = 'sd-image-reveal-controls'
    controls.setAttribute('role', 'toolbar')
    controls.setAttribute('aria-label', 'Image size, pin, crop, and order')

    const sizeAlignRow = document.createElement('div')
    sizeAlignRow.className = 'sd-image-reveal-row'
    const currentSize = this.size ?? 'full'
    const sizes: { id: EditorActionId; label: string; size: ImageSize; title: string }[] = [
      { id: 'imageSizeSm', label: 'S', size: 'sm', title: 'Small' },
      { id: 'imageSizeMd', label: 'M', size: 'md', title: 'Medium' },
      { id: 'imageSizeLg', label: 'L', size: 'lg', title: 'Large' },
      { id: 'imageSizeFull', label: 'Full', size: 'full', title: 'Full width' },
    ]
    for (const item of sizes) {
      addToolbarButton(sizeAlignRow, item.label, item.title, currentSize === item.size, () =>
        dispatchImageAction(this.view, this.imageFrom, item.id),
      )
    }

    const divider = document.createElement('span')
    divider.className = 'sd-image-reveal-divider'
    divider.setAttribute('aria-hidden', 'true')
    sizeAlignRow.appendChild(divider)

    const aligns: { id: EditorActionId; label: string; align: ImageAlign; title: string }[] = [
      { id: 'imageAlignLeft', label: '←', align: 'left', title: 'Pin left' },
      { id: 'imageAlignCenter', label: '↔', align: 'center', title: 'Center' },
      { id: 'imageAlignRight', label: '→', align: 'right', title: 'Pin right' },
    ]
    for (const item of aligns) {
      addToolbarButton(sizeAlignRow, item.label, item.title, this.align === item.align, () =>
        dispatchImageAction(this.view, this.imageFrom, item.id),
      )
    }
    controls.appendChild(sizeAlignRow)

    const cropRow = document.createElement('div')
    cropRow.className = 'sd-image-reveal-row'
    const crops: { id: EditorActionId; label: string; crop: ImageCrop; title: string }[] = [
      { id: 'imageCropRounded', label: 'Round', crop: 'rounded', title: 'Rounded corners' },
      { id: 'imageCropCircle', label: '○', crop: 'circle', title: 'Circle crop' },
      { id: 'imageCropSquare', label: '□', crop: 'square', title: 'Square crop' },
      { id: 'imageCropWide', label: '▭', crop: 'wide', title: 'Wide 16:9 crop' },
      { id: 'imageCropTall', label: '▯', crop: 'tall', title: 'Tall 3:4 crop' },
    ]
    for (const item of crops) {
      addToolbarButton(cropRow, item.label, item.title, this.crop === item.crop, () =>
        dispatchImageAction(this.view, this.imageFrom, item.id),
      )
    }
    controls.appendChild(cropRow)

    const layoutRow = document.createElement('div')
    layoutRow.className = 'sd-image-reveal-row'
    if (!this.masonry) {
      // Standalone images drag to any position in the text (pointer-based,
      // so it works with touch too).
      const moveBtn = document.createElement('button')
      moveBtn.type = 'button'
      moveBtn.className = 'sd-image-reveal-btn'
      moveBtn.textContent = '✥'
      moveBtn.title = 'Drag to move this image anywhere in the page'
      moveBtn.setAttribute('aria-label', 'Drag to move this image')
      moveBtn.addEventListener('pointerdown', (event) => {
        beginThumbDrag(
          event,
          {
            from: this.imageFrom,
            src: this.src,
            alt: this.alt,
            current: false,
            crop: this.crop,
            size: this.size,
          },
          this.view,
          wrap,
          null,
        )
      })
      layoutRow.appendChild(moveBtn)
    }
    const masonryTitle =
      this.neighborCount > 1
        ? this.masonry
          ? `Remove ${this.neighborCount}-image gallery`
          : `Make ${this.neighborCount}-image gallery`
        : this.masonry
          ? 'Remove from gallery (needs a neighboring image)'
          : 'Gallery with neighboring images'
    const masonryLabel =
      this.masonry && this.gallery.length > 1 ? `▦${this.gallery.length}` : '▦'
    addToolbarButton(layoutRow, masonryLabel, masonryTitle, this.masonry, () =>
      dispatchImageAction(this.view, this.imageFrom, 'imageMasonry'),
    )
    if (this.masonry) {
      const gapDivider = document.createElement('span')
      gapDivider.className = 'sd-image-reveal-divider'
      gapDivider.setAttribute('aria-hidden', 'true')
      layoutRow.appendChild(gapDivider)

      const gaps: { id: EditorActionId; label: string; gap: ImageGap; title: string }[] = [
        { id: 'imageGapFlush', label: '0', gap: 'flush', title: 'No gap — images touch' },
        { id: 'imageGapSm', label: '·', gap: 'sm', title: 'Tight gap' },
        { id: 'imageGapMd', label: '··', gap: 'md', title: 'Normal gap' },
        { id: 'imageGapLg', label: '···', gap: 'lg', title: 'Wide gap' },
      ]
      for (const item of gaps) {
        addToolbarButton(layoutRow, item.label, item.title, this.gap === item.gap, () =>
          dispatchImageAction(this.view, this.imageFrom, item.id),
        )
      }
    }
    controls.appendChild(layoutRow)
    wrap.appendChild(controls)

    // The image itself is rendered by silkdown's own image widget (kept live
    // even while the caret is on the line), so this widget only adds controls
    // and a compact caption — no duplicate preview, no raw markdown, no shrink.
    if (this.masonry && this.gallery.length >= 2) {
      // Draggable thumbs with the reference editor's reorder + zone flow.
      wrap.appendChild(buildGalleryThumbRow(this.view, this.gallery, wrap))
    }
    if (this.masonry) {
      const status = document.createElement('div')
      status.className = 'sd-image-reveal-status'
      const gapLabel =
        this.gap === 'flush'
          ? 'touching'
          : this.gap === 'sm'
            ? 'tight gap'
            : this.gap === 'lg'
              ? 'wide gap'
              : 'normal gap'
      status.textContent =
        this.gallery.length > 1
          ? `Gallery · ${this.gallery.length} images · ${gapLabel} — drag a photo to reorder, drop below to delete, or into text to place it`
          : 'Gallery needs another image next to this one'
      wrap.appendChild(status)
    } else if (this.neighborCount > 1) {
      const status = document.createElement('div')
      status.className = 'sd-image-reveal-status'
      status.textContent = `${this.neighborCount} neighboring images — click ▦ for a gallery`
      wrap.appendChild(status)
    }

    const meta = document.createElement('div')
    meta.className = 'sd-image-reveal-meta'
    const altLabel = this.alt.trim() || 'untitled'
    const urlLabel =
      this.url.length > 52 ? `${this.url.slice(0, 22)}…${this.url.slice(-18)}` : this.url
    const altEl = document.createElement('span')
    altEl.className = 'sd-image-reveal-alt'
    altEl.textContent = altLabel
    const sep = document.createElement('span')
    sep.className = 'sd-image-reveal-sep'
    sep.textContent = ' · '
    const urlEl = document.createElement('span')
    urlEl.className = 'sd-image-reveal-url'
    urlEl.textContent = urlLabel
    meta.append(altEl, sep, urlEl)
    wrap.appendChild(meta)

    return wrap
  }

  override ignoreEvent(event: Event): boolean {
    const target = event.target
    if (target instanceof Element && target.closest('.sd-image-reveal-btn')) return true
    return true
  }
}

/** Collapsed preview for a multi-image masonry run while the caret is elsewhere. */
class MasonryGalleryWidget extends WidgetType {
  readonly thumbs: GalleryThumb[]
  readonly gap: ImageGap
  readonly view: EditorView | null

  constructor(thumbs: GalleryThumb[], gap: ImageGap, view: EditorView | null = null) {
    super()
    this.thumbs = thumbs
    this.gap = gap
    this.view = view
  }

  override eq(other: MasonryGalleryWidget): boolean {
    return (
      other.gap === this.gap &&
      other.thumbs.length === this.thumbs.length &&
      other.thumbs.every(
        (thumb, i) => thumb.src === this.thumbs[i]?.src && thumb.alt === this.thumbs[i]?.alt,
      )
    )
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'sd-image-masonry-widget'
    wrap.contentEditable = 'false'
    wrap.setAttribute('role', 'group')
    wrap.setAttribute('aria-label', `Image gallery, ${this.thumbs.length} images`)

    appendGalleryPreview(
      wrap,
      this.thumbs,
      this.gap,
      this.view ? { view: this.view, root: wrap } : undefined,
    )

    const status = document.createElement('div')
    status.className = 'sd-image-reveal-status'
    status.textContent = `Gallery · ${this.thumbs.length} images`
    wrap.appendChild(status)

    return wrap
  }

  override ignoreEvent(): boolean {
    return false
  }
}

function buildRevealDecorations(
  state: EditorState,
  view: EditorView | null,
  ownerDid: string | undefined,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  if (!view) return builder.finish()

  const doc = state.doc
  const docText = doc.toString()
  const images = findMarkdownImages(docText)

  for (const image of images) {
    if (!selectionTouchesRange(doc, state.selection, image.from, image.to)) continue
    const src = resolveImageSrc(image.url, ownerDid)
    if (!src) continue

    const neighbors = findConsecutiveImageRun(docText, image)
    const masonryRun = image.masonry ? findMasonryRun(docText, image) : []
    const gallery = galleryThumbs(masonryRun.length ? masonryRun : [image], image.from, ownerDid)

    const lineStart = doc.lineAt(image.from).from
    builder.add(
      lineStart,
      lineStart,
      Decoration.widget({
        widget: new ImageRevealWidget(
          src,
          image.alt,
          image.url,
          image.align,
          image.size,
          image.crop,
          image.masonry,
          effectiveImageGap(image.gap),
          image.from,
          neighbors.length,
          gallery,
          view,
        ),
        block: true,
        side: -1,
      }),
    )
  }

  return builder.finish()
}

/**
 * When the caret is off a consecutive masonry run of 2+, replace the whole
 * run with one gallery widget so the editor matches the published layout.
 */
function buildCollapsedMasonryDecorations(
  state: EditorState,
  ownerDid: string | undefined,
  view: EditorView | null = null,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = state.doc
  const docText = doc.toString()
  const images = findMarkdownImages(docText)
  const seen = new Set<number>()

  for (const image of images) {
    if (!image.masonry || seen.has(image.from)) continue
    const run = findMasonryRun(docText, image)
    for (const member of run) seen.add(member.from)
    if (run.length < 2) continue

    const from = run[0]!.from
    const to = run[run.length - 1]!.to
    if (selectionTouchesRange(doc, state.selection, from, to)) continue

    const thumbs = galleryThumbs(run, from, ownerDid)
    if (thumbs.length < 2) continue

    builder.add(
      from,
      to,
      Decoration.replace({
        widget: new MasonryGalleryWidget(thumbs, effectiveImageGap(run[0]!.gap), view),
        block: true,
      }),
    )
  }

  return builder.finish()
}

function syncImageLayoutClasses(view: EditorView) {
  const doc = view.state.doc.toString()
  view.dom.querySelectorAll<HTMLImageElement>('img.sd-image-widget').forEach((img) => {
    if (img.classList.contains('sd-image-reveal-preview')) return
    let pos: number
    try {
      pos = view.posAtDOM(img)
    } catch {
      return
    }
    const image = findImageAt(doc, pos)
    const align = image?.align ?? null
    const size = image?.size ?? null
    const crop = image?.crop ?? null
    for (const className of ALL_ALIGN_CLASSES) {
      img.classList.toggle(className, align !== null && ALIGN_CLASSES[align] === className)
    }
    for (const className of ALL_SIZE_CLASSES) {
      img.classList.toggle(
        className,
        size !== null && size !== 'full' && SIZE_CLASSES[size] === className,
      )
    }
    for (const className of ALL_CROP_CLASSES) {
      img.classList.toggle(className, crop !== null && CROP_CLASSES[crop] === className)
    }
    img.classList.toggle('sd-image--masonry', !!image?.masonry)
  })
}

/**
 * Live image helpers for Silkdown:
 * - Align / size classes on collapsed image widgets
 * - Preview + size/order controls while the caret is on an image line
 * - Masonry gallery preview for consecutive masonry images
 */
export function imageAlignExtension(ownerDid?: string): Extension {
  let latestView: EditorView | null = null

  const revealField = StateField.define<DecorationSet>({
    create(state) {
      return buildRevealDecorations(state, latestView, ownerDid)
    },
    update(_decos, tr) {
      return buildRevealDecorations(tr.state, latestView, ownerDid)
    },
    provide: (field) => EditorView.decorations.from(field),
  })

  const masonryField = StateField.define<DecorationSet>({
    create(state) {
      return buildCollapsedMasonryDecorations(state, ownerDid, latestView)
    },
    update(_decos, tr) {
      return buildCollapsedMasonryDecorations(tr.state, ownerDid, latestView)
    },
    provide: (field) => Prec.high(EditorView.decorations.from(field)),
  })

  return [
    revealField,
    masonryField,
    ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          latestView = view
          queueMicrotask(() => {
            syncImageLayoutClasses(view)
            // Refresh reveal widgets now that the view reference exists.
            view.dispatch({ selection: view.state.selection })
          })
        }
        update(update: ViewUpdate) {
          latestView = update.view
          if (update.docChanged || update.viewportChanged || update.geometryChanged) {
            queueMicrotask(() => syncImageLayoutClasses(update.view))
          }
        }
        destroy() {
          if (latestView) latestView = null
        }
      },
    ),
    EditorView.theme({
      '.sd-image-widget': {
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        borderRadius: '0',
        objectFit: 'contain',
      },
      '.sd-image-widget.sd-image--center': {
        display: 'block',
        marginLeft: 'auto',
        marginRight: 'auto',
      },
      '.sd-image-widget.sd-image--left': {
        float: 'left',
        marginRight: '1rem',
        marginBottom: '0.75rem',
        maxWidth: 'min(100%, 20rem)',
      },
      '.sd-image-widget.sd-image--right': {
        float: 'right',
        marginLeft: '1rem',
        marginBottom: '0.75rem',
        maxWidth: 'min(100%, 20rem)',
      },
      '.sd-image-widget.sd-image-size--sm': {
        maxWidth: 'min(100%, 12rem)',
      },
      '.sd-image-widget.sd-image-size--md': {
        maxWidth: 'min(100%, 20rem)',
      },
      '.sd-image-widget.sd-image-size--lg': {
        maxWidth: 'min(100%, 32rem)',
      },
      '.sd-image-widget.sd-image--masonry': {
        outline: '1px dashed color-mix(in srgb, var(--pckt-blue) 45%, transparent)',
        outlineOffset: '2px',
      },
      '.sd-image-widget.sd-image-crop--rounded, .sd-image-reveal-preview.sd-image-crop--rounded': {
        borderRadius: 'var(--pckt-radius-sm)',
      },
      '.sd-image-widget.sd-image-crop--square, .sd-image-reveal-preview.sd-image-crop--square': {
        aspectRatio: '1',
        objectFit: 'cover',
        height: 'auto',
        borderRadius: '0',
      },
      '.sd-image-widget.sd-image-crop--circle, .sd-image-reveal-preview.sd-image-crop--circle': {
        aspectRatio: '1',
        objectFit: 'cover',
        height: 'auto',
        borderRadius: '50%',
      },
      '.sd-image-widget.sd-image-crop--wide, .sd-image-reveal-preview.sd-image-crop--wide': {
        aspectRatio: '16 / 9',
        objectFit: 'cover',
        height: 'auto',
        borderRadius: '0',
      },
      '.sd-image-widget.sd-image-crop--tall, .sd-image-reveal-preview.sd-image-crop--tall': {
        aspectRatio: '3 / 4',
        objectFit: 'cover',
        height: 'auto',
        borderRadius: '0',
      },
      '.sd-image-reveal': {
        display: 'block',
        margin: '0.35rem 0 0.5rem',
        padding: '0.5rem',
        border: '1px solid var(--pckt-border)',
        borderRadius: 'var(--pckt-radius-sm)',
        background: 'var(--pckt-bg-muted)',
      },
      '.sd-image-masonry-widget': {
        display: 'block',
        margin: '0.35rem 0 0.5rem',
        padding: '0.5rem',
        border: '1px solid var(--pckt-border)',
        borderRadius: 'var(--pckt-radius-sm)',
        background: 'var(--pckt-bg-muted)',
      },
      '.sd-image-reveal-stage': {
        display: 'flex',
        justifyContent: 'flex-start',
        marginTop: '0.5rem',
        clear: 'both',
      },
      '.sd-image-reveal-stage--center': {
        justifyContent: 'center',
      },
      '.sd-image-reveal-stage--right': {
        justifyContent: 'flex-end',
      },
      '.sd-image-reveal-gallery': {
        '--sd-img-gap': '0.5rem',
        display: 'block',
        columns: '2 9rem',
        columnGap: 'var(--sd-img-gap)',
        marginTop: '0.5rem',
      },
      '.sd-image-reveal-gallery.sd-image-gap--flush': {
        '--sd-img-gap': '0',
      },
      '.sd-image-reveal-gallery.sd-image-gap--sm': {
        '--sd-img-gap': '0.25rem',
      },
      '.sd-image-reveal-gallery.sd-image-gap--lg': {
        '--sd-img-gap': '1.25rem',
      },
      '.sd-image-reveal-gallery > .sd-image-reveal-preview': {
        display: 'inline-block',
        width: '100%',
        maxWidth: '100%',
        margin: '0 0 var(--sd-img-gap)',
        float: 'none',
        breakInside: 'avoid',
        pageBreakInside: 'avoid',
      },
      '.sd-image-reveal-gallery.sd-image-gap--flush > .sd-image-reveal-preview': {
        borderRadius: '0',
      },
      '.sd-image-reveal-gallery > .sd-image-reveal-preview.is-current': {
        outline: '2px solid color-mix(in srgb, var(--pckt-blue) 70%, transparent)',
        outlineOffset: '2px',
      },
      '.sd-image-reveal-preview': {
        display: 'block',
        float: 'none',
        marginLeft: '0',
        marginRight: '0',
        marginBottom: '0',
        maxWidth: '100%',
        height: 'auto',
        borderRadius: '0',
        objectFit: 'contain',
      },
      '.sd-image-reveal-controls': {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        alignItems: 'center',
      },
      '.sd-image-reveal-row': {
        display: 'inline-flex',
        gap: '0.25rem',
        alignItems: 'center',
      },
      '.sd-image-reveal-divider': {
        width: '1px',
        height: '1.25rem',
        margin: '0 0.15rem',
        background: 'var(--pckt-border)',
      },
      '.sd-image-reveal-btn': {
        minWidth: '1.75rem',
        height: '1.75rem',
        padding: '0 0.4rem',
        border: '1px solid var(--pckt-border)',
        borderRadius: 'var(--pckt-radius-sm)',
        background: 'var(--pckt-bg-elevated)',
        color: 'var(--pckt-text-muted)',
        fontFamily: 'var(--pckt-font-ui)',
        fontSize: '0.75rem',
        fontWeight: '700',
        lineHeight: '1',
        cursor: 'pointer',
      },
      '.sd-image-reveal-btn:hover': {
        color: 'var(--pckt-text)',
        borderColor: 'var(--pckt-border-strong)',
      },
      '.sd-image-reveal-btn.is-active': {
        color: 'var(--pckt-text)',
        borderColor: 'color-mix(in srgb, var(--pckt-blue) 55%, transparent)',
        background: 'color-mix(in srgb, var(--pckt-blue) 10%, var(--pckt-bg-elevated))',
      },
      '.sd-image-reveal-status': {
        marginTop: '0.375rem',
        fontFamily: 'var(--pckt-font-ui)',
        fontSize: '0.6875rem',
        fontWeight: '600',
        letterSpacing: '0.02em',
        color: 'var(--pckt-text-muted)',
      },
      '.sd-image-reveal-meta': {
        marginTop: '0.375rem',
        fontFamily: 'var(--pckt-font-ui)',
        fontSize: '0.75rem',
        fontWeight: '600',
        color: 'var(--pckt-text-muted)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      /* --- Gallery drag & drop --- */
      '.sd-gallery-thumbs': {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        marginTop: '0.5rem',
        touchAction: 'none',
      },
      '.sd-gallery-thumb': {
        position: 'relative',
        cursor: 'grab',
      },
      '.sd-gallery-thumb:active': {
        cursor: 'grabbing',
      },
      '.sd-gallery-thumb img': {
        display: 'block',
        width: '5.5rem',
        height: '4.5rem',
        objectFit: 'cover',
        borderRadius: 'var(--pckt-radius-sm)',
        border: '1px solid var(--pckt-border)',
      },
      '.sd-gallery-thumb.drop-before': {
        boxShadow: '-3px 0 0 0 var(--pckt-blue)',
      },
      '.sd-gallery-thumb.drop-after': {
        boxShadow: '3px 0 0 0 var(--pckt-blue)',
      },
      '.sd-gallery-thumb-remove': {
        position: 'absolute',
        top: '-0.4rem',
        right: '-0.4rem',
        width: '1.1rem',
        height: '1.1rem',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
        border: 'none',
        borderRadius: '50%',
        background: 'var(--pckt-red)',
        color: '#fff',
        fontSize: '0.625rem',
        lineHeight: '1',
        cursor: 'pointer',
      },
      '.sd-gallery-thumb:hover .sd-gallery-thumb-remove, .sd-image-reveal.is-dragging .sd-gallery-thumb-remove': {
        display: 'flex',
      },
      '.sd-image-reveal.is-dragging': {
        outline: '1.5px dashed color-mix(in srgb, var(--pckt-blue) 55%, transparent)',
      },
      '.sd-image-reveal-alt': {
        color: 'var(--pckt-text)',
      },
      '.sd-image-reveal-url': {
        fontWeight: '500',
        wordBreak: 'break-all',
      },
    }),
  ]
}
