import type { LichenNoteWithContent, LichenRevisionRecord } from '@/types/lichen'
import { analyzeContentChange, type ChangeAction } from '@/lib/lichen/change-summary'
import { replayRevisions } from '@/lib/lichen/revisions'

export interface RecentChange {
  revision: LichenRevisionRecord
  note: LichenNoteWithContent
  action: ChangeAction
  /** One-line description of the edit, e.g. "Added section: Gameplay". */
  summary: string
  addedChars: number
  removedChars: number
}

export interface RecentChangesOptions {
  /**
   * Include edits that are too small to matter (typos, punctuation). Off by
   * default: Recent changes is a feed of real edits, not every keystroke.
   */
  includeMinor?: boolean
}

/**
 * One row per article, newest meaningful edit first.
 *
 * Raw revision lists are a poor feed: a page saved ten times fills the list
 * with its own title, and each row says nothing about what changed. This walks
 * each note's replayed history backwards to the most recent edit that actually
 * changed the article, describes it, and never emits the same note twice.
 */
export function listRecentChanges(
  revisions: LichenRevisionRecord[],
  notes: LichenNoteWithContent[],
  limit = 30,
  options: RecentChangesOptions = {},
): RecentChange[] {
  const noteByUri = new Map(notes.map((note) => [note.uri, note]))
  const sorted = [...revisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const changes: RecentChange[] = []
  const seenNotes = new Set<string>()

  // Every note costs one full replay, so stop after a generous multiple of the
  // requested rows even when most revisions turn out to be minor.
  const noteBudget = Math.max(limit * 8, 40)

  for (const revision of sorted) {
    if (seenNotes.has(revision.noteRef)) continue
    seenNotes.add(revision.noteRef)
    if (seenNotes.size > noteBudget) break

    const note = noteByUri.get(revision.noteRef)
    if (!note) continue

    const change = findLatestMeaningfulChange(note, revisions, options)
    if (!change) continue
    changes.push(change)
    if (changes.length >= limit) break
  }

  return changes
}

function findLatestMeaningfulChange(
  note: LichenNoteWithContent,
  revisions: LichenRevisionRecord[],
  options: RecentChangesOptions,
): RecentChange | null {
  const states = replayRevisions(note.uri, revisions)
  if (!states.length) {
    // Unreadable history: keep the newest revision visible rather than hiding
    // the page, but say only that it changed.
    const newest = [...revisions]
      .filter((revision) => revision.noteRef === note.uri)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!newest) return null
    return {
      revision: newest,
      note,
      action: newest.parentRevision ? 'edited' : 'created',
      summary: newest.message?.trim() || 'Updated content',
      addedChars: 0,
      removedChars: 0,
    }
  }

  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index]
    const before = index > 0 ? states[index - 1].content : ''
    const analysis = analyzeContentChange(before, state.content)
    if (!options.includeMinor && !analysis.meaningful) continue
    if (!analysis.meaningful && options.includeMinor && !analysis.detail) continue

    const revision = state.revision
    const action: ChangeAction =
      analysis.created || !revision.parentRevision ? 'created' : 'edited'
    const detail =
      action === 'created'
        ? revision.message?.trim() || 'First version published'
        : revision.message?.trim() || analysis.detail || 'Updated content'

    return {
      revision,
      note,
      action,
      summary: detail,
      addedChars: analysis.addedChars,
      removedChars: analysis.removedChars,
    }
  }

  return null
}
