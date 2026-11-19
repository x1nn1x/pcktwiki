import MarkdownIt from 'markdown-it'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type Token from 'markdown-it/lib/token.mjs'
import DOMPurify from 'dompurify'
import { resolveBlobSrcSync, getSessionBlobPreview } from '@/lib/atproto/blobs'
import { cropAspectRatio, parseImageTitle } from '@/lib/editor/image-align'
import { responsiveImage } from '@/lib/media/responsive-image'
import {
  parseWikilinkTarget,
  wikilinkHref,
  slugifyHeading,
  type WikilinkTarget,
} from '@/lib/lichen/wikilinks'
import { stripFrontmatter } from '@/lib/lichen/frontmatter'
import { CATEGORY_PREFIX } from '@/lib/lichen/content-meta'
import { expandEmbeds } from '@/lib/lichen/transclusion'
import { buildYouTubeEmbedHtml } from '@/lib/youtube'
import { sectionPlugin } from '@/lib/markdown-sections'
import type { LichenNoteWithContent } from '@/types/lichen'
import { routeHref } from '@/lib/base-url'

export interface MarkdownRenderEnv {
  wikiSlug?: string
  ownerHandle?: string
  /** Wiki owner DID — used to rewrite `blob:cid` image srcs to getBlob URLs. */
  ownerDid?: string
  /**
   * Slugs that exist in the current wiki. When supplied, links to pages outside
   * this set are marked `wikilink-missing` so the editor can flag them.
   */
  existingSlugs?: Set<string>
  /** Notes used to expand {{embed:slug}} shortcodes. */
  wikiNotes?: LichenNoteWithContent[]
  /**
   * Override wikilink / category href generation (e.g. relative `.html` links
   * for a static site export).
   */
  resolveHref?: (target: WikilinkTarget | { kind: 'category'; name: string; slug: string }) => string | null
  /**
   * Base heading-slug counts from an earlier chunk of the same article, so a
   * second render continues the same id dedupe sequence (`heading`,
   * `heading-2`, …) instead of restarting it.
   */
  headingIdCounts?: Map<string, number>
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

// `:::hero` / `:::grid` / … page-layout containers.
md.use(sectionPlugin)

const defaultImageRender =
  md.renderer.rules.image ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src')
  const ownerDid = (env as MarkdownRenderEnv).ownerDid
  const titleMeta = parseImageTitle(token.attrGet('title'))
  const alt = imageAlt(token)

  function rewrite(url: string): string {
    const preview = getSessionBlobPreview(url)
    if (preview) return preview
    if (ownerDid) {
      const rewritten = resolveBlobSrcSync(url, ownerDid)
      if (rewritten) return rewritten
    }
    return url
  }

  if (!src) return defaultImageRender(tokens, idx, options, env, self)

  // Always use the full blob in article bodies. Compact `thumb:` blobs are
  // reserved for LQIP placeholders and small UI (search, media grid).
  const fullSrc = rewrite(src)
  const responsive = responsiveImage(fullSrc)
  const thumbSrc = titleMeta.thumbUrl ? rewrite(titleMeta.thumbUrl) : null
  const hasDims = !!(titleMeta.width && titleMeta.height)
  const alignClass = titleMeta.align ? ` md-img--${titleMeta.align}` : ''
  const sizeClass = titleMeta.size && titleMeta.size !== 'full' ? ` md-img-size--${titleMeta.size}` : ''
  const cropClass = titleMeta.crop ? ` md-img-crop--${titleMeta.crop}` : ''
  const masonryClass = titleMeta.masonry ? ' md-img--masonry' : ''
  const gapClass =
    titleMeta.masonry && titleMeta.gap && titleMeta.gap !== 'md'
      ? ` md-img-gap--${titleMeta.gap}`
      : ''
  const forcedCropAspect = cropAspectRatio(titleMeta.crop)
  // Cover crops need a frame even without intrinsic dims so object-fit can clip.
  const needsFrame = hasDims || !!forcedCropAspect

