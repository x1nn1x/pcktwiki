import { parseRelationFromWikilink } from '@/lib/lichen/relations'
import { routeHref } from '@/lib/base-url'

export interface WikilinkTarget {
  ownerHandle?: string
  wikiSlug?: string
  noteSlug: string
  label: string
  section?: string
  /** Present when the link is a typed relationship. */
  relationType?: string
}

export function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseWikilinkTarget(
  content: string,
  currentWikiSlug?: string,
  currentOwnerHandle?: string,
): WikilinkTarget | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const pipeIdx = trimmed.indexOf('|')
  const beforePipe = (pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed).trim()
  const rawLabel = (pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1) : '').trim()

  const hashIdx = beforePipe.indexOf('#')
  const rawTarget = (hashIdx >= 0 ? beforePipe.slice(0, hashIdx) : beforePipe).trim()
  const section = hashIdx >= 0 ? beforePipe.slice(hashIdx + 1).trim() : undefined

  if (!rawTarget && section) {
    return { noteSlug: '', label: rawLabel || section, section }
  }

  if (!rawTarget) return null

  const sectionSuffix = section ? `#${section}` : ''

  if (rawTarget.startsWith('@')) {
    const withoutAt = rawTarget.slice(1)
    const firstSlash = withoutAt.indexOf('/')
    if (firstSlash > 0) {
      const handle = withoutAt.slice(0, firstSlash)
      const rest = withoutAt.slice(firstSlash + 1)
      const secondSlash = rest.indexOf('/')
      if (secondSlash > 0) {
        const wikiSlug = rest.slice(0, secondSlash)
        const noteSlug = rest.slice(secondSlash + 1).trim()
        const defaultLabel = noteSlug
          ? `@${handle}/${wikiSlug}/${noteSlug}${sectionSuffix}`
          : `@${handle}/${wikiSlug}`
        return {
          ownerHandle: handle,
          wikiSlug,
          noteSlug,
          label: rawLabel || defaultLabel,
          ...(section ? { section } : {}),
        }
      }
      const wikiSlug = rest.trim()
      return {
        ownerHandle: handle,
        wikiSlug,
        noteSlug: '',
        label: rawLabel || `@${handle}/${wikiSlug}`,
        ...(section ? { section } : {}),
      }
    }
    return null
  }

  if (rawTarget.includes('/')) return null

  const relation = parseRelationFromWikilink(rawTarget)
  if (relation) {
    return {
      ...(currentOwnerHandle ? { ownerHandle: currentOwnerHandle } : {}),
      ...(currentWikiSlug ? { wikiSlug: currentWikiSlug } : {}),
      noteSlug: relation.targetSlug,
      label: rawLabel || relation.targetSlug,
      relationType: relation.type,
      ...(section ? { section } : {}),
    }
  }

  return {
    ...(currentOwnerHandle ? { ownerHandle: currentOwnerHandle } : {}),
    ...(currentWikiSlug ? { wikiSlug: currentWikiSlug } : {}),
    // Plain targets canonicalize to article slugs so [[Yameii]] resolves the
    // same as [[yameii]] — hrefs, backlinks, and missing-page detection all
    // compare against lowercase slug sets. Unslugifiable targets (e.g. CJK)
    // keep their raw form.
    noteSlug: slugifyHeading(rawTarget) || rawTarget,
    label: rawLabel || `${rawTarget}${sectionSuffix}`,
    ...(section ? { section } : {}),
  }
}

export function extractWikilinks(content: string, currentWikiSlug?: string): WikilinkTarget[] {
  const seen = new Set<string>()
  const links: WikilinkTarget[] = []
  let pos = 0

  while (pos < content.length) {
    if (content[pos] === '[' && content[pos + 1] === '[') {
      const closeIdx = content.indexOf(']]', pos + 2)
      if (closeIdx === -1) break
      const target = parseWikilinkTarget(content.slice(pos + 2, closeIdx), currentWikiSlug)
      if (target && (target.noteSlug || target.wikiSlug)) {
        const noteSlug = target.noteSlug || 'home'
        const key = `${target.wikiSlug ?? currentWikiSlug ?? ''}:${noteSlug}`
        if (!seen.has(key)) {
          seen.add(key)
          links.push({ ...target, noteSlug })
        }
      }
      pos = closeIdx + 2
    } else {
      pos += 1
    }
  }

  return links
}

export function wikilinkHref(
  target: WikilinkTarget,
  ownerHandle: string,
  wikiSlug: string,
): string {
  const anchor = target.section ? `#${slugifyHeading(target.section)}` : ''
  const noteSlug = target.noteSlug ? slugifyHeading(target.noteSlug) : ''
  const linkWikiSlug = target.wikiSlug ? slugifyHeading(target.wikiSlug) : wikiSlug
  const linkHandle = target.ownerHandle ?? ownerHandle

  if (!target.wikiSlug && !target.noteSlug && target.section) {
    return anchor
  }
  // These are written straight into rendered markup, so they carry the
  // deployment base themselves — unlike RouterLink targets.
  if (!noteSlug && target.wikiSlug && target.ownerHandle) {
    return routeHref(`/@${encodeURIComponent(linkHandle)}/${encodeURIComponent(linkWikiSlug)}${anchor}`)
  }
  if (target.wikiSlug && target.ownerHandle) {
    return routeHref(
      `/@${encodeURIComponent(linkHandle)}/${encodeURIComponent(linkWikiSlug)}/${encodeURIComponent(noteSlug)}${anchor}`,
    )
  }
  if (noteSlug) {
    return routeHref(
      `/@${encodeURIComponent(linkHandle)}/${encodeURIComponent(wikiSlug)}/${encodeURIComponent(noteSlug)}${anchor}`,
    )
  }
  return routeHref(`/@${encodeURIComponent(linkHandle)}/${encodeURIComponent(wikiSlug)}${anchor}`)
}
