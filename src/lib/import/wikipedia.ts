/**
 * MediaWiki → pcktwiki import.
 *
 * Wikipedia is the best-known MediaWiki, but the same markup powers wiki.gg and
 * Fandom. Input is chosen automatically:
 *  1. A wiki article URL — fetched through the MediaWiki action API (CORS with
 *     `origin=*`) and converted from the rendered HTML.
 *  2. Pasted HTML — a saved page or the result of "view source".
 *  3. Pasted wikitext — the markup from the edit view ("==" headings,
 *     [[links]], {{templates}}, [[File:…]]).
 *  4. Pasted plain text — the copy of a rendered page; headings are heuristic.
 *
 * Output is pcktwiki markdown: a `{{infobox …}}` fact box (the knowledge-graph
 * panel), `##` sections, `[[wikilinks]]` for internal article links, images,
 * and `[[Category:…]]` lines — so imported pages organize like native ones.
 */
import { slugifyHeading } from '@/lib/lichen/wikilinks'

export interface WikipediaImportResult {
  title: string
  markdown: string
  imageUrls: string[]
  warnings: string[]
  /** Site the page came from, when the input was a URL. */
  sourceName?: string
  sourceUrl?: string
}

export interface WikiImportSource {
  host: string
  origin: string
  apiBases: string[]
  title: string
  siteLabel: string
  articleUrl: string
}

export interface WikiHtmlConvertOptions {
  /** Site origin used to resolve `/wiki/` links and relative image paths. */
  origin?: string
  /** Extra warnings produced by a caller (ZIM media limits, etc.). */
  extraWarnings?: string[]
}

