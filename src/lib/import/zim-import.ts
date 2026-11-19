/**
 * Import one article out of a ZIM archive.
 *
 * ZIM pages keep their media as separate archive entries, so the article's
 * `<img src>` values point inside the file rather than at a CDN. This reads
 * those blobs and embeds small ones as data URLs so the converted markdown has
 * its pictures immediately; large ones are skipped with a warning rather than
 * turning a note into megabytes of base64.
 */
import { convertWikipediaHtml, type WikipediaImportResult } from '@/lib/import/wikipedia'
import type { ZimArchive, ZimArticle } from '@/lib/import/zim'

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 300_000
const MAX_TOTAL_IMAGE_BYTES = 1_200_000

function bytesToDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

/** Resolve an article-relative `src` (`../C/foo.png`) to a ZIM path. */
export function resolveZimMediaPath(articlePath: string, src: string): string {
  try {
    const url = new URL(src, `https://zim.local/${articlePath}`)
    return url.pathname.replace(/^\/+/, '')
  } catch {
    return src.split('#')[0].split('?')[0].replace(/^\/+/, '')
  }
}

const ZIM_ORIGIN = 'https://zim.local'

/**
 * ZIM articles link to each other with bare archive paths (`Climate_system`,
 * `../C/Coal`), not `/wiki/Title`. Rewrite them to the shape the MediaWiki
 * converter understands so internal links become `[[wikilinks]]`.
 */
function rewriteArticleLinks(doc: Document, articlePath: string): void {
  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue
    try {
      const url = new URL(href, `${ZIM_ORIGIN}/${articlePath}`)
      const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const title = path.replace(/^(?:A|C|I)\//, '').split('/').pop()
      if (!title) continue
      anchor.setAttribute('href', `/wiki/${title}`)
    } catch {
      // Leave unusual hrefs alone; the converter drops what it cannot read.
    }
  }
}

export async function convertZimArticle(
  zim: ZimArchive,
  article: ZimArticle,
): Promise<WikipediaImportResult> {
  const html = await zim.readArticle(article)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  rewriteArticleLinks(doc, article.path)

  const warnings: string[] = []
  let embedded = 0
  let skipped = 0
  let totalBytes = 0

  // Removing only the <img> leaves an orphaned caption behind, which reads as
  // a random sentence at the top of the note. Drop the figure with it.
  const dropImage = (img: Element) => {
    const container = img.closest('figure, .thumb, .gallerybox, .tsingle')
    if (container) container.remove()
    else img.remove()
  }

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')

    if (!src || src.startsWith('data:') || /^https?:/i.test(src)) {
      // Mini ZIMs replace artwork with inline SVG alt-text placeholders; they
      // carry no picture, so drop them instead of bloating the note.
      if (src.startsWith('data:')) dropImage(img)
      continue
    }
    if (embedded >= MAX_IMAGES) {
      dropImage(img)
      skipped += 1
      continue
    }

    const resource = await zim.readResource(resolveZimMediaPath(article.path, src))
    if (!resource || !resource.mimeType.startsWith('image/')) {
      dropImage(img)
      skipped += 1
      continue
    }
    if (
      resource.data.byteLength > MAX_IMAGE_BYTES ||
      totalBytes + resource.data.byteLength > MAX_TOTAL_IMAGE_BYTES
    ) {
      dropImage(img)
      skipped += 1
      continue
    }

    img.setAttribute('src', bytesToDataUrl(resource.data, resource.mimeType))
    embedded += 1
    totalBytes += resource.data.byteLength
  }

  if (embedded) {
    warnings.push(
      `${embedded} image${embedded === 1 ? '' : 's'} embedded from the archive. Re-upload them to your PDS if you want them to live outside the note.`,
    )
  }
  if (skipped) {
    warnings.push(
      `${skipped} image${skipped === 1 ? ' was' : 's were'} skipped (too large or missing from the archive).`,
    )
  }

  const result = convertWikipediaHtml(
    doc.documentElement.outerHTML,
    article.title || 'Imported page',
    [],
    { extraWarnings: warnings, origin: ZIM_ORIGIN },
  )
  return {
    ...result,
    title: result.title || article.title,
    sourceName: `ZIM · ${zim.fileName}`,
    sourceUrl: article.path,
  }
}
