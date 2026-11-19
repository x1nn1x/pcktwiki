/**
 * Image layout meta is stored in the CommonMark link title — e.g.
 * `![alt](url "center")`, `![alt](url "thumb:blob:cid")`,
 * `![alt](url "1600x900")`, `![alt](url "md")`, or combined:
 * `![alt](url "center md thumb:blob:cid 1600x900")`.
 *
 * Crop shapes use `rounded` / `circle` / `square` / `wide` / `tall`.
 * Gallery spacing uses `gap0` / `gapsm` / `gapmd` / `gaplg` (default `gapmd`
 * is omitted). Descriptive titles (anything that isn't only these tokens) stay
 * untouched so they can still become the HTML `title` attribute.
 */

import type { EditPatch } from '@/lib/editor/actions'
import { parseEditorBlocks, reorderEditorBlocks } from '@/lib/editor-blocks'

export type ImageAlign = 'left' | 'center' | 'right'
/** Display width presets — distinct from intrinsic `1600x900` pixel dims. */
export type ImageSize = 'sm' | 'md' | 'lg' | 'full'
export type ImageCrop = 'rounded' | 'circle' | 'square' | 'wide' | 'tall'
/** Spacing between images in a masonry gallery. */
export type ImageGap = 'flush' | 'sm' | 'md' | 'lg'

