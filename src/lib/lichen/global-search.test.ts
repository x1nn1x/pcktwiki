import { describe, expect, it } from 'vitest'
import {
  searchGlobalIndex,
  selectArticleTargets,
  wikiKey,
  type GlobalSearchIndex,
  type GlobalSearchWiki,
} from '@/lib/lichen/global-search'
import { pdsHostFromHandle } from '@/lib/lichen/wiki-directory'
import type { LichenNoteWithContent } from '@/types/lichen'

function wiki(handle: string, slug: string, name: string, description = ''): GlobalSearchWiki {
  return {
    handle,
    slug,
    name,
    description,
    pdsHost: pdsHostFromHandle(handle),
    accentColor: '#58a7ff',
    did: `did:plc:${slug}`,
  }
}

function note(slug: string, title: string, body: string): LichenNoteWithContent {
  return {
    uri: `at://did:plc:test/wiki.lichen.note/${slug}`,
    cid: 'cid',
    slug,
    title,
    wikiRef: 'at://did:plc:test/wiki.lichen.wiki/foxes',
    createdAt: '2026-01-01T00:00:00.000Z',
    content: body,
    latestRevisionUri: null,
  }
}

function makeIndex(wikis: GlobalSearchWiki[]): GlobalSearchIndex {
  return {
    wikis,
    notesByWiki: new Map(),
    indexedWikis: new Set(),
    noteThumbnails: new Map(),
    wikiThumbnails: new Map(),
    authorAvatars: new Map(),
    loadedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('pdsHostFromHandle', () => {
  it('keeps both labels of a two-label handle', () => {
    expect(pdsHostFromHandle('j3s.sh')).toBe('j3s.sh')
    expect(pdsHostFromHandle('kyefox.com')).toBe('kyefox.com')
  })

  it('drops the subdomain of a longer handle', () => {
    expect(pdsHostFromHandle('oseanstudio.bsky.social')).toBe('bsky.social')
    expect(pdsHostFromHandle('theriveroflight.sayitditto.net')).toBe('sayitditto.net')
  })
})

describe('searchGlobalIndex', () => {
  const index = makeIndex([
    wiki('oseanstudio.bsky.social', 'oseanworld', 'OSEAN WORLD'),
    wiki('kyefox.com', 'foxes', 'Foxes'),
  ])

  it('matches a wiki before any of its articles have been indexed', () => {
    const results = searchGlobalIndex(index, 'osean')
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('wiki')
    expect(results[0]!.wiki.slug).toBe('oseanworld')
  })

  it('matches on handle so a wiki is findable by its account', () => {
    const results = searchGlobalIndex(index, 'kyefox.com')
    expect(results.map((result) => result.wiki.slug)).toContain('foxes')
  })

  it('includes articles once their wiki has been indexed', () => {
    const withNotes: GlobalSearchIndex = {
      ...index,
      notesByWiki: new Map([
        [wikiKey('kyefox.com', 'foxes'), [note('fennec-fox', 'Fennec Fox', 'Large ears.')]],
      ]),
      indexedWikis: new Set([wikiKey('kyefox.com', 'foxes')]),
    }

    const results = searchGlobalIndex(withNotes, 'fennec')
    expect(results).toHaveLength(1)
    expect(results[0]!.kind).toBe('note')
  })
})

describe('selectArticleTargets', () => {
  const wikis = [
    wiki('a.example', 'alpha', 'Alpha'),
    wiki('b.example', 'quantum-notes', 'Quantum Notes'),
    wiki('c.example', 'gamma', 'Gamma'),
  ]

  it('puts wikis whose own metadata matches first', () => {
    const targets = selectArticleTargets(makeIndex(wikis), 'quantum')
    expect(targets[0]!.slug).toBe('quantum-notes')
  })

  it('still returns non-matching wikis so article-only terms are reachable', () => {
    const targets = selectArticleTargets(makeIndex(wikis), 'fennec')
    expect(targets).toHaveLength(3)
  })

  it('skips wikis that are already indexed', () => {
    const index = makeIndex(wikis)
    index.indexedWikis.add(wikiKey('b.example', 'quantum-notes'))

    const targets = selectArticleTargets(index, 'quantum')
    expect(targets.map((target) => target.slug)).not.toContain('quantum-notes')
  })

  it('respects the per-round budget', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      wiki(`w${i}.example`, `wiki-${i}`, `Wiki ${i}`),
    )
    expect(selectArticleTargets(makeIndex(many), 'anything', 12)).toHaveLength(12)
  })
})