  if (!titleMeta.isCaption) {
    const titleIdx = token.attrIndex('title')
    if (titleIdx >= 0 && token.attrs) token.attrs.splice(titleIdx, 1)
  }

  // Progressive frame: reserve aspect ratio, show blurred thumb, fade in full.
  if (needsFrame) {
    const w = titleMeta.width
    const h = titleMeta.height
    const aspectStyle = forcedCropAspect
      ? `aspect-ratio:${forcedCropAspect}`
      : w && h
        ? `aspect-ratio:${w}/${h}`
        : ''
    const lqip =
      thumbSrc && thumbSrc !== fullSrc
        ? `<img class="md-img-lqip" src="${escapeHtml(thumbSrc)}" alt="" aria-hidden="true" decoding="async" />`
        : ''
    const dimAttrs = w && h ? `width="${w}" height="${h}" ` : ''
    const srcSetAttrs = responsive.srcSet
      ? `srcset="${escapeHtml(responsive.srcSet)}" sizes="${escapeHtml(responsive.sizes ?? '')}" `
      : ''
    return (
      `<span class="md-img-frame${alignClass}${sizeClass}${cropClass}${masonryClass}${gapClass}"${aspectStyle ? ` style="${aspectStyle}"` : ''}>` +
      lqip +
      `<img class="md-img-full" src="${escapeHtml(responsive.src)}" ${srcSetAttrs}alt="${escapeHtml(alt)}" ` +
      `${dimAttrs}loading="lazy" decoding="async" />` +
      `</span>`
    )
  }

  token.attrSet('src', responsive.src)
  if (responsive.srcSet) {
    token.attrSet('srcset', responsive.srcSet)
    token.attrSet('sizes', responsive.sizes ?? '')
  }
  if (titleMeta.align || titleMeta.size || titleMeta.crop || titleMeta.masonry) {
    const existing = token.attrGet('class')
    token.attrSet(
      'class',
      [
        existing,
        'md-img',
        titleMeta.align ? `md-img--${titleMeta.align}` : null,
        titleMeta.size && titleMeta.size !== 'full' ? `md-img-size--${titleMeta.size}` : null,
        titleMeta.crop ? `md-img-crop--${titleMeta.crop}` : null,
        titleMeta.masonry ? 'md-img--masonry' : null,
        titleMeta.masonry && titleMeta.gap && titleMeta.gap !== 'md'
          ? `md-img-gap--${titleMeta.gap}`
          : null,
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  token.attrSet('loading', 'lazy')
  token.attrSet('decoding', 'async')
  token.attrSet('class', [token.attrGet('class'), 'md-img-solo'].filter(Boolean).join(' '))

  return defaultImageRender(tokens, idx, options, env, self)
}

function imageAlt(token: Token): string {
  if (token.children?.length) {
    return token.children.reduce((text, child) => text + (child.content || ''), '')
  }
  return token.attrGet('alt') || ''
}

const headingIds = new Map<string, number>()

md.core.ruler.push('heading_ids', (state) => {
  headingIds.clear()
  // When rendering the continuation chunk of a split article, seed the counts
  // from the earlier chunk so shared heading titles keep unique, stable ids.
  const seed = (state.env as MarkdownRenderEnv | undefined)?.headingIdCounts
  if (seed) {
    for (const [baseId, count] of seed) headingIds.set(baseId, count)
  }
  const tokens = state.tokens

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== 'heading_open') continue

    const inline = tokens[i + 1]
    if (!inline || inline.type !== 'inline') continue

    const text = inline.content
    const baseId = slugifyHeading(text)
    let id = baseId
    let counter = headingIds.get(baseId) ?? 0
    if (counter > 0) {
      id = `${baseId}-${counter + 1}`
    }
    headingIds.set(baseId, counter + 1)

    token.attrSet('id', id)
  }
})

md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
  const src = state.src
  const pos = state.pos