/** CSS aspect-ratio for crops that force a frame (null = natural / rounded-only). */
export function cropAspectRatio(crop: ImageCrop | null | undefined): string | null {
  switch (crop) {
    case 'circle':
    case 'square':
      return '1'
    case 'wide':
      return '16 / 9'
    case 'tall':
      return '3 / 4'
    default:
      return null
  }
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g

const ALIGN_TOKENS = new Set(['left', 'center', 'right'])
const SIZE_TOKENS = new Set(['sm', 'md', 'lg', 'full'])
const CROP_TOKENS = new Set(['rounded', 'circle', 'square', 'wide', 'tall'])
const MASONRY_TOKEN = 'masonry'
const THUMB_PREFIX = 'thumb:'
const DIM_RE = /^(\d{1,5})x(\d{1,5})$/i

const GAP_TOKEN_TO_VALUE: Record<string, ImageGap> = {
  gap0: 'flush',
  'gap-flush': 'flush',
  gapsm: 'sm',
  'gap-sm': 'sm',
  gapmd: 'md',
  'gap-md': 'md',
  gaplg: 'lg',
  'gap-lg': 'lg',
}

const GAP_VALUE_TO_TOKEN: Record<ImageGap, string> = {
  flush: 'gap0',
  sm: 'gapsm',
  md: 'gapmd',
  lg: 'gaplg',
}

export interface ImageTitleMeta {
  align: ImageAlign | null
  size: ImageSize | null
  crop: ImageCrop | null
  /** When true, consecutive masonry images share a masonry gallery. */
  masonry: boolean
  /** Spacing for the masonry gallery; null means the default (`md`). */
  gap: ImageGap | null
  /** Compact blob/https URL for small displays. */
  thumbUrl: string | null
  /** Intrinsic pixel size of the full image — used to reserve layout space. */
  width: number | null
  height: number | null
  /**
   * True when the title is a free-form caption rather than layout meta.
   * Callers should leave the raw title on the token in that case.
   */
  isCaption: boolean
}

export function parseImageAlign(title: string | null | undefined): ImageAlign | null {
  return parseImageTitle(title).align
}

export function parseImageSize(title: string | null | undefined): ImageSize | null {
  return parseImageTitle(title).size
}

export function parseImageCrop(title: string | null | undefined): ImageCrop | null {
  return parseImageTitle(title).crop
}

export function parseImageGap(title: string | null | undefined): ImageGap | null {
  return parseImageTitle(title).gap
}

function emptyMeta(isCaption = false): ImageTitleMeta {
  return {
    align: null,
    size: null,
    crop: null,
    masonry: false,
    gap: null,
    thumbUrl: null,
    width: null,
    height: null,
    isCaption,
  }
}

export function parseImageTitle(title: string | null | undefined): ImageTitleMeta {
  if (!title?.trim()) return emptyMeta()

  const parts = title.trim().split(/\s+/)
  let align: ImageAlign | null = null
  let size: ImageSize | null = null
  let crop: ImageCrop | null = null
  let masonry = false
  let gap: ImageGap | null = null
  let thumbUrl: string | null = null
  let width: number | null = null
  let height: number | null = null
  let sawMeta = false
  const leftover: string[] = []

  for (const part of parts) {
    const lower = part.toLowerCase()
    if (ALIGN_TOKENS.has(lower)) {
      align = lower as ImageAlign
      sawMeta = true
      continue
    }
    if (SIZE_TOKENS.has(lower)) {
      size = lower as ImageSize
      sawMeta = true
      continue
    }
    if (CROP_TOKENS.has(lower)) {
      crop = lower as ImageCrop
      sawMeta = true
      continue
    }
    if (lower === MASONRY_TOKEN) {
      masonry = true
      sawMeta = true
      continue
    }
    const gapValue = GAP_TOKEN_TO_VALUE[lower]
    if (gapValue) {
      gap = gapValue
      sawMeta = true
      continue
    }
    if (lower.startsWith(THUMB_PREFIX)) {
      const value = part.slice(THUMB_PREFIX.length).trim()
      if (value) {
        thumbUrl = value
        sawMeta = true
      }
      continue
    }
    const dim = part.match(DIM_RE)
    if (dim) {
      const w = Number(dim[1])
      const h = Number(dim[2])
      if (w > 0 && h > 0) {
        width = w
        height = h
        sawMeta = true
      }
      continue
    }
    leftover.push(part)
  }

  if (!sawMeta) return emptyMeta(true)

  return {
    align,
    size,
    crop,
    masonry,
    gap,
    thumbUrl,
    width,
    height,
    isCaption: leftover.length > 0,
  }
}

export function serializeImageTitle(meta: {
  align?: ImageAlign | null
  size?: ImageSize | null
  crop?: ImageCrop | null
  masonry?: boolean
  gap?: ImageGap | null
  thumbUrl?: string | null
  width?: number | null
  height?: number | null
}): string | null {
  const parts: string[] = []
  if (meta.align) parts.push(meta.align)
  // `full` is the default display size — omit so markdown stays short.
  if (meta.size && meta.size !== 'full') parts.push(meta.size)
  if (meta.crop) parts.push(meta.crop)
  if (meta.masonry) parts.push(MASONRY_TOKEN)
  // `md` is the default gallery gap — omit so markdown stays short.
  if (meta.gap && meta.gap !== 'md') parts.push(GAP_VALUE_TO_TOKEN[meta.gap])
  if (meta.thumbUrl) parts.push(`${THUMB_PREFIX}${meta.thumbUrl}`)
  if (meta.width && meta.height && meta.width > 0 && meta.height > 0) {
    parts.push(`${Math.round(meta.width)}x${Math.round(meta.height)}`)
  }
  return parts.length ? parts.join(' ') : null
}

function lineStartAt(doc: string, pos: number): number {
  return doc.lastIndexOf('\n', pos - 1) + 1
}

function lineEndAt(doc: string, pos: number): number {
  const next = doc.indexOf('\n', pos)
  return next === -1 ? doc.length : next
}

export interface MarkdownImage {
  from: number
  to: number
  alt: string
  url: string
  title: string | null
  align: ImageAlign | null
  size: ImageSize | null
  crop: ImageCrop | null
  masonry: boolean
  gap: ImageGap | null
  thumbUrl: string | null
  width: number | null
  height: number | null
}

/** Find every markdown image in `doc` (or a slice). */
export function findMarkdownImages(doc: string, start = 0, end = doc.length): MarkdownImage[] {
  const slice = doc.slice(start, end)
  const out: MarkdownImage[] = []
  const re = new RegExp(IMAGE_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(slice)) !== null) {
    const title = match[3] ?? null
    const meta = parseImageTitle(title)
    out.push({
      from: start + match.index,
      to: start + match.index + match[0].length,
      alt: match[1] ?? '',
      url: match[2] ?? '',
      title,
      align: meta.align,
      size: meta.size,
      crop: meta.crop,
      masonry: meta.masonry,
      gap: meta.gap,
      thumbUrl: meta.thumbUrl,
      width: meta.width,
      height: meta.height,
    })
  }
  return out
}

/** Image whose source range contains `pos`, preferring the line under the caret. */
export function findImageAt(doc: string, pos: number): MarkdownImage | null {
  const lineFrom = lineStartAt(doc, pos)
  const lineTo = lineEndAt(doc, pos)
  const onLine = findMarkdownImages(doc, lineFrom, lineTo)
  const hit = onLine.find((img) => img.from <= pos && pos <= img.to)
  if (hit) return hit
  if (onLine.length === 1) return onLine[0]

  const nearby = findMarkdownImages(doc).find((img) => img.from <= pos && pos <= img.to)
  return nearby ?? null
}

