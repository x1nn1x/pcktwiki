import type {
  LichenApprovedMediaRecord,
  LichenPageGrantRecord,
  LichenPolicyRecord,
  WikiEditAccess,
  WikiImageMode,
} from '@/types/lichen'
import type { MemberRole, WikiVisibility } from '@/lib/lichen/collections'

/**
 * Collaboration capability resolution for pckt-specific permissions
 * (`wiki.pckt.policy` + `wiki.pckt.pageGrant`).
 *
 * The overriding platform fact: AT Protocol repos are single-writer, and every
 * wiki record lives in the wiki owner's repo. Only the owner can publish
 * revisions there. Everyone else contributes through `wiki.pckt.suggestion`
 * records in their own repo, which the owner reviews and publishes — so
 * "can edit" for non-owners means "can propose edits for review".
 */

export interface ResolvedWikiPolicy {
  editAccess: WikiEditAccess
  suggestionsEnabled: boolean
  imageMode: WikiImageMode
  imageSubmissions: boolean
  forumEnabled: boolean
  forumThreads: 'anyone' | 'permitted'
  forumMods: string[]
  forumHiddenPosts: string[]
}

export const DEFAULT_WIKI_POLICY: ResolvedWikiPolicy = {
  editAccess: 'members',
  suggestionsEnabled: true,
  imageMode: 'any',
  imageSubmissions: false,
  forumEnabled: true,
  forumThreads: 'anyone',
  forumMods: [],
  forumHiddenPosts: [],
}

/** Fill gaps in a (possibly absent) policy record with documented defaults. */
export function resolveWikiPolicy(record: LichenPolicyRecord | null | undefined): ResolvedWikiPolicy {
  if (!record) return { ...DEFAULT_WIKI_POLICY }
  return {
    editAccess: record.editAccess ?? DEFAULT_WIKI_POLICY.editAccess,
    suggestionsEnabled: record.suggestionsEnabled ?? DEFAULT_WIKI_POLICY.suggestionsEnabled,
    imageMode: record.imageMode ?? DEFAULT_WIKI_POLICY.imageMode,
    imageSubmissions: record.imageSubmissions ?? DEFAULT_WIKI_POLICY.imageSubmissions,
    forumEnabled: record.forumEnabled ?? DEFAULT_WIKI_POLICY.forumEnabled,
    forumThreads: record.forumThreads ?? DEFAULT_WIKI_POLICY.forumThreads,
    forumMods: record.forumMods ?? DEFAULT_WIKI_POLICY.forumMods,
    forumHiddenPosts: record.forumHiddenPosts ?? DEFAULT_WIKI_POLICY.forumHiddenPosts,
  }
}

export interface ForumCapabilities {
  /** Whether the wiki's forum renders at all. */
  enabled: boolean
  /** Whether this viewer may start new threads (replies are separate). */
  canStartThreads: boolean
  /** Owner, forum mod, or wiki admin membership — can hide posts. */
  canModerate: boolean
}

/**
 * Forum rights for one viewer. Thread-starting under 'permitted' belongs to
 * the owner, forum mods, and anyone holding a wiki membership — joining the
 * wiki is the permit. Hiding is the wiki's presentation layer; the underlying
 * Bluesky posts always remain in their authors' repos.
 */
export function resolveForumCapabilities(input: {
  policy: ResolvedWikiPolicy
  ownerDid: string
  viewerDid: string | null
  /** Viewer's wiki membership role, when any. */
  memberRole: MemberRole | null
}): ForumCapabilities {
  const { policy, ownerDid, viewerDid, memberRole } = input
  const isOwner = !!viewerDid && viewerDid === ownerDid
  const isMod = !!viewerDid && policy.forumMods.includes(viewerDid)
  const isWikiAdmin = memberRole === 'admin'
  const permitted = isOwner || isMod || memberRole !== null
  return {
    enabled: policy.forumEnabled,
    canStartThreads:
      policy.forumEnabled && (!!viewerDid && (policy.forumThreads === 'anyone' || permitted)),
    canModerate: isOwner || isMod || isWikiAdmin,
  }
}