const ARTICLE_URL_RE =
  /^https?:\/\/([^/\s?#]+)\/(?:([a-z]{2,3}(?:-[a-z]+)?)\/)?wiki\/([^\s?#]+)/i
const INDEX_URL_RE =
  /^https?:\/\/([^/\s?#]+)\/(?:w\/)?index\.php\?(?:[^#]*&)?title=([^&#]+)/i

/** Section titles whose reference machinery makes no sense on another wiki. */
const DROP_SECTIONS = new Set([
  'references',
  'notes',
  'citations',
  'footnotes',
  'sources',
  'further reading',
  'bibliography',
  'explanatory notes',
  'works cited',
])

const SKIP_NAMESPACES = [
  'file:',
  'image:',
  'category:',
  'wikipedia:',
  'wp:',
  'help:',
  'special:',
  'template:',
  'template talk:',
  'portal:',
  'talk:',
  'user:',
  'wikt:',
  'wiktionary:',
  'commons:',
  'module:',
  'mediawiki:',
]

function siteLabelFor(host: string): string {
  if (/(^|\.)wikipedia\.org$/i.test(host)) return 'Wikipedia'
  if (/(^|\.)fandom\.com$/i.test(host)) return 'Fandom'
  if (/(^|\.)wiki\.gg$/i.test(host)) return 'wiki.gg'
  return host
}

function apiBasesFor(host: string, origin: string): string[] {
  if (/(^|\.)wikipedia\.org$/i.test(host)) return [`${origin}/w/api.php`]
  return [`${origin}/api.php`, `${origin}/w/api.php`]
}

/**
 * Parse a Wikipedia, Fandom, wiki.gg or any other MediaWiki article URL.
 * Returns the API endpoints to try and the bare page title.
 */
export function parseWikiUrl(text: string): WikiImportSource | null {
  const trimmed = text.trim()
  let host = ''
  let rawTitle = ''
  let articleUrl = ''

  const article = ARTICLE_URL_RE.exec(trimmed)
  if (article) {
    host = article[1].toLowerCase()
    rawTitle = article[3]
    articleUrl = trimmed.split('#')[0]
  } else {
    const index = INDEX_URL_RE.exec(trimmed)
    if (!index) return null
    host = index[1].toLowerCase()
    rawTitle = index[2]
    articleUrl = trimmed.split('#')[0]
  }

  let title = rawTitle
  try {
    title = decodeURIComponent(rawTitle)
  } catch {
    // keep raw on stray percent signs
  }
  title = title.replace(/_/g, ' ').trim()
  if (!title) return null

  const origin = `https://${host}`
  return {
    host,
    origin,
    apiBases: apiBasesFor(host, origin),
    title,
    siteLabel: siteLabelFor(host),
    articleUrl,
  }
}

/** Backwards-compatible Wikipedia-only parser. */
export function parseWikipediaUrl(text: string): { lang: string; title: string } | null {
  const source = parseWikiUrl(text)
  if (!source || !/(^|\.)wikipedia\.org$/i.test(source.host)) return null
  return {
    lang: source.host.split('.')[0].toLowerCase(),
    title: source.title,
  }
}

/** API category names use underscores and often include bookkeeping. */
function cleanCategoryName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

const MAINTENANCE_CATEGORY_RE = new RegExp(
  '^(?:' +
    [
      'CS1',
      'CS2',
      'Articles (?:with|containing|covered|needing|using|without)',
      'All articles',
      'Wikipedia',
      'Pages (?:using|with)',
      'Use (?:dmy|mdy|British|American|Oxford|Hong Kong|Indian|Australian|Canadian|Irish|New Zealand)',
      'Short description',
      'Engvar',
      'Featured articles',
      'Good articles',
      'Commons category',
      'Webarchive',
      'Official website',
      'Template:',
      'Module:',
      'Harv and Sfn',
      'Interlanguage link',
      'Language articles',
      'ISBN',
      'Articles containing',
    ].join('|') +
    ')',
  'i',
)

function isMaintenanceCategory(name: string): boolean {
  return MAINTENANCE_CATEGORY_RE.test(name)
}

/** Drop interwiki/maintenance buckets that mean nothing on another wiki. */
function filterCategories(categories: string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of categories) {
    const name = cleanCategoryName(raw)
    if (!name || name.includes(':') || isMaintenanceCategory(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(name)
  }
  return kept
}

interface ParseApiResponse {
  parse?: {
    title?: string
    text?: string
    categories?: Array<{ category?: string; '*': string; hidden?: boolean }>
  }
  error?: { info?: string }
}

async function fetchParsedPage(
  source: WikiImportSource,
): Promise<{ html: string; title: string; categories: string[] }> {
  let lastError: unknown = null

  for (const apiBase of source.apiBases) {
    const url =
      `${apiBase}?action=parse&format=json&formatversion=2` +
      `&origin=*&redirects=1&prop=text|displaytitle|categories&cllimit=max&clshow=!hidden&clprop=hidden` +
      `&page=${encodeURIComponent(source.title)}`
    try {
      const response = await fetch(url)
      if (!response.ok) {
        lastError = new Error(`${source.siteLabel} request failed (${response.status})`)
        continue
      }
      const data = (await response.json()) as ParseApiResponse
      if (data.error || !data.parse?.text) {
        throw new Error(data.error?.info ?? `${source.siteLabel} could not find that page`)
      }
      // Hidden categories are Wikipedia bookkeeping (CS1 maintenance, date
      // formats, protection flags); they mean nothing on another wiki.
      const categories = filterCategories(
        (data.parse.categories ?? [])
          .filter((c) => !c.hidden)
          .map((c) => c.category ?? c['*'])
          .filter((c): c is string => !!c),
      )
      return {
        html: data.parse.text,
        title: data.parse.title ?? source.title,
        categories,
      }
    } catch (error) {
      lastError = error
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'Unknown error'
  throw new Error(
    `${detail}. ${source.siteLabel} may block cross-origin requests — paste the page text or HTML instead.`,
  )
}

/* ---------------------------------- HTML ---------------------------------- */

const STRIP_SELECTORS = [
  'script',
  'style',
  '.mw-editsection',
  '.fandom-community-header',
  '.global-navigation',
  '.global-footer',
  '.page-side-tools',
  '.page-footer',
  '.wds-tabber',
  '#mixed-content-footer',
  '.notifications-placeholder',
  '.ad-slot',
  '[class*="ad-slot"]',
  '.render-featured-video',
  '.interlanguage-link',
  '.navbox-styles',
  '.zim-footer',
  '#catlinks',
  '.catlinks',
  'sup.reference',
  'sup.noprint',
  'span.mw-cite-backlink',
  '.mw-references-wrap',
  'ol.references',
  '.reflist',
  '.refbegin',
  '.navbox',
  '.metadata',
  '.mw-jump-link',
  '.ambox',
  '.hatnote',
  '.side-box',
  '.mbox-small',
  '.portal-bar',
  '.sistersitebox',
  '.mw-indicators',
  '.printfooter',
  '.noprint',
  '.mw-empty-elt',
  '#toc',
  'table.sidebar',
  'table.vertical-navbox',
]

function cleanText(el: Element): string {
  return (el.textContent ?? '').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim()
}

function absolutize(url: string, origin?: string): string {
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('/') && origin) return `${origin}${trimmed}`
  return trimmed
}

/**
 * Accept any real image URL from the source wiki (Wikimedia upload/thumb,
 * Fandom's static.wikia CDN, wiki.gg's static host, or a ZIM data URL). Strip
 * tracking params and drop interface chrome such as site logos and icons.
 */
function cleanWikiImage(url: string, origin?: string): string | null {
  const absolute = absolutize(url, origin)
  if (/^data:image\//i.test(absolute)) return absolute
  if (!/^https?:\/\//i.test(absolute)) return null
  if (/\/(skins|resources|extensions|load\.php|static\/images|wiki\.png)/i.test(absolute)) {
    return null
  }
  try {
    const parsed = new URL(absolute)
    Array.from(parsed.searchParams.keys()).forEach((key) => {
      if (key.startsWith('utm_')) parsed.searchParams.delete(key)
    })
    return parsed.toString()
  } catch {
    return absolute
  }
}

/**
 * Turn a same-site `href` into a page title. Covers `/wiki/Title`, absolute
 * `https://host/wiki/Title`, and `/index.php?title=Title` — the link shapes
 * Wikipedia, Fandom and wiki.gg all emit.
 */
function internalWikiTitle(href: string, origin?: string): string | null {
  if (!href || href.startsWith('#')) return null
  try {
    const base = origin ?? 'https://placeholder.invalid'
    const url = new URL(href, base)
    if (origin && url.origin !== origin) return null
    const wikiMatch = /^\/wiki\/(.+)$/.exec(url.pathname)
    if (wikiMatch) {
      return decodeURIComponent(wikiMatch[1]).split('#')[0].replace(/_/g, ' ').trim()
    }
    const titleParam = url.searchParams.get('title')
    if (titleParam && /(?:^|\/)index\.php$/.test(url.pathname)) {
      return titleParam.replace(/_/g, ' ').trim()
    }
  } catch {
    return null
  }
  return null
}

/** Category names linked in the article footer (Fandom and Wikipedia shapes). */
function extractHtmlCategories(doc: Document): string[] {
  const selector =
    '#catlinks .mw-normal-catlinks a, .catlinks a, .page-header__categories a, .article-categories a, [data-tracking-label="categories"] a'
  const names = new Set<string>()
  doc.querySelectorAll(selector).forEach((anchor) => {
    const text = cleanText(anchor)
    if (!text || text.toLowerCase() === 'categories') return
    if (text.includes(':')) return
    names.add(text)
  })
  return [...names]
}

interface HtmlConvertCtx {
  imageUrls: string[]
  warnings: string[]
  origin?: string
}

function isDropHeading(el: Element): boolean {
  return DROP_SECTIONS.has(cleanText(el).toLowerCase())
}

function collectImage(el: Element, ctx: HtmlConvertCtx): string | null {
  const img = el.matches('img') ? el : el.querySelector('img')
  const src = img?.getAttribute('src')
  if (!src) return null
  const url = cleanWikiImage(src, ctx.origin)
  if (!url) return null
  if (!ctx.imageUrls.includes(url) && ctx.imageUrls.length < 24) {
    ctx.imageUrls.push(url)
  }
  return url
}

function convertInline(node: Node, ctx?: HtmlConvertCtx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\s+/g, ' ')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const inner = Array.from(el.childNodes)
    .map((child) => convertInline(child, ctx))
    .join('')
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'img': {
      const src = el.getAttribute('src')
      if (src && ctx) {
        const url = cleanWikiImage(src, ctx.origin)
        if (url) {
          if (!ctx.imageUrls.includes(url) && ctx.imageUrls.length < 24) ctx.imageUrls.push(url)
          const alt = el.getAttribute('alt') ?? ''
          return ` ![${alt.replace(/[|\[\]]/g, '')}](${url}) `
        }
      }
      return ''
    }
    case 'b':
    case 'strong':
      return inner.trim() ? `**${inner.trim()}**` : ''
    case 'i':
    case 'em':
      return inner.trim() ? `*${inner.trim()}*` : ''
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      const target = internalWikiTitle(href, ctx?.origin)
      if (target) {
        const lower = target.toLowerCase()
        if (!target || SKIP_NAMESPACES.some((ns) => lower.startsWith(ns))) return inner
        const label = cleanText(el)
        const slug = slugifyHeading(target)
        if (!slug) return inner
        if (slugifyHeading(label) === slug || !label) return `[[${slug}]]`
        return `[[${slug}|${label}]]`
      }
      if (/^https?:\/\//i.test(href)) {
        const label = cleanText(el)
        return label ? `[${label}](${href})` : href
      }
      return inner
    }
    case 'sup':
    case 'sub':
    case 'small':
      return inner
    case 'br':
      return ' '
    case 'span':
    default:
      return inner
  }
}

function convertList(el: Element, ordered: boolean, depth = 0): string {
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let index = 1
  for (const li of Array.from(el.children).filter((c) => c.tagName === 'LI')) {
    const marker = ordered ? `${index}. ` : '- '
    const nested = Array.from(li.children)
      .filter((c) => c.tagName === 'UL' || c.tagName === 'OL')
      .map((c) => convertList(c, c.tagName === 'OL', depth + 1))
      .join('\n')
    const clone = li.cloneNode(true) as Element
    clone.querySelectorAll('ul, ol').forEach((n) => n.remove())
    const text = convertChildren(clone).trim()
    if (text) lines.push(`${indent}${marker}${text}`)
    if (nested) lines.push(nested)
    index += 1
  }
  return lines.join('\n')
}

function convertChildren(el: Element, ctx?: HtmlConvertCtx): string {
  return Array.from(el.childNodes)
    .map((node) => convertInline(node, ctx))
    .join('')
}

function convertTable(el: Element, ctx: HtmlConvertCtx): string {
  const cls = el.className ?? ''
  if (/infobox|navbox|sidebar|metadata|toccolours|vertical-navbox/i.test(cls)) return ''
  const rows = Array.from(el.querySelectorAll('tr'))
  if (!rows.length) return ''
  const cellsOf = (tr: Element) =>
    Array.from(tr.querySelectorAll('th,td')).map((td) => convertChildren(td).trim())
  const header = cellsOf(rows[0])
  if (header.length < 2 || header.length > 6) {
    ctx.warnings.push('A table was skipped (too complex for markdown).')
    return ''
  }
  const body = rows
    .slice(1, 16)
    .map(cellsOf)
    .filter((cells) => cells.length === header.length)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((cells) => `| ${cells.join(' | ')} |`),
  ]
  return lines.join('\n')
}

function convertBlock(el: Element, ctx: HtmlConvertCtx, headingLevel: number): string {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      if (isDropHeading(el)) return ''
      const level = Math.max(2, headingLevel + (Number(tag[1]) - 2))
      return `${'#'.repeat(level)} ${cleanText(el)}`
    }
    case 'p': {
      const text = convertChildren(el, ctx).trim()
      return text || ''
    }
    case 'ul':
      return convertList(el, false)
    case 'ol':
      return convertList(el, true)
    case 'blockquote': {
      const text = convertChildren(el, ctx).trim()
      return text
        ? text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : ''
    }
    case 'table':
      return convertTable(el, ctx)
    case 'figure':
    case 'figcaption':
    case 'div': {
      // Thumb boxes and figures become standalone images with captions. The
      // typeof check is on the element itself — big containers that merely
      // contain figures must recurse, not collapse into one image.
      const img = el.querySelector('img')
      const isFileNode = (el.getAttribute('typeof') ?? '').includes('mw:File')
      if (img && (isFileNode || el.classList.contains('thumb') || el.classList.contains('mw-file') || tag === 'figure')) {
        const url = collectImage(el, ctx)
        if (url) {
          const captionEl = el.querySelector('figcaption, .thumbcaption')
          const caption = captionEl ? cleanText(captionEl).replace(/\s+/g, ' ') : ''
          return `![${caption}](${url})`
        }
      }
      if (tag === 'div') {
        return Array.from(el.children)
          .map((child) => convertBlock(child, ctx, headingLevel))
          .filter(Boolean)
          .join('\n\n')
      }
      return ''
    }
    case 'dl': {
      const lines: string[] = []
      for (const child of Array.from(el.children)) {
        if (child.tagName === 'DT') {
          const text = cleanText(child)
          if (text) lines.push(`**${text}**`)
        } else if (child.tagName === 'DD') {
          const text = convertChildren(child, ctx).trim()
          if (text) lines.push(text)
        }
      }
      return lines.join('\n\n')
    }
    case 'hr':
      return '---'
    default: {
      // Unknown containers: recurse so content inside is not lost.
      if (el.children.length) {
        return Array.from(el.children)
          .map((child) => convertBlock(child, ctx, headingLevel))
          .filter(Boolean)
          .join('\n\n')
      }
      return convertChildren(el).trim()
    }
  }
}

function infoboxImage(box: Element, ctx: HtmlConvertCtx, parts: string[]): void {
  const img = box.querySelector('figure.pi-image img, .pi-image img, img')
  const src = img?.getAttribute('src')
  if (!src) return
  const url = cleanWikiImage(src, ctx.origin)
  if (!url) return
  parts.push(`image=${url}`)
  if (!ctx.imageUrls.includes(url)) ctx.imageUrls.push(url)
  const caption = box.querySelector('.pi-caption, .infobox-caption, figcaption')
  if (caption) parts.push(`caption=${cleanText(caption)}`)
}

function extractStandardInfobox(
  box: Element,
  ctx: HtmlConvertCtx,
): { infobox: string; title: string } {
  const parts: string[] = []
  let title = ''
  const titleEl = box.querySelector('caption, .infobox-title')
  if (titleEl) {
    title = cleanText(titleEl)
    parts.push(`title=${title}`)
  }
  infoboxImage(box, ctx, parts)
  for (const tr of Array.from(box.querySelectorAll('tr'))) {
    const th = tr.querySelector('th')
    const td = tr.querySelector('td')
    if (!th || !td) continue
    if (th.className.includes('infobox-title') || th.className.includes('infobox-header')) continue
    const key = cleanText(th).replace(/[|{}=]/g, '').toLowerCase()
    const value = cleanText(td).replace(/[|{}]/g, '').slice(0, 160)
    if (key && value) parts.push(`${key}=${value}`)
  }
  if (parts.length < 2) return { infobox: '', title }
  return { infobox: `{{infobox ${parts.join(' | ')}}}`, title }
}

/** Fandom's portable infobox markup (`aside.portable-infobox`). */
function extractPortableInfobox(
  box: Element,
  ctx: HtmlConvertCtx,
): { infobox: string; title: string } {
  const parts: string[] = []
  let title = ''
  const titleEl = box.querySelector('.pi-title, .pi-header')
  if (titleEl) {
    title = cleanText(titleEl)
    parts.push(`title=${title}`)
  }
  infoboxImage(box, ctx, parts)
  for (const item of Array.from(box.querySelectorAll('.pi-data'))) {
    const labelEl = item.querySelector('.pi-data-label') ?? item.querySelector('h3')
    const valueEl = item.querySelector('.pi-data-value') ?? item.querySelector('.pi-data-value *')
    const key = cleanText(labelEl ?? item).replace(/[|{}=]/g, '').toLowerCase()
    const value = cleanText(valueEl ?? item).replace(/[|{}]/g, '').slice(0, 160)
    if (key && value) parts.push(`${key}=${value}`)
  }
  if (parts.length < 2) return { infobox: '', title }
  return { infobox: `{{infobox ${parts.join(' | ')}}}`, title }
}

function extractInfobox(doc: Document, ctx: HtmlConvertCtx): { infobox: string; title: string } {
  const standard = doc.querySelector('table.infobox')
  if (standard) {
    const result = extractStandardInfobox(standard, ctx)
    if (result.infobox) return result
  }
  const portable = doc.querySelector('aside.portable-infobox, .portable-infobox')
  if (portable) return extractPortableInfobox(portable, ctx)
  return { infobox: '', title: '' }
}

export function convertWikipediaHtml(
  html: string,
  fallbackTitle: string,
  categories: string[] = [],
  options: WikiHtmlConvertOptions = {},
): WikipediaImportResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  // A saved page may carry its own `<base>` or canonical URL; use it to turn
  // relative links and images into real ones.
  const docOrigin =
    options.origin ??
    doc.querySelector('base[href]')?.getAttribute('href')?.replace(/\/$/, '') ??
    undefined
  const ctx: HtmlConvertCtx = {
    imageUrls: [],
    warnings: [...(options.extraWarnings ?? [])],
    origin: docOrigin,
  }

  const htmlCategories = filterCategories(
    categories.length ? categories : extractHtmlCategories(doc),
  )
  // Strip before the infobox pass so TemplateStyles CSS never leaks into values.
  STRIP_SELECTORS.forEach((sel) => doc.querySelectorAll(sel).forEach((el) => el.remove()))
  const { infobox, title: infoboxTitle } = extractInfobox(doc, ctx)
  doc
    .querySelectorAll('table.infobox, aside.portable-infobox, .portable-infobox')
    .forEach((el) => el.remove())

  // Fandom keeps the article body outside `<body>` only in unusual skins; keep
  // the walk defensive so an empty body still finds the content root.
  const root = doc.body?.children.length
    ? doc.body
    : (doc.querySelector('.mw-parser-output, #mw-content-text') ?? doc.body)

  const title = infoboxTitle || fallbackTitle
  const blocks: string[] = []
  if (infobox) blocks.push(infobox)

  // Top-level walk; nested headings shift the level accordingly.
  for (const el of Array.from(root?.children ?? [])) {
    const md = convertBlock(el, ctx, 2)
    if (md.trim()) blocks.push(md.trim())
  }

  const imageLines = ctx.imageUrls.slice(0, 24)
  const categoryLines = htmlCategories.slice(0, 12).map((c) => `[[Category:${c}]]`)
  if (htmlCategories.length > 12) {
    ctx.warnings.push(`${htmlCategories.length - 12} categories were dropped.`)
  }

  const markdown = [blocks.join('\n\n'), '', categoryLines.join(' ')]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (markdown.length > 50_000) {
    ctx.warnings.push(
      `This page is very long (${markdown.length.toLocaleString()} characters). Consider importing one section, or trim it before publishing.`,
    )
  }

  return {
    title,
    markdown,
    imageUrls: imageLines,
    warnings: ctx.warnings,
  }
}

/* -------------------------------- Wikitext -------------------------------- */

function stripWikitextRefs(text: string): string {
  return text
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

function readBalancedTemplate(src: string, start: number): { body: string; end: number } | null {
  let depth = 0
  for (let i = start; i < src.length - 1; i += 1) {
    if (src[i] === '{' && src[i + 1] === '{') {
      depth += 1
      i += 1
    } else if (src[i] === '}' && src[i + 1] === '}') {
      depth -= 1
      i += 1
      if (depth === 0) return { body: src.slice(start + 2, i - 1), end: i + 1 }
    }
  }
  return null
}

function templateToInfobox(body: string): string | null {
  const nameMatch = /^[^|]*/.exec(body)
  const name = (nameMatch?.[0] ?? '').trim().toLowerCase()
  if (!name.startsWith('infobox')) return null
  const parts: string[] = []
  const afterName = body.slice(nameMatch ? nameMatch[0].length : 0)
  for (const chunk of afterName.split('|')) {
    const eq = chunk.indexOf('=')
    if (eq === -1) continue
    const key = chunk.slice(0, eq).trim().replace(/[|{}]/g, '').toLowerCase()
    const value = chunk.slice(eq + 1).trim().replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').replace(/[|{}*]/g, '')
    if (key && value) parts.push(`${key}=${value.slice(0, 160)}`)
  }
  return parts.length ? `{{infobox ${parts.join(' | ')}}}` : null
}

function wikilinkToWiki(inner: string): string {
  const [rawTarget, ...rest] = inner.split('|')
  const target = rawTarget.trim()
  const lower = target.toLowerCase()
  if (SKIP_NAMESPACES.some((ns) => lower.startsWith(ns))) {
    return rest.length ? rest.join('|').trim() : ''
  }
  const label = rest.join('|').trim()
  const slug = slugifyHeading(target.replace(/_/g, ' '))
  if (!slug) return label
  return label ? `[[${slug}|${label}]]` : `[[${slug}]]`
}

export function convertWikitext(
  src: string,
  options: { origin?: string } = {},
): WikipediaImportResult {
  const fileOrigin = options.origin ?? 'https://en.wikipedia.org'
  const warnings: string[] = []
  const imageUrls: string[] = []
  let text = stripWikitextRefs(src)

  // Balanced-template pass: infobox kept, everything else dropped.
  let out = ''
  let cursor = 0
  for (;;) {
    const open = text.indexOf('{{', cursor)
    if (open === -1) {
      out += text.slice(cursor)
      break
    }
    const tpl = readBalancedTemplate(text, open)
    if (!tpl) {
      out += text.slice(cursor)
      break
    }
    out += text.slice(cursor, open)
    const infobox = templateToInfobox(tpl.body)
    if (infobox) out += `\n\n${infobox}\n\n`
    cursor = tpl.end
  }
  text = out

  const categories: string[] = []
  const lines = text.split('\n')
  const md: string[] = []
  let listBuffer: string[] = []
  let skipping: string | null = null

  const flushList = () => {
    if (listBuffer.length) {
      md.push(listBuffer.join('\n'))
      listBuffer = []
    }
  }

  for (const rawLine of lines) {
    let line = rawLine
    const cat = /\[\[[Cc]ategory:([^\]]+)\]\]/.exec(line)
    if (cat) {
      categories.push(cat[1].split('|')[0].trim())
      line = line.replace(/\[\[[Cc]ategory:[^\]]+\]\]/g, '')
      if (!line.trim()) continue
    }
    line = line
      .replace(/\[\[(?:[Ff]ile|[Ii]mage):([^\]]+)\]\]/g, (_all, rest: string) => {
        const segs = rest.split('|')
        const file = segs[0].trim()
        const caption = (segs[segs.length - 1] ?? '').replace(/^thumb\s*/i, '').replace(/[|]/g, '').trim()
        const url = `${fileOrigin}/wiki/Special:FilePath/${encodeURIComponent(file)}?width=800`
        if (imageUrls.length < 24) imageUrls.push(url)
        return `\n\n![${caption}](${url})\n\n`
      })
      .replace(/\[\[([^\]]+)\]\]/g, (_all, inner: string) => wikilinkToWiki(inner))
      .replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/g, (_all, href: string, label?: string) =>
        label ? `[${label}](${href})` : href,
      )
      .replace(/'''([^']+?)'''/g, '**$1**')
      .replace(/''([^']+?)''/g, '*$1*')

    const heading = /^\s*(={2,6})\s*(.+?)\s*\1\s*$/.exec(line)
    if (heading) {
      flushList()
      const level = heading[1].length
      const title = heading[2].trim()
      if (DROP_SECTIONS.has(title.toLowerCase())) {
        // Skip the rest of this section: it is dropped until the next heading.
        skipping = title.toLowerCase()
        continue
      }
      skipping = null
      md.push(`${'#'.repeat(level + 1)} ${title}`)
      continue
    }
    if (skipping) continue

    const bullet = /^\s*([*#]+)\s*(.*)$/.exec(line)
    if (bullet && bullet[2]) {
      const depth = bullet[1].length - 1
      const marker = bullet[1].endsWith('#') ? '1. ' : '- '
      listBuffer.push(`${'  '.repeat(depth)}${marker}${bullet[2].trim()}`)
      continue
    }
    flushList()
    if (/^----+\s*$/.test(line)) {
      md.push('---')
    } else if (line.trim()) {
      md.push(line.trim())
    }
  }
  flushList()

  let markdown = md
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (categories.length) {
    markdown += `\n\n${categories.slice(0, 12).map((c) => `[[Category:${c}]]`).join(' ')}`
  }

  const title =
    (/^\s*'''(.+?)'''/m.exec(markdown)?.[1] ?? '').trim() ||
    (/^##?\s+(.+)$/m.exec(markdown)?.[1] ?? '').trim() ||
    'Imported page'

  return { title, markdown, imageUrls, warnings }
}

/* ------------------------------- Plain text ------------------------------- */

function looksLikeHeading(line: string, next: string): boolean {
  if (!line || line.length > 90) return false
  if (/[.!?;,]$/.test(line)) return false
  if (!next.trim()) return false
  const words = line.split(/\s+/)
  if (words.length > 14) return false
  const capitalized = words.filter((w) => /^[A-Z(]/.test(w)).length
  return capitalized / words.length >= 0.6
}

export function convertPlainText(src: string): WikipediaImportResult {
  const warnings = [
    'Converted from plain text — section headings were detected heuristically. Check the ## breaks.',
  ]
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  let imageCount = 0

  const flush = () => {
    if (paragraph.length) {
      blocks.push(paragraph.join(' ').trim())
      paragraph = []
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    const next = lines[i + 1] ?? ''
    if (!line) {
      flush()
      continue
    }
    if (/^(https?:\/\/\S+)$/i.test(line)) continue
    const img = /^!\[([^\]]*)\]\((https?:\/\/[^)]+)\)$/.exec(line)
    if (img) {
      flush()
      blocks.push(`![${img[1]}](${img[2]})`)
      imageCount += 1
      continue
    }
    if (looksLikeHeading(line, next)) {
      flush()
      blocks.push(`## ${line}`)
      continue
    }
    if (/^[•*]\s+/.test(line)) {
      flush()
      blocks.push(`- ${line.replace(/^[•*]\s+/, '')}`)
      continue
    }
    paragraph.push(line)
  }
  flush()

  const markdown = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  const title = (blocks.find((b) => !b.startsWith('#')) ?? 'Imported page')
    .split(/[.!?]/)[0]
    .slice(0, 80)
  return { title, markdown, imageUrls: [], warnings }
}

/* ------------------------------- Orchestrator ------------------------------ */

export function looksLikeHtml(input: string): boolean {
  return /<(?:!doctype\s+html|html|body|div|p|table|h[1-6]|mw-parser-output)\b/i.test(input)
}

/** Convert a saved/copied HTML page (Fandom, wiki.gg, or Wikipedia). */
export function convertHtmlText(
  html: string,
  fallbackTitle = 'Imported page',
  options: WikiHtmlConvertOptions = {},
): WikipediaImportResult {
  return convertWikipediaHtml(html, fallbackTitle, [], options)
}

export async function convertWikipediaInput(
  raw: string,
  options: { origin?: string; fallbackTitle?: string } = {},
): Promise<WikipediaImportResult> {
  const input = raw.trim()
  const urlInfo = parseWikiUrl(input)
  if (urlInfo) {
    const { html, title, categories } = await fetchParsedPage(urlInfo)
    const result = convertWikipediaHtml(html, title, categories, { origin: urlInfo.origin })
    return {
      ...result,
      sourceName: urlInfo.siteLabel,
      sourceUrl: urlInfo.articleUrl,
    }
  }
  if (looksLikeHtml(input)) {
    return convertHtmlText(input, options.fallbackTitle, { origin: options.origin })
  }
  if (/(^|\n)\s*={2,}|\{\{|%\|[^\n]+=|\[\[[^\]]+\]\]/.test(input)) {
    return convertWikitext(input, { origin: options.origin })
  }
  return convertPlainText(input)
}