export function serializeMarkdownImage(
  img: Pick<MarkdownImage, 'alt' | 'url'> & {
    title?: string | null
    align?: ImageAlign | null
    size?: ImageSize | null
    crop?: ImageCrop | null
    masonry?: boolean
    gap?: ImageGap | null
    thumbUrl?: string | null
    width?: number | null
    height?: number | null
  },
): string {
  const title =
    img.title !== undefined
      ? img.title?.trim() || null
      : serializeImageTitle({
          align: img.align,
          size: img.size,
          crop: img.crop,
          masonry: img.masonry,
          gap: img.gap,
          thumbUrl: img.thumbUrl,
          width: img.width,
          height: img.height,
        })
  return title ? `![${img.alt}](${img.url} "${title}")` : `![${img.alt}](${img.url})`
}

function rewriteImageTitleAt(
  doc: string,
  from: number,
  to: number,
  nextTitle: string | null,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const insert = serializeMarkdownImage({
    alt: img.alt,
    url: img.url,
    title: nextTitle,
  })
  return {
    from: img.from,
    to: img.to,
    insert,
    selectionStart: img.from,
    selectionEnd: img.from + insert.length,
  }
}

function rewriteImageRun(
  doc: string,
  run: MarkdownImage[],
  caret: MarkdownImage,
  nextTitleFor: (image: MarkdownImage) => string | null,
): EditPatch {
  const rangeFrom = run[0]!.from
  const rangeTo = run[run.length - 1]!.to

  let insert = doc.slice(rangeFrom, rangeTo)
  for (let i = run.length - 1; i >= 0; i--) {
    const image = run[i]!
    const localFrom = image.from - rangeFrom
    const localTo = image.to - rangeFrom
    const rewritten = serializeMarkdownImage({
      alt: image.alt,
      url: image.url,
      title: nextTitleFor(image),
    })
    insert = insert.slice(0, localFrom) + rewritten + insert.slice(localTo)
  }

  const caretImage = serializeMarkdownImage({
    alt: caret.alt,
    url: caret.url,
    title: nextTitleFor(caret),
  })
  const caretOffset = insert.indexOf(caretImage)
  const selectionStart = rangeFrom + (caretOffset >= 0 ? caretOffset : 0)

  return {
    from: rangeFrom,
    to: rangeTo,
    insert,
    selectionStart,
    selectionEnd: selectionStart + caretImage.length,
  }
}

/** Rewrite the image under the caret (or on its line) to the given alignment. */
export function setImageAlignAt(
  doc: string,
  from: number,
  to: number,
  align: ImageAlign,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const meta = parseImageTitle(img.title)
  const nextAlign = img.align === align ? null : align
  const nextTitle = meta.isCaption
    ? nextAlign
    : serializeImageTitle({
        align: nextAlign,
        size: meta.size,
        crop: meta.crop,
        masonry: meta.masonry,
        gap: meta.gap,
        thumbUrl: meta.thumbUrl,
        width: meta.width,
        height: meta.height,
      })

  return rewriteImageTitleAt(doc, from, to, nextTitle)
}

/** Rewrite the image under the caret to the given display size. */
export function setImageSizeAt(
  doc: string,
  from: number,
  to: number,
  size: ImageSize,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const meta = parseImageTitle(img.title)
  const current = img.size ?? 'full'
  const nextSize = current === size ? null : size === 'full' ? null : size
  const nextTitle = meta.isCaption
    ? nextSize
    : serializeImageTitle({
        align: meta.align,
        size: nextSize,
        crop: meta.crop,
        masonry: meta.masonry,
        gap: meta.gap,
        thumbUrl: meta.thumbUrl,
        width: meta.width,
        height: meta.height,
      })

  return rewriteImageTitleAt(doc, from, to, nextTitle)
}

/** Rewrite the image under the caret to the given crop shape. */
export function setImageCropAt(
  doc: string,
  from: number,
  to: number,
  crop: ImageCrop,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const meta = parseImageTitle(img.title)
  const nextCrop = img.crop === crop ? null : crop
  const nextTitle = meta.isCaption
    ? nextCrop
    : serializeImageTitle({
        align: meta.align,
        size: meta.size,
        crop: nextCrop,
        masonry: meta.masonry,
        gap: meta.gap,
        thumbUrl: meta.thumbUrl,
        width: meta.width,
        height: meta.height,
      })

  return rewriteImageTitleAt(doc, from, to, nextTitle)
}

/**
 * Images that touch each other with only whitespace between them form a run.
 * Masonry galleries are built from these runs so one click can include neighbors.
 */
