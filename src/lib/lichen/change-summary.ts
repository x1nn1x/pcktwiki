import DiffMatchPatch from 'diff-match-patch'
import { computeLineDiff } from '@/lib/lichen/visual-diff'
import { reconstructAtRevision } from '@/lib/lichen/revisions'
import type { LichenNoteWithContent, LichenRevisionRecord } from '@/types/lichen'

export type ChangeAction = 'created' | 'edited'

/**
 * A page edit smaller than this many changed characters is housekeeping
 * (typos, punctuation, a swapped word) and should not appear in Recent
 * changes. Structural edits — a new section, image, or category — always
 * count, however short the markup is.
 */
export const MIN_MEANINGFUL_CHARS = 40

export interface ChangeAnalysis {
  meaningful: boolean
  created: boolean
  addedChars: number
  removedChars: number
  detail: string
}

const countDmp = new DiffMatchPatch()

function measureChange(oldText: string, newText: string): {
  added: number
  removed: number
  addedText: string
} {
  const diffs = countDmp.diff_main(oldText, newText)
  let added = 0
  let removed = 0
  let addedText = ''
  for (const [operation, text] of diffs) {
    if (operation === 1) {
      added += text.length
      addedText += text
    } else if (operation === -1) {
      removed += text.length
    }
  }
  return { added, removed, addedText }
}

/**
 * Whether an edit deserves a Recent changes row, plus a one-line description
 * of what changed. Character-level, so fixing one letter in a long paragraph
 * does not look like a whole-line rewrite.
 */
export function analyzeContentChange(oldText: string, newText: string): ChangeAnalysis {
  const old = oldText.trim()
  const next = newText.trim()
  const created = !old && !!next
  if (old === next) {
    return {
      meaningful: false,
      created: false,
      addedChars: 0,
      removedChars: 0,
      detail: '',
    }
  }

  const { added, removed, addedText } = measureChange(oldText, newText)
  const structural =
    /^#{1,6}\s+\S/m.test(addedText) ||
    /!\[[^\]]*\]\(/.test(addedText) ||
    /\[\[Category:/i.test(addedText)
  const meaningful = created || added + removed >= MIN_MEANINGFUL_CHARS || structural

  return {
    meaningful,
    created,
    addedChars: added,
    removedChars: removed,
    detail: summarizeContentDiff(oldText, newText),
  }
}

export interface ChangeSummary {
  action: ChangeAction
  detail: string
}

function cleanLine(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(text: string, max = 56): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trim()}…`
}

function summarizeContentDiff(oldText: string, newText: string): string {
  const old = oldText.trim()
  const next = newText.trim()

  if (!old && next) return 'First version published'
  if (old && !next) return 'Article cleared'

  const lines = computeLineDiff(oldText, newText)
  const added = lines.filter((line) => line.type === 'add').map((line) => line.text.trim()).filter(Boolean)
  const removed = lines.filter((line) => line.type === 'remove').map((line) => line.text.trim()).filter(Boolean)

  const heading = added.find((line) => /^#{1,6}\s+\S/.test(line))
  if (heading) {
    return `Added section: ${truncate(cleanLine(heading))}`
  }

  const wikilink = added.find((line) => /\[\[[^\]]+\]\]/.test(line))
  if (wikilink) {
    const match = wikilink.match(/\[\[([^\]|]+)/)
    if (match?.[1]) return `Linked to ${truncate(cleanLine(match[1]), 40)}`
  }

  const substantive = added
    .map(cleanLine)
    .find((line) => line.length >= 8 && !/^[-*+]\s*$/.test(line))

  if (substantive) {
    return `Added: ${truncate(substantive)}`
  }

  if (removed.length === 1 && !added.length) {
    return `Removed: ${truncate(cleanLine(removed[0]!))}`
  }

  if (added.length && removed.length) {
    const total = added.length + removed.length
    return `Changed ${total} line${total === 1 ? '' : 's'}`
  }

  if (added.length) {
    return `Added ${added.length} line${added.length === 1 ? '' : 's'}`
  }

  if (removed.length) {
    return `Removed ${removed.length} line${removed.length === 1 ? '' : 's'}`
  }

  return 'Updated content'
}

export function summarizeRevisionChange(
  revision: LichenRevisionRecord,
  note: LichenNoteWithContent,
  revisions: LichenRevisionRecord[],
): ChangeSummary {
  const message = revision.message?.trim()

  if (!revision.parentRevision) {
    return {
      action: 'created',
      detail: message || 'First version published',
    }
  }

  if (message && message.length >= 4) {
    return { action: 'edited', detail: message }
  }

  const oldContent = reconstructAtRevision(note.uri, revision.parentRevision, revisions)
  const newContent = reconstructAtRevision(note.uri, revision.uri, revisions)

  return {
    action: 'edited',
    detail: summarizeContentDiff(oldContent, newContent),
  }
}

export function changeActionLabel(action: ChangeAction): string {
  return action === 'created' ? 'New article' : 'Edited'
}
