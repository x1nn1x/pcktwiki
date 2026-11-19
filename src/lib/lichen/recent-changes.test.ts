import { describe, expect, it } from 'vitest'
import { createDiff } from '@/lib/lichen/diff'
import { listRecentChanges } from '@/lib/lichen/recent-changes'
import type { LichenNoteWithContent, LichenRevisionRecord } from '@/types/lichen'

function makeChain(
  noteRef: string,
  texts: string[],
  dayOffset = 1,
): LichenRevisionRecord[] {
  const revisions: LichenRevisionRecord[] = []
  let previous = ''
  texts.forEach((text, index) => {
    revisions.push({
      uri: `${noteRef}/revision/${index}`,
      cid: `cid${index}`,
      noteRef,
      parentRevision: index === 0 ? undefined : revisions[index - 1].uri,
      diff: createDiff(previous, text),
      diffFormat: 'diff-match-patch',
      createdAt: `2026-01-${String(dayOffset + index).padStart(2, '0')}T00:00:00.000Z`,
    })
    previous = text
  })
  return revisions
}

function note(uri: string, title: string, content: string): LichenNoteWithContent {
  return {
    uri,
    cid: 'cid',
    slug: title.toLowerCase().replace(/\s+/g, '-'),
    title,
    wikiRef: 'at://did:plc:test/wiki.lichen.wiki/w1',
    createdAt: '2026-01-01T00:00:00.000Z',
    content,
    latestRevisionUri: null,
  }
}

const LONG_PARAGRAPH =
  'The harbour is the oldest part of the city, and its stone walls still hold the original lighthouse.'

describe('listRecentChanges', () => {
  it('lists one row per article, not every revision', () => {
    const uri = 'at://did:plc:test/wiki.lichen.note/a'
    const revisions = makeChain(uri, [
      `${LONG_PARAGRAPH}\n\n## History\n\nThe harbour was built in 1402.`,
      `${LONG_PARAGRAPH}\n\n## History\n\nThe harbour was built in 1402 and rebuilt in 1701.`,
    ])
    const changes = listRecentChanges(revisions, [note(uri, 'Harbour', revisions[1].snapshot ?? '')], 10)
    expect(changes).toHaveLength(1)
    expect(changes[0].note.title).toBe('Harbour')
  })

  it('skips typo-sized edits and falls back to the last meaningful one', () => {
    const uri = 'at://did:plc:test/wiki.lichen.note/b'
    const base = `${LONG_PARAGRAPH}\n\n## History\n\nThe harbour was built in 1402.`
    const meaningful = base.replace(
      '1402',
      '1402 by the Guild of Sailors and the city’s merchant council',
    )
    const typo = meaningful.replace('harbour', 'harbor')
    const revisions = makeChain(uri, [base, meaningful, typo])
    const changes = listRecentChanges(revisions, [note(uri, 'Harbour', typo)], 10)
    expect(changes).toHaveLength(1)
    expect(changes[0].revision.uri).toBe(revisions[1].uri)
    expect(changes[0].summary).toContain('Added')
  })

  it('drops an article whose only edits are typos', () => {
    const uri = 'at://did:plc:test/wiki.lichen.note/c'
    const revisions = makeChain(uri, ['Harbour', 'Harbor'])
    const changes = listRecentChanges(revisions, [note(uri, 'Harbour', 'Harbor')], 10)
    // The initial revision is still a real page creation, so it remains — but
    // the typo revision does not add a second row.
    expect(changes).toHaveLength(1)
    expect(changes[0].action).toBe('created')
  })

  it('describes new sections and keeps newest articles first', () => {
    const older = 'at://did:plc:test/wiki.lichen.note/d'
    const newer = 'at://did:plc:test/wiki.lichen.note/e'
    const olderBase = LONG_PARAGRAPH
    const olderNext = `${LONG_PARAGRAPH}\n\n## Trade routes\n\nShips arrived from the north.`
    const newerBase = 'A small page.'
    const newerNext = 'A small page with a substantially longer body that says something useful.'
    const revisions = [
      ...makeChain(older, [olderBase, olderNext], 1),
      ...makeChain(newer, [newerBase, newerNext], 5),
    ]
    const changes = listRecentChanges(
      revisions,
      [
        note(older, 'Harbour', olderNext),
        note(newer, 'Lighthouse', newerNext),
      ],
      10,
    )
    expect(changes.map((change) => change.note.title)).toEqual(['Lighthouse', 'Harbour'])
    expect(changes[1].summary).toContain('Added section')
  })
})