export function findConsecutiveImageRun(doc: string, around: MarkdownImage): MarkdownImage[] {
  const images = findMarkdownImages(doc)
  const idx = images.findIndex((img) => img.from === around.from && img.to === around.to)
  if (idx < 0) return [around]

  const isAdjacent = (a: MarkdownImage, b: MarkdownImage) => /^\s*$/.test(doc.slice(a.to, b.from))

  let start = idx
  while (start > 0 && isAdjacent(images[start - 1]!, images[start]!)) start--
  let end = idx
  while (end < images.length - 1 && isAdjacent(images[end]!, images[end + 1]!)) end++

  return images.slice(start, end + 1)
}

/** Consecutive masonry-tagged neighbors containing `around` (empty when it isn't masonry). */
export function findMasonryRun(doc: string, around: MarkdownImage): MarkdownImage[] {
  if (!around.masonry) return []
  const run = findConsecutiveImageRun(doc, around)
  const idx = run.findIndex((img) => img.from === around.from)
  if (idx < 0) return [around]

  let start = idx
  while (start > 0 && run[start - 1]!.masonry) start--
  let end = idx
  while (end < run.length - 1 && run[end + 1]!.masonry) end++

  return run.slice(start, end + 1)
}

/** Effective gallery gap for an image (default `md` when unset). */
export function effectiveImageGap(gap: ImageGap | null | undefined): ImageGap {
  return gap ?? 'md'
}

function titleWithMasonry(img: MarkdownImage, masonry: boolean): string | null {
  const meta = parseImageTitle(img.title)
  if (meta.isCaption) {
    if (masonry) return MASONRY_TOKEN
    return null
  }
  return serializeImageTitle({
    align: meta.align,
    size: meta.size,
    crop: meta.crop,
    masonry,
    // Gap only applies to galleries — drop it when leaving masonry.
    gap: masonry ? meta.gap : null,
    thumbUrl: meta.thumbUrl,
    width: meta.width,
    height: meta.height,
  })
}

/**
 * Toggle masonry for the consecutive image run around the caret.
 * Enabling marks every adjacent image so the gallery is visible immediately;
 * disabling clears the whole run.
 */
export function setImageMasonryAt(
  doc: string,
  from: number,
  to: number,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const run = findConsecutiveImageRun(doc, img)
  const nextMasonry = !img.masonry
  return rewriteImageRun(doc, run, img, (image) => titleWithMasonry(image, nextMasonry))
}

/**
 * Set gallery spacing for the masonry run around the caret.
 * Applies to the whole run; choosing the active gap again resets to the default.
 */
export function setImageGapAt(
  doc: string,
  from: number,
  to: number,
  gap: ImageGap,
): EditPatch | null {
  const img = findImageAt(doc, from) ?? (from !== to ? findImageAt(doc, to) : null)
  if (!img) return null

  const run = img.masonry ? findMasonryRun(doc, img) : findConsecutiveImageRun(doc, img)
  const current = effectiveImageGap(img.gap)
  const nextGap: ImageGap | null = current === gap ? null : gap === 'md' ? null : gap

  return rewriteImageRun(doc, run, img, (image) => {
    const meta = parseImageTitle(image.title)
    if (meta.isCaption) {
      return serializeImageTitle({
        masonry: true,
        gap: nextGap,
      })
    }
    return serializeImageTitle({
      align: meta.align,
      size: meta.size,
      crop: meta.crop,
      masonry: true,
      gap: nextGap,
      thumbUrl: meta.thumbUrl,
      width: meta.width,
      height: meta.height,
    })
  })
}

/**
 * Move one image of a consecutive run to another slot in the same run.
 * The run is rebuilt with uniform single-newline separators so gallery runs
 * stay adjacent — this is what gallery-thumb drag-and-drop calls on drop.
 */
export function moveImageWithinRun(
  doc: string,
  run: MarkdownImage[],
  image: MarkdownImage,
  targetIndex: number,
): EditPatch | null {
  if (run.length < 2) return null
  const fromIdx = run.findIndex((item) => item.from === image.from && item.to === image.to)
  if (fromIdx < 0 || targetIndex < 0 || targetIndex >= run.length || targetIndex === fromIdx) {
    return null
  }

  const ordered = [...run]
  ordered.splice(fromIdx, 1)
  ordered.splice(targetIndex, 0, image)

  const insert = ordered
    .map((item) => doc.slice(item.from, item.to))
    .join('\n')

  return {
    from: run[0]!.from,
    to: run[run.length - 1]!.to,
    insert,
    // Keep the caret on the moved image inside the rebuilt run.
    selectionStart: run[0]!.from,
    selectionEnd: run[0]!.from,
  }
}

