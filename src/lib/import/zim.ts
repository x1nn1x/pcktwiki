/**
 * Minimal ZIM reader for the import page.
 *
 * ZIM is the archive format Kiwix uses for offline Wikipedia, wiki.gg mirrors
 * and other MediaWiki exports. A full implementation is a lot of code; this
 * covers what importing one article needs:
 *
 *  - header + MIME list + URL pointer list
 *  - directory entries (including redirects)
 *  - uncompressed, zlib and Zstandard clusters
 *  - reading an article blob and image blobs by path
 *
 * Archives are read with `Blob.slice`, so a multi-gigabyte file is never loaded
 * into memory at once. Browsing is capped: a full Wikipedia ZIM has millions of
 * entries, and listing every title in a page is neither fast nor useful.
 */
import { decompress as zstdDecompress } from 'fzstd'

const MAGIC = 0x044d495a
const HEADER_SIZE = 80
const MAX_LISTED_ENTRIES = 80_000
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024
const MAX_CLUSTER_BYTES = 64 * 1024 * 1024
const REDIRECT_MIME = 0xffff

export interface ZimEntry {
  index: number
  namespace: string
  url: string
  title: string
  mimeType: string
  redirectIndex: number | null
  clusterNumber: number
  blobNumber: number
}

export interface ZimArticle {
  index: number
  path: string
  title: string
}

export interface ZimResource {
  mimeType: string
  data: Uint8Array
}

