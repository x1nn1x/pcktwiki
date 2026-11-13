import { beforeEach, describe, expect, it } from 'vitest'
import { planTextRedaction } from '@/lib/lichen/redact'
import { diff_match_patch } from 'diff-match-patch'

const dmp = new diff_match_patch()
const norm = (t: string) => t.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
const diff = (a: string, b: string) => dmp.patch_toText(dmp.patch_make(a, b))
const apply = (text: string, patch: string) => {
  const [res, ok] = dmp.patch_apply(dmp.patch_fromText(patch), text)
  return ok.every((x) => x) ? res : null
}

let seq = 0
function rev(opts: {
  diff: string
  noteRef?: string
  snapshot?: string
  message?: string
  parent?: string
  blobs?: Array<Record<string, unknown>>
}) {
  seq += 1
  const uri = `at://did:plc:test/wiki.lichen.noteRevision/rev${seq}`
  return {
    uri,
    cid: `c${seq}`,
    noteRef: opts.noteRef ?? 'at://did:plc:test/wiki.lichen.note/n1',
    parentRevision: opts.parent,
    diff: opts.diff,
    diffFormat: 'diff-match-patch',
    message: opts.message,
    snapshot: opts.snapshot,
    createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seq * 1000).toISOString(),
    ...(opts.blobs ? { blobs: opts.blobs } : {}),
  }
}

const SECRET = 'hunter2'

describe('planTextRedaction', () => {
  beforeEach(() => {
    seq = 0
  })

  it('removes the text from every historical state and preserves the chain', () => {
    const s0 = 'Hello world. My password is hunter2 ok.'
    const s1 = 'Hello world. My password is hunter2 ok! Also added more.'
    const revisions = [
      rev({ diff: diff('', s0) }),
      rev({ diff: diff(s0, s1), parent: 'at://did:plc:test/wiki.lichen.noteRevision/rev1' }),
    ]
    const plan = planTextRedaction(revisions, SECRET, '[redacted]')
    expect(plan.revisionsAffected).toBe(2)
    expect(plan.occurrencesInCurrent).toBe(0)
    // The redacted chain must replay cleanly with the secret absent everywhere.
    let content = ''
    for (const item of plan.items) {
      content = norm(apply(content, item.record.diff as string) ?? '')
    }
    expect(content).not.toContain(SECRET)
    expect(content).toContain('[redacted]')
    expect(content).toContain('Also added more.')
  })

  it('redacts snapshots and keeps the record shape (blobs, parents, timestamps)', () => {
    const s0 = `secret ${SECRET} here`
    const revisions = [
      rev({
        diff: diff('', s0),
        snapshot: s0,
        message: `added ${SECRET} text`,
        blobs: [{ $type: 'blob', ref: { $link: 'bafkrei123' }, mimeType: 'image/webp', size: 10 }],
      }),
    ]
    const plan = planTextRedaction(revisions, SECRET, '[redacted]')
    expect(plan.items).toHaveLength(1)
    const record = plan.items[0]!.record
    expect(record.snapshot).toBe('secret [redacted] here')
    expect(record.message).toBe('added [redacted] text')
    expect(record.diff).not.toContain(SECRET)
    expect(record.blobs).toEqual(revisions[0].blobs)
    expect(record.createdAt).toBe(revisions[0].createdAt)
    expect(plan.items[0]!.changed).toBe(true)
  })

  it('skips revisions the redaction does not touch', () => {
    const s0 = 'totally unrelated content'
    const s1 = 'unrelated, plus hunter2 appears'
    const s2 = 'unrelated again, hunter2 gone'
    const revisions = [
      rev({ diff: diff('', s0) }),
      rev({ diff: diff(s0, s1), parent: 'at://did:plc:test/wiki.lichen.noteRevision/rev1' }),
      rev({ diff: diff(s1, s2), parent: 'at://did:plc:test/wiki.lichen.noteRevision/rev2' }),
    ]
    const plan = planTextRedaction(revisions, SECRET, '[x]')
    // rev1 (unrelated) is untouched; rev2 adds the secret, and rev3's diff is
    // recomputed because its base state was redacted.
    expect(plan.items.filter((i) => i.changed).map((i) => i.uri.split('/').pop())).toEqual([
      'rev2',
      'rev3',
    ])
    expect(plan.occurrencesInCurrent).toBe(0)
    // And the untouched first revision keeps its exact diff.
    expect(plan.items[0].changed).toBe(false)
    expect(plan.items[0].record.diff).toBe(revisions[0].diff)
  })

  it('reports occurrences that remain in current text when only history had them is zero', () => {
    // The redaction applies to every state, so the current text is always clean too.
    const revisions = [rev({ diff: diff('', `a ${SECRET} b`) })]
    const plan = planTextRedaction(revisions, SECRET, '[censored]')
    expect(plan.occurrencesInCurrent).toBe(0)
    expect(plan.finalContent).toBe('a [censored] b')
  })

  it('handles text that spans a revision boundary', () => {
    // The secret exists across edits: rev1 adds "hunter", rev2 extends to "hunter2".
    const s1 = 'my pass is hunter'
    const s2 = 'my pass is hunter2 and more'
    const revisions = [
      rev({ diff: diff('', s1) }),
      rev({ diff: diff(s1, s2), parent: 'at://did:plc:test/wiki.lichen.noteRevision/rev1' }),
    ]
    const plan = planTextRedaction(revisions, SECRET, '[x]')
    let content = ''
    for (const item of plan.items) {
      content = norm(apply(content, item.record.diff as string) ?? '')
    }
    expect(content).not.toContain('hunter2')
    expect(content).toContain('[x]')
  })

  it('throws on empty search text', () => {
    expect(() => planTextRedaction([rev({ diff: diff('', 'x') })], '', '')).toThrow()
  })
})