/** Line-spanning range that removes an image and any line it has to itself. */
export function removeImageFromDoc(doc: string, image: MarkdownImage): EditPatch {
  const lineStart = lineStartAt(doc, image.from)
  const lineEnd = lineEndAt(doc, image.to)
  const onlyImageOnLine = /^\s*$/.test(doc.slice(lineStart, image.from) + doc.slice(image.to, lineEnd))
  let from = image.from
  let to = image.to
  if (onlyImageOnLine) {
    from = lineStart
    to = Math.min(doc.length, lineEnd + 1) // swallow the newline too
    // Collapse a leftover blank paragraph: swallow one preceding newline when
    // the image sat between blank lines (…\n\n![img](…)\n…).
    if (from >= 2 && doc[from - 1] === '\n' && doc[from - 2] === '\n') {
      from -= 1
    }
  }
  return { from, to, insert: '', selectionStart: from, selectionEnd: from }
}

/** Standalone copy of an image's markdown — gallery meta stripped. */
export function standaloneImageMarkdown(image: MarkdownImage): string {
  const meta = parseImageTitle(image.title)
  return serializeMarkdownImage({
    alt: image.alt,
    url: image.url,
    title: meta.isCaption
      ? null
      : serializeImageTitle({
          align: meta.align,
          size: meta.size,
          crop: meta.crop,
          thumbUrl: meta.thumbUrl,
          width: meta.width,
          height: meta.height,
        }),
  })
}

/**
 * Move an image to an arbitrary document position (gallery → text placement).
 * The source range is removed first; `to` is a position in the *original* doc
 * and is re-clamped after removal.
 */
export function moveImageToPosition(
  doc: string,
  image: MarkdownImage,
  to: number,
  markdownOverride?: string,
): EditPatch | null {
  const removal = removeImageFromDoc(doc, image)
  const insertText = markdownOverride ?? standaloneImageMarkdown(image)
  if (!insertText) return null

  // Re-clamp the target against the post-removal document.
  let target = to
  if (target > removal.from) {
    target -= removal.to - removal.from
    if (to <= removal.to) target = removal.from
  }
  target = Math.max(0, Math.min(doc.length - (removal.to - removal.from), target))

  const next = doc.slice(0, removal.from) + doc.slice(removal.to)
  // Pad with blank lines so the image lands as its own block.
  let insert = insertText
  const before = next.slice(0, target)
  const after = next.slice(target)
  if (before.trim() && !/\n\n$/.test(before)) {
    insert = (before.endsWith('\n') ? '\n' : '\n\n') + insert
  }
  if (after.trim() && !/^\n\n/.test(after)) {
    insert += after.startsWith('\n') ? '\n' : '\n\n'
  }

  const finalFrom = removal.from
  return {
    from: 0,
    to: next.length,
    insert: next.slice(0, target) + insert + next.slice(target),
    selectionStart: finalFrom + target + (before.trim() ? (before.endsWith('\n') ? 1 : 2) : 0),
    selectionEnd: finalFrom + target + (before.trim() ? (before.endsWith('\n') ? 1 : 2) : 0),
  }
}

/**
 * Move the top-level block that contains `pos` by one slot among movable blocks.
 * Returns null when there is nowhere to move.
 */
export function moveBlockContaining(
  doc: string,
  pos: number,
  direction: -1 | 1,
): EditPatch | null {
  const blocks = parseEditorBlocks(doc)
  const index = blocks.findIndex((block) => pos >= block.start && pos < block.end)
  if (index < 0) return null
  if (blocks[index]?.fixed) return null

  const movable = blocks
    .map((block, i) => ({ block, i }))
    .filter(({ block }) => !block.fixed)
  const movableAt = movable.findIndex(({ i }) => i === index)
  if (movableAt < 0) return null

  const target = movable[movableAt + direction]
  if (!target) return null

  const next = reorderEditorBlocks(doc, index, target.i)
  if (next === doc) return null

  // Keep the caret on the moved block's new start.
  const nextBlocks = parseEditorBlocks(next)
  const moved = nextBlocks.find((block) => {
    const text = doc.slice(blocks[index].start, blocks[index].end)
    return next.slice(block.start, block.end) === text
  })
  const caret = moved?.start ?? 0

  return {
    from: 0,
    to: doc.length,
    insert: next,
    selectionStart: caret,
    selectionEnd: caret,
  }
}
