import { diff_match_patch } from 'diff-match-patch'
import { orderRevisions } from '@/lib/lichen/revisions'
import type { LichenRevisionRecord } from '@/types/lichen'

const dmp = new diff_match_patch()

const normalizeLF = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

function createDiff(oldText: string, newText: string): string {
  return dmp.patch_toText(dmp.patch_make(oldText, newText))
}

/**
 * Plan a targeted text redaction across a note's revision chain.
 *
 * The text is removed from every point-in-time state (diffs, snapshots, and
 * edit messages), with each affected revision's diff recomputed against its
 * redacted neighbours. Records keep their rkeys, timestamps, and parent links,
 * so the changelog survives intact — the redacted text simply was never there.
 * Unchanged records are skipped so only touched revisions are rewritten.
 */
export interface RedactionPlanItem {
  uri: string
  /** True when the stored record actually changes. */
  changed: boolean
  /** Full record to putRecord at this revision's rkey. */
  record: Record<string, unknown>
}

export interface RedactionPlan {
  /** Every revision in replay order, with `changed` marking rewrites. */
  items: RedactionPlanItem[]
  /** Only the revisions whose stored record changes — these get putRecord. */
  changedItems: RedactionPlanItem[]
  /** Revisions whose stored record actually changes. */
  revisionsAffected: number
  /** Occurrences remaining in the current (final) text after redaction. */
  occurrencesInCurrent: number
  /** The note's content after the redacted chain replays. */
  finalContent: string
  revisions: LichenRevisionRecord[]
}

function countOccurrences(text: string, searchText: string): number {
  if (!searchText) return 0
  let count = 0
  let index = 0
  while ((index = text.indexOf(searchText, index)) !== -1) {
    count += 1
    index += searchText.length
  }
  return count
}

export function planTextRedaction(
  revisions: LichenRevisionRecord[],
  searchText: string,
  replaceText: string,
): RedactionPlan {
  if (!searchText) throw new Error('No text to erase')
  const redact = (text: string) => text.split(searchText).join(replaceText)

  const ordered = orderRevisions(revisions)
  const items: RedactionPlanItem[] = []
  let revisionsAffected = 0
  let before = ''
  let finalContent = ''
  let last: LichenRevisionRecord | null = null

  for (const rev of ordered) {
    const v = rev
    const snapshot = typeof v.snapshot === 'string' ? v.snapshot : undefined
    let after = before
    if (v.diffFormat === 'diff-match-patch' && (v.diff ?? '').trim()) {
      try {
        const patches = dmp.patch_fromText(v.diff)
        const [result, applied] = dmp.patch_apply(patches, before)
        if (applied.every((ok) => ok)) after = normalizeLF(result)
      } catch {
        // Unappliable diff: the state carries forward (snapshot below re-anchors
        // when present, matching the app's replay behaviour).
      }
    }
    if (snapshot !== undefined) after = normalizeLF(snapshot)

    const redactedAfter = redact(after)
    const redactedSnapshot = snapshot !== undefined ? redact(snapshot) : undefined
    const redactedMessage = v.message !== undefined ? redact(v.message) : undefined

    const newDiff =
      v.diffFormat === 'diff-match-patch'
        ? createDiff(before, redactedAfter)
        : (v.diff ?? '')
    const changed =
      newDiff !== (v.diff ?? '') ||
      redactedSnapshot !== snapshot ||
      redactedMessage !== v.message
    if (changed) revisionsAffected += 1

    items.push({
      uri: rev.uri,
      changed,
      record: {
        $type: 'wiki.lichen.noteRevision',
        noteRef: v.noteRef,
        diff: newDiff,
        diffFormat: v.diffFormat ?? 'diff-match-patch',
        createdAt: v.createdAt,
        ...(rev.uri.split('/').pop() ? {} : {}),
        ...(v.parentRevision ? { parentRevision: v.parentRevision } : {}),
        ...(redactedMessage ? { message: redactedMessage } : {}),
        ...(redactedSnapshot !== undefined ? { snapshot: redactedSnapshot } : {}),
        ...(Array.isArray(v.blobs) && v.blobs.length ? { blobs: v.blobs } : {}),
      },
    })

    before = redactedAfter
    finalContent = redactedAfter
    last = rev
  }

  void last
  return {
    items,
    changedItems: items.filter((item) => item.changed),
    revisionsAffected,
    occurrencesInCurrent: countOccurrences(finalContent, searchText),
    finalContent,
    revisions: ordered,
  }
}
