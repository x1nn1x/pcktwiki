import type { LichenNoteRecord, LichenNoteWithContent, LichenRevisionRecord } from '@/types/lichen'
import { normalizeLF, tryApplyDiff } from '@/lib/lichen/diff'

export interface NoteContentState {
  content: string
  latestRevisionUri: string | null
  /**
   * Revisions whose diff would not apply. Their edits are missing from
   * `content`, so it is not a faithful reconstruction — surface this rather
   * than presenting the result as intact.
   */
  damaged: LichenRevisionRecord[]
}

/** Written every Nth revision so a broken diff cannot invalidate the rest. */
export const SNAPSHOT_INTERVAL = 5

/**
 * Whether a note's next revision should carry a full-text snapshot, given how
 * many revisions it already has.
 */
export function shouldSnapshot(existingRevisionCount: number): boolean {
  return (existingRevisionCount + 1) % SNAPSHOT_INTERVAL === 0
}

export interface RevisionState {
  revision: LichenRevisionRecord
  content: string
}

export interface ReplayResult {
  /** Content after each revision that took part, in apply order. */
  states: RevisionState[]
  content: string
  latestRevisionUri: string | null
  damaged: LichenRevisionRecord[]
}

interface ReplayOptions {
  /** Stop once this revision has been applied. */
  stopAt?: string
  /** Skip revisions that do not chain onto the last applied one. */
  enforceParentChain?: boolean
}

/**
 * Replay an ordered revision chain into content.
 *
 * A diff that will not apply is recorded in `damaged` instead of being dropped
 * in silence: the edit is lost either way, but the caller can say so. Content
 * carries on from the last good state rather than aborting, so one bad link does
 * not blank the page.
 *
 * A revision carrying a `snapshot` re-anchors content to that exact text and
 * clears earlier damage — the live page matches the snapshot, so past apply
 * failures no longer mean the current text is incomplete. That also makes
 * "Keep this version" stick across reloads. Damage after the latest snapshot
 * still surfaces.
 */
function replayChain(
  ordered: LichenRevisionRecord[],
  options: ReplayOptions = {},
): ReplayResult {
  const states: RevisionState[] = []
  const damaged: LichenRevisionRecord[] = []
  let content = ''
  let latestRevisionUri: string | null = null

  for (const revision of ordered) {
    if (revision.diffFormat !== 'diff-match-patch') {
      // Still honor an authoritative snapshot on an otherwise unreadable revision.
      if (typeof revision.snapshot === 'string') {
        content = normalizeLF(revision.snapshot)
        damaged.length = 0
        states.push({ revision, content })
        latestRevisionUri = revision.uri
        if (options.stopAt && revision.uri === options.stopAt) break
        continue
      }
      damaged.push(revision)
      continue
    }
    if (
      options.enforceParentChain &&
      revision.parentRevision &&
      latestRevisionUri &&
      revision.parentRevision !== latestRevisionUri
    ) {
      // Snapshots are authoritative — apply them even when the parent pointer is
      // wrong so "Keep this version" cannot be skipped on reload.
      if (typeof revision.snapshot === 'string') {
        content = normalizeLF(revision.snapshot)
        damaged.length = 0
        states.push({ revision, content })
        latestRevisionUri = revision.uri
        if (options.stopAt && revision.uri === options.stopAt) break
        continue
      }
      damaged.push(revision)
      continue
    }

    const next = tryApplyDiff(content, revision.diff)
    if (next === null) damaged.push(revision)
    else content = normalizeLF(next)

    // Authoritative: overrides whatever the diffs produced up to here, and
    // accepts the live text so earlier broken links stop counting as damage.
    if (typeof revision.snapshot === 'string') {
      content = normalizeLF(revision.snapshot)
      damaged.length = 0
    }

    states.push({ revision, content })
    latestRevisionUri = revision.uri
    if (options.stopAt && revision.uri === options.stopAt) break
  }

  return { states, content, latestRevisionUri, damaged }
}

/** Replay one note's revisions, reporting anything that would not apply. */
export function replayNote(
  noteRef: string,
  revisions: LichenRevisionRecord[],
  options: ReplayOptions = {},
): ReplayResult {
  const ordered = orderRevisions(revisions.filter((revision) => revision.noteRef === noteRef))
  return replayChain(ordered, options)
}

export function buildNoteContents(
  revisions: LichenRevisionRecord[],
): Map<string, NoteContentState> {
  const byNote = new Map<string, LichenRevisionRecord[]>()

  for (const revision of revisions) {
    const list = byNote.get(revision.noteRef) ?? []
    list.push(revision)
    byNote.set(revision.noteRef, list)
  }

  const result = new Map<string, NoteContentState>()

  for (const [noteRef, noteRevisions] of byNote) {
    const replay = replayChain(orderRevisions(noteRevisions), { enforceParentChain: true })
    result.set(noteRef, {
      content: replay.content,
      latestRevisionUri: replay.latestRevisionUri,
      damaged: replay.damaged,
    })
  }

  return result
}

function orderRevisions(revisions: LichenRevisionRecord[]): LichenRevisionRecord[] {
  const byUri = new Map(revisions.map((revision) => [revision.uri, revision]))
  const roots = revisions.filter((revision) => !revision.parentRevision)
  if (roots.length === 0) {
    return [...revisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  const ordered: LichenRevisionRecord[] = []
  const visited = new Set<string>()
  let current: LichenRevisionRecord | undefined = roots.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )[0]

  while (current && !visited.has(current.uri)) {
    ordered.push(current)
    visited.add(current.uri)
    current = [...byUri.values()].find((revision) => revision.parentRevision === current!.uri)
  }

  for (const revision of revisions) {
    if (!visited.has(revision.uri)) ordered.push(revision)
  }

  return ordered.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function attachContentToNotes(
  notes: LichenNoteRecord[],
  contents: Map<string, NoteContentState>,
): LichenNoteWithContent[] {
  return notes.map((note) => {
    const state = contents.get(note.uri)
    const damagedUris = state?.damaged.map((revision) => revision.uri) ?? []
    return {
      ...note,
      content: state?.content ?? '',
      latestRevisionUri: state?.latestRevisionUri ?? null,
      ...(damagedUris.length > 0
        ? { damagedRevisions: damagedUris.length, damagedRevisionUris: damagedUris }
        : {}),
    }
  })
}

/** Drop incomplete-rebuild markers after the live text is treated as authoritative. */
export function clearNoteDamage(note: LichenNoteWithContent): void {
  delete note.damagedRevisions
  delete note.damagedRevisionUris
}

export function listRevisionHistory(
  noteRef: string,
  revisions: LichenRevisionRecord[],
): LichenRevisionRecord[] {
  return revisions
    .filter((revision) => revision.noteRef === noteRef)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** The note's content after each of its revisions, in the order they apply. */
export function replayRevisions(
  noteRef: string,
  revisions: LichenRevisionRecord[],
): RevisionState[] {
  return replayNote(noteRef, revisions).states
}

export function reconstructAtRevision(
  noteRef: string,
  targetRevisionUri: string,
  revisions: LichenRevisionRecord[],
): string {
  return replayNote(noteRef, revisions, { stopAt: targetRevisionUri }).content
}
