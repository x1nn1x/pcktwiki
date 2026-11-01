import { describe, expect, it } from 'vitest'
import {
  extractImageEmbeds,
  findDisallowedImages,
  findPageGrant,
  resolveForumCapabilities,
  resolveViewerCapabilities,
  resolveWikiPolicy,
  withPageGrant,
  DEFAULT_WIKI_POLICY,
} from '@/lib/lichen/collab'
import type { LichenApprovedMediaRecord, LichenPageGrantRecord } from '@/types/lichen'

const OWNER = 'did:plc:owner'
const VIEWER = 'did:plc:viewer'
const WIKI_REF = 'at://did:plc:owner/wiki.lichen.wiki/my-wiki'

function caps(overrides: Partial<Parameters<typeof resolveViewerCapabilities>[0]> = {}) {
  return resolveViewerCapabilities({
    ownerDid: OWNER,
    visibility: 'public',
    viewerDid: VIEWER,
    memberRole: null,
    policy: { ...DEFAULT_WIKI_POLICY },
    ownerFollowsViewer: false,
    ...overrides,
  })
}

describe('resolveWikiPolicy', () => {
  it('falls back to defaults when no record exists', () => {
    expect(resolveWikiPolicy(null)).toEqual(DEFAULT_WIKI_POLICY)
  })

  it('fills only the missing fields of a partial record', () => {
    const resolved = resolveWikiPolicy({
      uri: 'at://x',
      cid: 'c',
      wikiRef: WIKI_REF,
      createdAt: '2026-01-01T00:00:00.000Z',
      editAccess: 'anyone',
    })
    expect(resolved.editAccess).toBe('anyone')
    expect(resolved.imageMode).toBe(DEFAULT_WIKI_POLICY.imageMode)
  })
})

describe('resolveViewerCapabilities', () => {
  it('gives the owner everything', () => {
    const result = caps({ viewerDid: OWNER })
    expect(result.canPublish).toBe(true)
    expect(result.canManageWiki).toBe(true)
    expect(result.canRead).toBe(true)
  })

  it('keeps default behaviour for the default policy: members suggest, public reads', () => {
    const member = caps({ memberRole: 'contributor' })
    expect(member.canSuggest).toBe(true)
    expect(member.canPublish).toBe(false)
    expect(member.imageMode).toBe('any')

    const stranger = caps()
    expect(stranger.canSuggest).toBe(false)
    expect(stranger.canRead).toBe(true)
  })

  it('opens contributions to followers only when the owner follows them', () => {
    const policy = { ...DEFAULT_WIKI_POLICY, editAccess: 'followers' as const }
    expect(caps({ policy }).canSuggest).toBe(false)
    expect(caps({ policy, ownerFollowsViewer: true }).canSuggest).toBe(true)
  })

  it('opens contributions to anyone when the policy says so', () => {
    const policy = { ...DEFAULT_WIKI_POLICY, editAccess: 'anyone' as const }
    expect(caps({ policy }).canSuggest).toBe(true)
  })

  it('can disable the edit-on-approval queue entirely', () => {
    const policy = { ...DEFAULT_WIKI_POLICY, editAccess: 'anyone' as const, suggestionsEnabled: false }
    expect(caps({ policy }).canSuggest).toBe(false)
  })

  it('carries the image ladder for public contributors', () => {
    const policy = {
      ...DEFAULT_WIKI_POLICY,
      editAccess: 'anyone' as const,
      imageMode: 'none' as const,
      imageSubmissions: true,
    }
    const result = caps({ policy })
    expect(result.imageMode).toBe('none')
    expect(result.canSubmitImages).toBe(true)
  })

  it('locks strangers out of a private wiki', () => {
    const result = caps({ visibility: 'private' })
    expect(result.canRead).toBe(false)
    expect(result.canSuggest).toBe(false)
  })

  it('lets wiki admins manage but not publish', () => {
    const result = caps({ memberRole: 'admin' })
    expect(result.canManageWiki).toBe(true)
    expect(result.canPublish).toBe(false)
    expect(result.canSuggest).toBe(true)
  })

  it('stops at read-only for viewers', () => {
    const result = caps({ memberRole: 'viewer' })
    expect(result.canRead).toBe(true)
    expect(result.canSuggest).toBe(false)
  })
})

