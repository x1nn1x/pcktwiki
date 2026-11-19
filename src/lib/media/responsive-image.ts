/**
 * Responsive image URLs for imported articles.
 *
 * Wikipedia can serve any width of the same image from a predictable thumb
 * URL, and Fandom has a `scale-to-width-down` variant. Emitting a `srcset`
 * keeps a phone from downloading a 4000px original while a desktop still gets
 * a sharp picture.
 */

export interface ResponsiveImage {
  src: string
  srcSet?: string
  sizes?: string
}

/** Content column width; images never need to exceed it by much. */
const ARTICLE_SIZES = '(max-width: 720px) 100vw, 720px'
const DEFAULT_WIDTHS = [480, 800, 1280]

const WIKIMEDIA_RE =
  /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/([^/]+)\/([^/]+)\/(.+)$/

/** Wikimedia renders SVG/TIFF originals to a raster thumb with a new suffix. */
function thumbFileName(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.svg')) return `${fileName}.png`
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return `${fileName}.jpg`
  return fileName
}

function wikimediaImage(url: string, widths: number[]): ResponsiveImage | null {
  const clean = url.split('?')[0].split('#')[0]
  const match = WIKIMEDIA_RE.exec(clean)
  if (!match) return null

  const [, project, bucket, rawRest] = match
  const rest = rawRest.replace(/^thumb\//, '').replace(/\/\d+px-[^/]+$/, '')
  const fileName = rest.split('/').pop()
  if (!fileName) return null
  // Wikimedia flattens an animated GIF to a still frame when it makes a thumb,
  // so leave the original in place to keep the animation.
  if (/\.gif$/i.test(fileName)) return { src: url }

  const base = `https://upload.wikimedia.org/${project}/${bucket}/thumb/${rest}`
  const name = thumbFileName(fileName)
  const srcSet = widths
    .map((width) => `${base}/${width}px-${name} ${width}w`)
    .join(', ')

  return {
    src: `${base}/800px-${name}`,
    srcSet,
    sizes: ARTICLE_SIZES,
  }
}

const FANDOM_RE =
  /^(https:\/\/static\.wikia\.nocookie\.net\/.+?\/revision\/latest)\/scale-to-width-down\/\d+(\?.*)?$/

function fandomImage(url: string, widths: number[]): ResponsiveImage | null {
  const match = FANDOM_RE.exec(url)
  if (!match) return null
  const [, base, query = ''] = match
  return {
    src: `${base}/scale-to-width-down/800${query}`,
    srcSet: widths
      .map((width) => `${base}/scale-to-width-down/${width}${query} ${width}w`)
      .join(', '),
    sizes: ARTICLE_SIZES,
  }
}

/**
 * Return responsive variants for a known image CDN, or leave the URL alone.
 * Unknown hosts keep working exactly as before.
 */
export function responsiveImage(
  url: string,
  widths: number[] = DEFAULT_WIDTHS,
): ResponsiveImage {
  if (!url || /^(?:data|blob):/i.test(url) || !/^https?:/i.test(url)) {
    return { src: url }
  }
  return wikimediaImage(url, widths) ?? fandomImage(url, widths) ?? { src: url }
}