export interface WikiCapabilities {
  canRead: boolean
  /** Can write revisions directly to the wiki's repo — the owner only. */
  canPublish: boolean
  /** Can propose edits and photo submissions for the review queue. */
  canSuggest: boolean
  /** Image embedding level this viewer gets when contributing. */
  imageMode: WikiImageMode
  /** Can submit photos to the approved-media queue. */
  canSubmitImages: boolean
  /** Wiki-wide settings, members, and the review queue. */
  canManageWiki: boolean
  /** Can review suggestions for a specific article (via page grant). */
  canReviewPage: boolean
}

function fullForOwner(): WikiCapabilities {
  return {
    canRead: true,
    canPublish: true,
    canSuggest: false,
    imageMode: 'any',
    canSubmitImages: true,
    canManageWiki: true,
    canReviewPage: true,
  }
}

function contributorCaps(
  canRead: boolean,
  policy: ResolvedWikiPolicy,
  imageMode: WikiImageMode,
  canSubmitImages: boolean,
): WikiCapabilities {
  return {
    canRead,
    canPublish: false,
    canSuggest: canRead && policy.suggestionsEnabled,
    imageMode,
    canSubmitImages: canRead && canSubmitImages,
    canManageWiki: false,
    canReviewPage: false,
  }
}

function readOnlyCaps(canRead: boolean): WikiCapabilities {
  return {
    canRead,
    canPublish: false,
    canSuggest: false,
    imageMode: 'none',
    canSubmitImages: false,
    canManageWiki: false,
    canReviewPage: false,
  }
}

export interface CapabilityInput {
  ownerDid: string
  visibility: WikiVisibility
  viewerDid: string | null
  memberRole: MemberRole | null
  policy: ResolvedWikiPolicy
  /** Whether the wiki owner follows the viewer (`editAccess: 'followers'`). */
  ownerFollowsViewer: boolean
}

/**
 * Wiki-wide capabilities for a viewer. Per-article overrides are layered on by
 * `withPageGrant` using the grant that matches the article being viewed.
 */
export function resolveViewerCapabilities(input: CapabilityInput): WikiCapabilities {
  const { ownerDid, visibility, viewerDid, memberRole, policy, ownerFollowsViewer } = input

  if (viewerDid && viewerDid === ownerDid) return fullForOwner()

  // Membership is the backbone: role grants read on private wikis and sets
  // the contributor tier. Members are trusted with the wiki's own image
  // settings; admins additionally manage the wiki and review its queue.
  if (memberRole === 'admin') {
    return { ...contributorCaps(true, policy, 'any', true), canManageWiki: true, canReviewPage: true }
  }
  if (memberRole === 'contributor') {
    return contributorCaps(true, policy, policy.imageMode, policy.imageSubmissions)
  }
  if (memberRole === 'viewer') {
    return readOnlyCaps(true)
  }

  const isPublic = visibility === 'public'
  const canRead = isPublic

  // Non-members contribute only when the policy opens the door. Direct
  // publishing is impossible for them (single-writer repos), so they always
  // land in the review queue.
  const editAllowed =
    policy.editAccess === 'anyone' ||
    (policy.editAccess === 'followers' && !!viewerDid && ownerFollowsViewer)

  if (editAllowed) {
    return contributorCaps(canRead, policy, policy.imageMode, policy.imageSubmissions)
  }

  return readOnlyCaps(canRead)
}

/**
 * Layer a per-article grant on top of the wiki-wide picture. A grant can open
 * access the wiki-wide policy closes (e.g. a suggester slot on a private
 * wiki), but never publishes, manages the wiki, or raises the image tier
 * above what the wiki's policy allows for contributors — except that trusted
 * per-article admins keep full image rights.
 */