  if (src[pos] !== '[' || src[pos + 1] !== '[') return false

  const closeIdx = src.indexOf(']]', pos + 2)
  if (closeIdx === -1) return false

  if (!silent) {
    const env = state.env as MarkdownRenderEnv
    const inner = src.slice(pos + 2, closeIdx)
    const target = parseWikilinkTarget(inner, env.wikiSlug, env.ownerHandle)

    if (inner.trim().startsWith(CATEGORY_PREFIX)) {
      const categoryName = inner.trim().slice(CATEGORY_PREFIX.length).split('|')[0].trim()
      const categorySlug = slugifyHeading(categoryName)
      const href =
        env.resolveHref?.({ kind: 'category', name: categoryName, slug: categorySlug }) ??
        (env.ownerHandle && env.wikiSlug
          ? routeHref(
              `/@${encodeURIComponent(env.ownerHandle)}/${encodeURIComponent(env.wikiSlug)}/category/${encodeURIComponent(categorySlug)}`,
            )
          : null)
      if (href) {
        const token = state.push('html_inline', '', 0)
        token.content = `<a href="${escapeHtml(href)}" class="category-link">${escapeHtml(categoryName)}</a>`
      }
    } else if (target && (env.resolveHref || (env.ownerHandle && env.wikiSlug))) {
      const href = env.resolveHref
        ? env.resolveHref(target)
        : wikilinkHref(target, env.ownerHandle!, env.wikiSlug!)
      if (!href) return false
      const isLocal = !target.ownerHandle || target.ownerHandle === env.ownerHandle
      const missing =
        env.existingSlugs && isLocal && target.noteSlug && !env.existingSlugs.has(target.noteSlug)
      const className = missing ? 'wikilink wikilink-missing' : 'wikilink'
      const token = state.push('html_inline', '', 0)
      token.content = `<a href="${escapeHtml(href)}" class="${className}">${escapeHtml(target.label)}</a>`
    } else {
      return false
    }
  }

  state.pos = closeIdx + 2
  return true
})