export interface ZimArchive {
  fileName: string
  entryCount: number
  articleCount: number
  /** Every HTML article, title-sorted. Use `listArticles(query)` to filter. */
  listArticles(query?: string, limit?: number): ZimArticle[]
  readArticle(article: ZimArticle): Promise<string>
  /** Read an image/other blob by ZIM path (`I/foo.png`) or bare URL. */
  readResource(path: string): Promise<ZimResource | null>
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

async function readRange(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  if (length <= 0 || offset >= blob.size) return new Uint8Array(0)
  const end = Math.min(offset + length, blob.size)
  return new Uint8Array(await blob.slice(offset, end).arrayBuffer())
}

async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress zlib clusters')
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function parseCString(bytes: Uint8Array, start: number): { value: string; next: number } {
  let end = start
  while (end < bytes.length && bytes[end] !== 0) end += 1
  return {
    value: decodeUtf8(bytes.subarray(start, end)),
    next: Math.min(end + 1, bytes.length),
  }
}

/** ZIM URLs are relative to the archive root; normalise `.` and `..`. */
export function normalizeZimPath(path: string): string {
  const withoutQuery = path.split('#')[0].split('?')[0]
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // keep raw when the path has a stray percent sign
  }
  const parts: string[] = []
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

export async function openZim(file: Blob, fileName = 'archive.zim'): Promise<ZimArchive> {
  const header = await readRange(file, 0, HEADER_SIZE)
  if (header.length < HEADER_SIZE) throw new Error('That file is too small to be a ZIM archive.')
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (headerView.getUint32(0, true) !== MAGIC) {
    throw new Error('That file is not a ZIM archive.')
  }

  const majorVersion = headerView.getUint16(4, true)
  if (majorVersion < 5) {
    throw new Error(`ZIM version ${majorVersion} is too old to import.`)
  }

  const entryCount = headerView.getUint32(24, true)
  const clusterCount = headerView.getUint32(28, true)
  const urlPtrPos = Number(headerView.getBigUint64(32, true))
  const titlePtrPos = Number(headerView.getBigUint64(40, true))
  const clusterPtrPos = Number(headerView.getBigUint64(48, true))
  const mimeListPos = Number(headerView.getBigUint64(56, true))
  const checksumPos = Number(headerView.getBigUint64(72, true))

  if (!entryCount || !clusterCount) throw new Error('That ZIM archive is empty.')
  if (entryCount > MAX_LISTED_ENTRIES) {
    throw new Error(
      `This ZIM has ${entryCount.toLocaleString()} entries — too many to browse here. Use a mini/simple archive, or paste the article text instead.`,
    )
  }

  const urlPtrBytes = await readRange(file, urlPtrPos, entryCount * 8)
  const urlPtrView = new DataView(
    urlPtrBytes.buffer,
    urlPtrBytes.byteOffset,
    urlPtrBytes.byteLength,
  )
  const urlPointers = new Uint32Array(entryCount)
  let minPointer = Number.POSITIVE_INFINITY
  let maxPointer = 0
  for (let index = 0; index < entryCount; index += 1) {
    const pointer = Number(urlPtrView.getBigUint64(index * 8, true))
    urlPointers[index] = pointer
    if (pointer < minPointer) minPointer = pointer
    if (pointer > maxPointer) maxPointer = pointer
  }
  if (!Number.isFinite(minPointer) || maxPointer <= minPointer) {
    throw new Error('That ZIM archive has no directory.')
  }

  // Directory entries sit immediately before the pointer lists. Use the first
  // entry pointer as the start and the nearest following list as the end.
  const listStarts = [urlPtrPos, titlePtrPos, clusterPtrPos].filter(
    (position) =>
      position > maxPointer && position > 0 && position <= file.size,
  )
  const directoryStart = minPointer
  const directoryEnd = Math.min(...listStarts)
  const directoryLength = directoryEnd - directoryStart
  if (!Number.isFinite(directoryLength) || directoryLength <= 0) {
    throw new Error('That ZIM archive has no readable directory.')
  }
  if (directoryLength > MAX_DIRECTORY_BYTES) {
    throw new Error(
      'This ZIM archive is too large to browse in the browser. Use a mini/simple archive, or paste the article text instead.',
    )
  }

  const mimeBytes = await readRange(file, mimeListPos, 4096)
  const mimeTypes: string[] = []
  let mimeCursor = 0
  while (mimeCursor < mimeBytes.length && mimeBytes[mimeCursor] !== 0) {
    const parsed = parseCString(mimeBytes, mimeCursor)
    mimeTypes.push(parsed.value)
    mimeCursor = parsed.next
  }

  void urlPointers
  const directoryBytes = await readRange(file, directoryStart, directoryLength)
  const directoryView = new DataView(
    directoryBytes.buffer,
    directoryBytes.byteOffset,
    directoryBytes.byteLength,
  )

  const entries: ZimEntry[] = []
  let cursor = 0
  while (cursor < directoryBytes.length) {
    if (cursor + 8 > directoryBytes.length) break
    const mimeIndex = directoryView.getUint16(cursor, true)
    cursor += 2
    const parameterLength = directoryView.getUint8(cursor)
    cursor += 1
    const namespace = String.fromCharCode(directoryView.getUint8(cursor))
    cursor += 1
    cursor += 4 // revision

    let redirectIndex: number | null = null
    let clusterNumber = 0
    let blobNumber = 0
    if (mimeIndex === REDIRECT_MIME) {
      redirectIndex = directoryView.getUint32(cursor, true)
      cursor += 4
    } else {
      clusterNumber = directoryView.getUint32(cursor, true)
      cursor += 4
      blobNumber = directoryView.getUint32(cursor, true)
      cursor += 4
    }

    const url = parseCString(directoryBytes, cursor)
    cursor = url.next
    const title = parseCString(directoryBytes, cursor)
    cursor = title.next
    cursor += parameterLength
    if (cursor > directoryBytes.length) break

    const entry: ZimEntry = {
      index: entries.length,
      namespace,
      url: url.value,
      title: title.value || url.value,
      mimeType:
        mimeIndex === REDIRECT_MIME ? '' : (mimeTypes[mimeIndex] ?? 'application/octet-stream'),
      redirectIndex,
      clusterNumber,
      blobNumber,
    }
    entries.push(entry)
  }

  // v6.3 archives use a single `C` content namespace (articles, images and all
  // other resources). Older archives split articles into `A` and media into `I`.
  const articles = entries
    .filter(
      (entry) =>
        (entry.namespace === 'A' || entry.namespace === 'C') &&
        entry.redirectIndex === null &&
        !entry.url.startsWith('_assets_/') &&
        (entry.mimeType.startsWith('text/html') || entry.mimeType === 'text/plain'),
    )
    .map<ZimArticle>((entry) => ({
      index: entry.index,
      path: `${entry.namespace}/${entry.url}`,
      title: entry.title || entry.url,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))

  if (entries.length !== entryCount) {
    // Truncated directory is still usable for the entries that parsed.
    console.warn(`[zim] parsed ${entries.length} of ${entryCount} entries`)
  }

  const clusterCache = new Map<number, Uint8Array>()
  const pathIndex = new Map<string, ZimEntry>()
  for (const entry of entries) {
    if (entry.redirectIndex !== null) continue
    pathIndex.set(`${entry.namespace}/${entry.url}`, entry)
  }

  function resolveEntry(entry: ZimEntry, depth = 0): ZimEntry | null {
    if (entry.redirectIndex === null) return entry
    if (depth > 8) return null
    const target = entries[entry.redirectIndex]
    return target ? resolveEntry(target, depth + 1) : null
  }

  async function readCluster(clusterNumber: number): Promise<Uint8Array> {
    const cached = clusterCache.get(clusterNumber)
    if (cached) return cached
    if (clusterNumber >= clusterCount) throw new Error('ZIM cluster is out of range')

    const pointerOffset = clusterPtrPos + clusterNumber * 8
    const nextPointerOffset =
      clusterNumber + 1 < clusterCount ? pointerOffset + 8 : checksumPos
    const pointers = await readRange(file, pointerOffset, 16)
    if (pointers.length < 8) throw new Error('ZIM cluster pointer is missing')
    const view = new DataView(pointers.buffer, pointers.byteOffset, pointers.byteLength)
    const start = Number(view.getBigUint64(0, true))
    const end =
      nextPointerOffset === pointerOffset + 8 && pointers.length >= 16
        ? Number(view.getBigUint64(8, true))
        : checksumPos
    const length = end - start
    if (length <= 0 || length > MAX_CLUSTER_BYTES) {
      throw new Error('ZIM cluster is too large to read')
    }

    const raw = await readRange(file, start, length)
    if (!raw.length) throw new Error('ZIM cluster is empty')
    const compression = raw[0]
    let data: Uint8Array
    if (compression === 0 || compression === 1) {
      data = raw.subarray(1)
    } else if (compression === 2) {
      data = await inflateZlib(raw.subarray(1))
    } else if (compression === 5) {
      data = zstdDecompress(raw.subarray(1))
    } else {
      throw new Error(
        `This ZIM uses an unsupported compression (${compression}). Re-export it with zstd.`,
      )
    }
    clusterCache.set(clusterNumber, data)
    return data
  }

  async function readBlob(clusterNumber: number, blobNumber: number): Promise<Uint8Array> {
    const data = await readCluster(clusterNumber)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const firstOffset = view.getUint32(0, true)
    const blobCount = firstOffset / 4 - 1
    if (blobNumber >= blobCount) throw new Error('ZIM blob is out of range')
    const start = view.getUint32(blobNumber * 4, true)
    const end =
      blobNumber === blobCount - 1
        ? firstOffset
        : view.getUint32((blobNumber + 1) * 4, true)
    return data.subarray(start, end)
  }

  async function readResource(path: string): Promise<ZimResource | null> {
    const normalized = normalizeZimPath(path)
    const candidates = new Set<string>([normalized])
    const namespaceMatch = /^([A-Z])\/(.*)$/.exec(normalized)
    if (namespaceMatch) {
      const [, , rest] = namespaceMatch
      candidates.add(`C/${rest}`)
      candidates.add(`I/${rest}`)
    } else {
      candidates.add(`C/${normalized}`)
      candidates.add(`I/${normalized}`)
    }

    for (const candidate of candidates) {
      const entry = pathIndex.get(candidate)
      if (!entry) continue
      const resolved = resolveEntry(entry)
      if (!resolved) continue
      try {
        const data = await readBlob(resolved.clusterNumber, resolved.blobNumber)
        return { mimeType: resolved.mimeType, data }
      } catch {
        return null
      }
    }
    return null
  }

  return {
    fileName,
    entryCount,
    articleCount: articles.length,
    listArticles(query = '', limit = 40) {
      const q = query.trim().toLowerCase()
      if (!q) return articles.slice(0, limit)

      // Rank exact titles first, then prefix matches, then words in the title,
      // then archive paths. Plain alphabetical order buries "Climate change"
      // under dozens of "… Climate Change Conference" pages.
      const ranked: Array<{ article: ZimArticle; rank: number }> = []
      for (const article of articles) {
        const title = article.title.toLowerCase()
        let rank = -1
        if (title === q) rank = 0
        else if (title.startsWith(q)) rank = 1
        else if (title.includes(q)) rank = 2
        else if (article.path.toLowerCase().includes(q)) rank = 3
        if (rank >= 0) ranked.push({ article, rank })
      }
      ranked.sort(
        (a, b) => a.rank - b.rank || a.article.title.localeCompare(b.article.title),
      )
      return ranked.slice(0, limit).map((entry) => entry.article)
    },
    async readArticle(article: ZimArticle) {
      const entry = entries[article.index]
      const resolved = entry ? resolveEntry(entry) : null
      if (!resolved) throw new Error('That article is missing from the archive.')
      const data = await readBlob(resolved.clusterNumber, resolved.blobNumber)
      return decodeUtf8(data)
    },
    readResource,
  }
}