describe('withPageGrant', () => {
  function grant(role: LichenPageGrantRecord['role']): LichenPageGrantRecord {
    return {
      uri: 'at://did:plc:owner/wiki.pckt.pageGrant/1',
      cid: 'c',
      wikiRef: WIKI_REF,
      noteSlug: 'castle',
      memberDid: VIEWER,
      role,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
  }

  it('gives a suggester grant text-only proposing on an otherwise closed wiki', () => {
    const base = caps({ visibility: 'private' })
    const raised = withPageGrant(base, grant('suggester'), DEFAULT_WIKI_POLICY)
    expect(raised.canRead).toBe(true)
    expect(raised.canSuggest).toBe(true)
    expect(raised.imageMode).toBe('none')
    expect(raised.canPublish).toBe(false)
  })

  it('gives an editor grant the wiki image settings', () => {
    const policy = { ...DEFAULT_WIKI_POLICY, imageMode: 'approved' as const }
    const base = caps({ visibility: 'private' })
    const raised = withPageGrant(base, grant('editor'), policy)
    expect(raised.canSuggest).toBe(true)
    expect(raised.imageMode).toBe('approved')
  })

  it('never promotes a grant above publish or wiki management', () => {
    const raised = withPageGrant(caps(), grant('admin'), DEFAULT_WIKI_POLICY)
    expect(raised.canPublish).toBe(false)
    expect(raised.canManageWiki).toBe(false)
    expect(raised.canReviewPage).toBe(true)
  })

  it('a viewer grant only opens read access', () => {
    const base = caps({ visibility: 'private' })
    const raised = withPageGrant(base, grant('viewer'), DEFAULT_WIKI_POLICY)
    expect(raised.canRead).toBe(true)
    expect(raised.canSuggest).toBe(false)
  })
})

describe('findPageGrant', () => {
  it('matches wiki, slug, and member', () => {
    const grants: LichenPageGrantRecord[] = [
      {
        uri: 'at://did:plc:owner/wiki.pckt.pageGrant/1',
        cid: 'c',
        wikiRef: WIKI_REF,
        noteSlug: 'castle',
        memberDid: VIEWER,
        role: 'editor',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        uri: 'at://did:plc:owner/wiki.pckt.pageGrant/2',
        cid: 'c',
        wikiRef: WIKI_REF,
        noteSlug: 'castle',
        memberDid: 'did:plc:other',
        role: 'editor',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    expect(findPageGrant(grants, WIKI_REF, 'castle', VIEWER)?.uri).toContain('/1')
    expect(findPageGrant(grants, WIKI_REF, 'home', VIEWER)).toBeNull()
    expect(findPageGrant(grants, WIKI_REF, 'castle', null)).toBeNull()
  })
})

describe('resolveForumCapabilities', () => {
  const base = { ...DEFAULT_WIKI_POLICY }

  it('defaults: forum on, anyone signed in can start threads', () => {
    const caps = resolveForumCapabilities({
      policy: base,
      ownerDid: OWNER,
      viewerDid: VIEWER,
      memberRole: null,
    })
    expect(caps.enabled).toBe(true)
    expect(caps.canStartThreads).toBe(true)
    expect(caps.canModerate).toBe(false)
  })

  it('guests cannot start threads even when anyone can', () => {
    expect(
      resolveForumCapabilities({
        policy: base,
        ownerDid: OWNER,
        viewerDid: null,
        memberRole: null,
      }).canStartThreads,
    ).toBe(false)
  })

  it('owner always moderates', () => {
    const caps = resolveForumCapabilities({
      policy: base,
      ownerDid: OWNER,
      viewerDid: OWNER,
      memberRole: null,
    })
    expect(caps.canModerate).toBe(true)
    expect(caps.canStartThreads).toBe(true)
  })

  it('permitted mode: members may start threads, strangers may not', () => {
    const policy = { ...base, forumThreads: 'permitted' as const }
    expect(
      resolveForumCapabilities({ policy, ownerDid: OWNER, viewerDid: VIEWER, memberRole: 'viewer' })
        .canStartThreads,
    ).toBe(true)
    expect(
      resolveForumCapabilities({ policy, ownerDid: OWNER, viewerDid: VIEWER, memberRole: null })
        .canStartThreads,
    ).toBe(false)
  })

  it('forum mods moderate and start threads under permitted mode', () => {
    const policy = { ...base, forumThreads: 'permitted' as const, forumMods: [VIEWER] }
    const caps = resolveForumCapabilities({
      policy,
      ownerDid: OWNER,
      viewerDid: VIEWER,
      memberRole: null,
    })
    expect(caps.canModerate).toBe(true)
    expect(caps.canStartThreads).toBe(true)
  })

  it('membership admins moderate too', () => {
    expect(
      resolveForumCapabilities({ policy: base, ownerDid: OWNER, viewerDid: VIEWER, memberRole: 'admin' })
        .canModerate,
    ).toBe(true)
  })

  it('disabled forum turns everything off for everyone', () => {
    const policy = { ...base, forumEnabled: false, forumMods: [VIEWER] }
    const caps = resolveForumCapabilities({
      policy,
      ownerDid: OWNER,
      viewerDid: VIEWER,
      memberRole: 'admin',
    })
    expect(caps.enabled).toBe(false)
    expect(caps.canStartThreads).toBe(false)
    expect(caps.canModerate).toBe(true)
  })
})

describe('image policy checks', () => {
  const approved: LichenApprovedMediaRecord[] = [
    {
      uri: 'at://did:plc:owner/wiki.pckt.approvedMedia/1',
      cid: 'c',
      wikiRef: WIKI_REF,
      imageCid: 'bafy-approved',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ]

  it('extracts blob and https embeds from markdown', () => {
    const embeds = extractImageEmbeds(
      '![a](blob:bafy-one "left") and ![b](https://example.com/x.png)',
    )
    expect(embeds).toEqual([
      { cid: 'bafy-one', url: null },
      { cid: null, url: 'https://example.com/x.png' },
    ])
  })

  it('allows anything when the policy is "any"', () => {
    expect(
      findDisallowedImages('', '![x](blob:bafy-nope)', approved, 'any'),
    ).toEqual([])
  })

  it('blocks new unapproved blobs in approved-only mode', () => {
    const disallowed = findDisallowedImages(
      '',
      '![ok](blob:bafy-approved) ![nope](blob:bafy-nope)',
      approved,
      'approved',
    )
    expect(disallowed).toEqual([{ cid: 'bafy-nope', url: null }])
  })

  it('passes approved blobs through', () => {
    expect(
      findDisallowedImages('', '![ok](blob:bafy-approved)', approved, 'approved'),
    ).toEqual([])
  })

  it('blocks new images in text-only mode but not pre-existing ones', () => {
    const old = '![kept](blob:bafy-kept)'
    expect(findDisallowedImages(old, old, approved, 'none')).toEqual([])
    expect(
      findDisallowedImages(old, `${old}\n![new](blob:bafy-new)`, approved, 'none'),
    ).toEqual([{ cid: 'bafy-new', url: null }])
  })

  it('lets remote https URLs through to the review queue', () => {
    expect(
      findDisallowedImages('', '![x](https://example.com/x.png)', approved, 'approved'),
    ).toEqual([])
  })
})
