import { slugifyHeading } from '@/lib/lichen/wikilinks'

export interface TocEntry {
  id: string
  text: string
  level: number
}

/**
 * Split a note body at the first `##`/`###` heading line that is not inside a
 * fenced code block. Wikipedia places its Contents box exactly there: after
 * the lead section, before the first section heading. The lead is the text
 * before that heading (may be empty); the rest is everything from the heading
 * on (also may be empty).
 */
export function splitLeadSection(body: string): { lead: string; rest: string } {
  const lines = body.split('\n')
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        fence = marker[0].repeat(3)
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker // closing fence has no info string
      ) {
        fence = null
      }
      continue
    }
    if (fence) continue
    if (/^#{2,3}\s+\S/.test(line)) {
      return {
        lead: lines.slice(0, i).join('\n'),
        rest: lines.slice(i).join('\n'),
      }
    }
  }

  return { lead: body, rest: '' }
}

/**
 * Count base heading slugs in a markdown chunk so a follow-up render can
 * continue the same dedupe sequence (`heading`, `heading-2`, `heading-3` …)
 * when the article is rendered as two chunks around the Contents box.
 */
export function headingIdCounts(source: string): Map<string, number> {
  const counts = new Map<string, number>()
  let fence: string | null = null

  for (const line of source.split('\n')) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        fence = marker[0].repeat(3)
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = null
      }
      continue
    }
    if (fence) continue

    const match = line.match(/^#{1,6}\s+(.+?)\s*$/)
    if (!match) continue
    const text = match[1].replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/#+\s*$/, '').trim()
    const baseId = slugifyHeading(text)
    if (!baseId) continue
    counts.set(baseId, (counts.get(baseId) ?? 0) + 1)
  }

  return counts
}

export function extractTocFromMarkdown(source: string): TocEntry[] {
  const body = source.replace(/^---[\s\S]*?---\s*/, '')
  const entries: TocEntry[] = []
  const seen = new Set<string>()

  for (const line of body.split('\n')) {
    const match = line.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (!match) continue

    const level = match[1].length
    const text = match[2].replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/#+\s*$/, '').trim()
    const baseId = slugifyHeading(text)
    let id = baseId
    let counter = 2
    while (seen.has(id)) {
      id = `${baseId}-${counter}`
      counter += 1
    }
    seen.add(id)

    entries.push({ id, text, level })
  }

  return entries
}