export function withPageGrant(
  caps: WikiCapabilities,
  grant: LichenPageGrantRecord | null | undefined,
  policy: ResolvedWikiPolicy,
): WikiCapabilities {
  if (!grant) return caps

  const wasLockedOut = !caps.canRead

  switch (grant.role) {
    case 'viewer':
      // A viewer grant only opens read access the wiki-wide picture closed.
      return wasLockedOut ? readOnlyCaps(true) : caps
    case 'suggester':
      return {
        ...contributorCaps(true, policy, 'none', false),
        canManageWiki: caps.canManageWiki,
        canReviewPage: caps.canReviewPage,
      }
    case 'editor':
      return {
        ...contributorCaps(true, policy, policy.imageMode, policy.imageSubmissions),
        canManageWiki: caps.canManageWiki,
        canReviewPage: caps.canReviewPage,
      }
    case 'admin':
      return {
        ...contributorCaps(true, policy, 'any', true),
        canManageWiki: caps.canManageWiki,
        canReviewPage: true,
      }
  }
}

// ---------------------------------------------------------------------------
// Image validation for the approved-photos ladder
// ---------------------------------------------------------------------------

export interface ImageEmbed {
  /** `blob:CID` when the image is an AT Proto blob reference. */
  cid: string | null
  /** https URL or root-relative site asset, when not a blob ref. */
  url: string | null
}

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g

/** Pull every image embed out of wiki markdown content. */
export function extractImageEmbeds(content: string): ImageEmbed[] {
  const embeds: ImageEmbed[] = []
  const re = new RegExp(MARKDOWN_IMAGE_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const raw = match[1] ?? ''
    if (raw.startsWith('blob:') && !raw.includes('://')) {
      embeds.push({ cid: raw.slice('blob:'.length) || null, url: null })
    } else {
      embeds.push({ cid: null, url: raw })
    }
  }
  return embeds
}

/** Approved blob CIDs for quick membership checks. */
export function approvedCidSet(media: LichenApprovedMediaRecord[]): Set<string> {
  return new Set(media.map((item) => item.imageCid).filter(Boolean))
}

/**
 * Images a contributor newly added that the wiki's policy disallows.
 *
 * Only *new* embeds are checked, so existing images in an article do not block
 * a text edit. Blob embeds must appear in the approved-media registry when the
 * policy is 'approved'. Remote https URLs pass the client-side check either
 * way — they cannot be pre-approved by CID, and the review queue is the
 * enforcement point before anything reaches the published wiki.
 */
export function findDisallowedImages(
  oldContent: string,
  newContent: string,
  approved: LichenApprovedMediaRecord[],
  imageMode: WikiImageMode,
): ImageEmbed[] {
  if (imageMode === 'any') return []
  if (oldContent === newContent) return []

  const before = new Set(extractImageEmbeds(oldContent).map((item) => item.cid ?? item.url ?? ''))
  const approvedCids = approvedCidSet(approved)

  const disallowed: ImageEmbed[] = []
  for (const embed of extractImageEmbeds(newContent)) {
    const key = embed.cid ?? embed.url ?? ''
    if (!key || before.has(key)) continue
    if (embed.cid) {
      if (imageMode === 'approved' && approvedCids.has(embed.cid)) continue
    } else if (/^https?:\/\//i.test(embed.url ?? '')) {
      continue
    }
    disallowed.push(embed)
  }
  return disallowed
}

// ---------------------------------------------------------------------------
// Page grant lookup
// ---------------------------------------------------------------------------

/** The viewer's grant for one article, if any. */
export function findPageGrant(
  grants: LichenPageGrantRecord[],
  wikiRef: string,
  noteSlug: string,
  viewerDid: string | null,
): LichenPageGrantRecord | null {
  if (!viewerDid) return null
  return (
    grants.find(
      (grant) =>
        grant.wikiRef === wikiRef &&
        grant.noteSlug === noteSlug &&
        grant.memberDid === viewerDid,
    ) ?? null
  )
}
