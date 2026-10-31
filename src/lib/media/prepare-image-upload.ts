/** Presets for client-side resize/compress before AT Proto blob upload. */
export type ImageUploadPreset = 'article' | 'thumb' | 'header' | 'icon'

export interface PrepareImageOptions {
  /** Longest edge in CSS pixels (device pixels after canvas). */
  maxEdge: number
  /** WebP / JPEG quality 0–1. */
  quality: number
}

const PRESETS: Record<ImageUploadPreset, PrepareImageOptions> = {
  // Article body: readable on retina, far under the 2MB lexicon cap.
  article: { maxEdge: 1600, quality: 0.9 },
  // Compact companion for srcset / search / media-grid (phone-width article slot).
  thumb: { maxEdge: 640, quality: 0.8 },
  // Wiki header / logo marks.
  header: { maxEdge: 800, quality: 0.92 },
  // Subheader / nav icons (~88–140px CSS; 2× retina ≈ 280).
  icon: { maxEdge: 256, quality: 0.9 },
}

const SKIP_TYPES = new Set(['image/svg+xml', 'image/gif'])

let webpEncodeSupported: boolean | null = null

function supportsWebpEncode(): boolean {
  if (webpEncodeSupported != null) return webpEncodeSupported
  if (typeof document === 'undefined') {
    webpEncodeSupported = false
    return false
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    webpEncodeSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpEncodeSupported = false
  }
  return webpEncodeSupported
}

function optionsFor(presetOrOptions: ImageUploadPreset | PrepareImageOptions): PrepareImageOptions {
  return typeof presetOrOptions === 'string' ? PRESETS[presetOrOptions] : presetOrOptions
}

function outputType(inputType: string): { mime: string; ext: string } {
  if (supportsWebpEncode()) return { mime: 'image/webp', ext: 'webp' }
  if (inputType === 'image/png') return { mime: 'image/png', ext: 'png' }
  return { mime: 'image/jpeg', ext: 'jpg' }
}

function renameFile(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image'
  return `${base}.${ext}`
}

function loadImageBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

/**
 * Resize and recompress an image for upload. SVGs and GIFs pass through
 * unchanged (vector / animation). Non-image files are returned as-is.
 */
export async function prepareImageUpload(
  file: File,
  presetOrOptions: ImageUploadPreset | PrepareImageOptions = 'article',
): Promise<File> {
  if (!file.type.startsWith('image/') || SKIP_TYPES.has(file.type)) {
    return file
  }

  const { maxEdge, quality } = optionsFor(presetOrOptions)

  let bitmap: ImageBitmap
  try {
    bitmap = await loadImageBitmap(file)
  } catch {
    return file
  }

  try {
    const { width, height } = bitmap
    if (width < 1 || height < 1) return file

    const scale = Math.min(1, maxEdge / Math.max(width, height))
    const targetW = Math.max(1, Math.round(width * scale))
    const targetH = Math.max(1, Math.round(height * scale))

    const { mime, ext } = outputType(file.type)
    // Already small enough and already a modern compressed format — keep bytes.
    if (
      scale >= 1 &&
      file.size <= 180_000 &&
      (file.type === 'image/webp' || file.type === 'image/jpeg')
    ) {
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, targetW, targetH)

    const encode = (mime: string) =>
      new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), mime, quality)
      })

    const blob = await encode(mime)
    if (!blob || blob.size === 0) return file

    // Smart PNG path: lossy WebP can smear pixel art and flat-colour
    // illustrations, so also encode a resized PNG (pixel-exact) and keep
    // whichever is smaller. Photographs always go WebP.
    let best = { blob, mime, ext }
    if (file.type === 'image/png' && supportsWebpEncode()) {
      const pngBlob = await encode('image/png')
      if (pngBlob && pngBlob.size > 0 && pngBlob.size < blob.size) {
        best = { blob: pngBlob, mime: 'image/png', ext: 'png' }
      }
    }

    // Prefer the smaller of original vs compressed (e.g. tiny PNGs).
    if (best.blob.size >= file.size && scale >= 1) return file

    return new File([best.blob], renameFile(file.name, best.ext), {
      type: best.mime,
      lastModified: file.lastModified,
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Full article image plus a compact thumb for small UI. When the source is
 * already tiny, `thumb` may be the same File as `full`.
 * `width` / `height` are the full image's intrinsic pixels after resize.
 */
export async function prepareImageUploadPair(
  file: File,
): Promise<{ full: File; thumb: File; width: number; height: number }> {
  const full = await prepareImageUpload(file, 'article')
  const thumb = await prepareImageUpload(file, 'thumb')
  const dims =
    (await readImageDimensions(full)) ??
    (await readImageDimensions(file)) ??
    { width: 16, height: 9 }

  if (thumb.size >= full.size) return { full, thumb: full, ...dims }
  return { full, thumb, ...dims }
}

/** Intrinsic pixel size of an image file, or null if it cannot be decoded. */
export async function readImageDimensions(
  file: Blob,
): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file)
    try {
      if (bitmap.width < 1 || bitmap.height < 1) return null
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

export function prepareImageUploadPreset(
  preset: ImageUploadPreset,
): PrepareImageOptions {
  return { ...PRESETS[preset] }
}
