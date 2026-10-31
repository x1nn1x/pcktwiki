/**
 * Record types this app reads and writes.
 *
 * The `wiki.lichen.*` entries are Lichen's own lexicons, mirrored verbatim from
 * upstream — writing them is what makes a wiki created here readable in
 * lichen.wiki and anything else on those records. Nothing pckt-specific belongs
 * in that namespace: an NSID's authority is the project that defines it, so
 * inventing a `wiki.lichen.*` type would be squatting a namespace we don't own
 * and would collide if Lichen later defined the same name differently.
 *
 * Record types pckt.wiki invented live under `wiki.pckt.*` instead.
 */
export const COLLECTIONS = {
  // Lichen's lexicons — see https://tangled.org/juprodh.me/lichen.wiki
  wiki: 'wiki.lichen.wiki',
  note: 'wiki.lichen.note',
  noteRevision: 'wiki.lichen.noteRevision',
  membership: 'wiki.lichen.membership',
  memberRequest: 'wiki.lichen.memberRequest',
  // Ours. Lichen defines no equivalent.
  bookmark: 'wiki.pckt.bookmark',
  mapProgress: 'wiki.pckt.mapProgress',
  policy: 'wiki.pckt.policy',
  pageGrant: 'wiki.pckt.pageGrant',
  suggestion: 'wiki.pckt.suggestion',
  approvedMedia: 'wiki.pckt.approvedMedia',
  dockButton: 'wiki.pckt.dockButton',
  dockItem: 'wiki.pckt.dockItem',
  forumTopic: 'wiki.pckt.forumTopic',
} as const

// `include:wiki.pckt.permissions` needs a resolvable lexicon at
// `_lexicon.pckt.wiki` — add it back once that domain's TXT + schema are live.
export const OAUTH_SCOPE =
  'atproto transition:generic include:wiki.lichen.permissions blob:*/*'

export type MemberRole = 'admin' | 'contributor' | 'viewer'
export type WikiVisibility = 'public' | 'private'
export type AccessLevel = 'none' | 'read' | 'edit' | 'admin'

export function normalizeRole(raw: string | null | undefined): MemberRole {
  if (raw === 'admin' || raw === 'viewer') return raw
  return 'contributor'
}

export function getAccessLevel(
  wikiOwnerDid: string,
  wikiVisibility: WikiVisibility,
  userDid: string | null,
  memberRole: MemberRole | null,
): AccessLevel {
  if (userDid && wikiOwnerDid === userDid) return 'admin'
  if (memberRole === 'admin') return 'admin'
  if (memberRole === 'contributor') return 'edit'
  if (wikiVisibility === 'public') return 'read'
  if (memberRole === 'viewer') return 'read'
  return 'none'
}

/**
 * Label for a wiki's visibility. `private` is deliberately shown as "unlisted":
 * it hides the wiki within the app but the underlying records stay fetchable
 * from the repo, so calling it private would promise confidentiality that
 * nothing enforces.
 */
export function visibilityLabel(visibility: WikiVisibility): string {
  return visibility === 'private' ? 'unlisted' : 'public'
}

export function canRead(level: AccessLevel): boolean {
  return level !== 'none'
}

export function canEdit(level: AccessLevel): boolean {
  return level === 'edit' || level === 'admin'
}

export function canManage(level: AccessLevel): boolean {
  return level === 'admin'
}