// `{{youtube ID}}` or `{{youtube <url>}}` → privacy-friendly iframe. Pushed as
// an html_inline token so the markup survives `html:false` (the default `text`
// rule escapes raw HTML); DOMPurify then sanitizes the final string.
md.inline.ruler.before('link', 'youtube', (state: StateInline, silent: boolean) => {
  const src = state.src
  const pos = state.pos

  if (src[pos] !== '{' || src[pos + 1] !== '{') return false
  if (!/^\{\{youtube\b/i.test(src.slice(pos, pos + 11))) return false

  const closeIdx = src.indexOf('}}', pos + 2)
  if (closeIdx === -1) return false

  const inner = src.slice(pos + 2, closeIdx).replace(/^youtube\s*/i, '').trim()
  const html = buildYouTubeEmbedHtml(inner)
  if (!html) return false // leave an unrecognized shortcode as plain text

  if (!silent) {
    const token = state.push('html_inline', '', 0)
    token.content = html
  }

  state.pos = closeIdx + 2
  return true
})

// `{{infobox key=value|…}}` → sidebar fact box. Like wikilink/youtube this
// pushes an html_inline token so the rendered `<aside>` survives `html:false`.
md.inline.ruler.before('link', 'infobox', (state: StateInline, silent: boolean) => {
  const src = state.src
  const pos = state.pos

  if (src[pos] !== '{' || src[pos + 1] !== '{') return false
  if (!/^\{\{infobox\b/i.test(src.slice(pos, pos + 11))) return false

  const closeIdx = src.indexOf('}}', pos + 2)
  if (closeIdx === -1) return false

  if (!silent) {
    const env = state.env as MarkdownRenderEnv
    const inner = src.slice(pos + 2, closeIdx).replace(/^infobox\s*/i, '')
    const html = buildInfoboxHtml(inner, env.ownerDid)
    if (html) {
      const token = state.push('html_inline', '', 0)
      token.content = html
    }
  }

  state.pos = closeIdx + 2
  return true
})

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function preprocessSource(source: string, env: MarkdownRenderEnv = {}): string {
  let text = stripFrontmatter(source)
  if (env.wikiNotes?.length) {
    text = expandEmbeds(text, env.wikiNotes)
  }
  text = text.replace(/^(?:#\s*)?redirect:\s*[a-z0-9-]+\s*$/im, '')
  // Infobox and youtube shortcodes are expanded by inline rules during render,
  // not here, so they survive `html:false` as real elements.
  return text.trimStart()
}

/**
 * Build the `<aside class="infobox">` HTML for a shortcode body (the part
 * between `{{infobox ` and `}}`). Image/caption render at the top; the title/
 * name field becomes the header; everything else is a label/value row.
 * Reserved keys (name/title/image/img/caption) never appear as data rows.
 */
function buildInfoboxHtml(inner: string, ownerDid?: string): string {
  const rows: string[] = []
  let title = ''
  let image = ''
  let caption = ''

  for (const part of inner.split(/[|\n]/)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const rawKey = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!rawKey || !value) continue
    const key = rawKey.toLowerCase()

    if (key === 'title' || key === 'name') {
      title = title || value
      continue
    }
    if (key === 'image' || key === 'img') {
      image = image || value
      continue
    }
    if (key === 'caption') {
      caption = caption || value
      continue
    }
    rows.push(`<tr><th>${escapeHtml(rawKey)}</th><td>${escapeHtml(value)}</td></tr>`)
  }

  // An infobox needs at least a title or some data to be worth showing.
  if (!title && rows.length === 0) return ''

  function rewriteImage(src: string): string {
    const preview = getSessionBlobPreview(src)
    if (preview) return preview
    if (ownerDid) {
      const rewritten = resolveBlobSrcSync(src, ownerDid)
      if (rewritten) return rewritten
    }
    return src
  }

  const infoboxImage = image ? responsiveImage(rewriteImage(image)) : null
  const infoboxSrcSet = infoboxImage?.srcSet
    ? `srcset="${escapeHtml(infoboxImage.srcSet)}" sizes="(max-width: 720px) 100vw, 240px" `
    : ''
  const imageHtml = infoboxImage
    ? `<img class="infobox-image" src="${escapeHtml(infoboxImage.src)}" ${infoboxSrcSet}alt="" loading="eager" fetchpriority="high" decoding="async" />`
    : ''
  const captionHtml = caption
    ? `<div class="infobox-caption">${escapeHtml(caption)}</div>`
    : ''
  const header = title
    ? `<div class="infobox-title">${escapeHtml(title)}</div>`
    : ''
  const table =
    rows.length > 0
      ? `<table class="infobox-table"><tbody>${rows.join('')}</tbody></table>`
      : ''

  return (
    `<aside class="infobox">` +
    imageHtml +
    captionHtml +
    header +
    table +
    `</aside>`
  )
}

export function renderMarkdown(
  source: string,
  env: MarkdownRenderEnv = {},
): string {
  const processed = preprocessSource(source, env)
  const html = md.render(processed, env)
  return DOMPurify.sanitize(html, {
    ADD_ATTR: [
      'target',
      'rel',
      'class',
      'id',
      'loading',
      'decoding',
      'srcset',
      'sizes',
      'fetchpriority',
      'width',
      'height',
      'style',
      'aria-hidden',
      // iframe (YouTube embeds)
      'src',
      'allow',
      'allowfullscreen',
      'referrerpolicy',
      'frameborder',
      'title',
    ],
    ADD_TAGS: [
      'iframe',
      'aside',
      'table',
      'tbody',
      'tr',
      'th',
      'td',
      'span',
      'figure',
      // `:::` section containers
      'section',
      'article',
      'header',
      'div',
    ],
  })
}

export { parseWikilinkTarget, extractWikilinks } from '@/lib/lichen/wikilinks'
export type { WikilinkTarget }
