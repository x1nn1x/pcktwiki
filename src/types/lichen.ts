export type WikiVisibility = 'public' | 'private'
export type MemberRole = 'admin' | 'contributor' | 'viewer'

/** Who may contribute edits to a wiki, beyond the owner and members. */
export type WikiEditAccess = 'members' | 'followers' | 'anyone'
/**
 * What images non-owner contributors may embed. `none` restricts them to
 * text-only edits; `approved` restricts embeds to the wiki's approved-media
 * registry; `any` allows uploading new blobs.
 */
export type WikiImageMode = 'any' | 'approved' | 'none'
/** Per-article role granted by a `wiki.pckt.pageGrant`. */
export type PageGrantRole = 'admin' | 'editor' | 'suggester' | 'viewer'
export type SuggestionKind = 'edit' | 'image'
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

/**
 * Collaboration policy for one wiki (`wiki.pckt.policy`). Fields are optional
 * so a partial record falls back to `DEFAULT_WIKI_POLICY` per field.
 */
export type ForumThreadAccess = 'anyone' | 'permitted'

export interface LichenPolicyRecord {
  uri: string
  cid: string
  wikiRef: string
  createdAt: string
  editAccess?: WikiEditAccess
  suggestionsEnabled?: boolean
  imageMode?: WikiImageMode
  imageSubmissions?: boolean
  forumEnabled?: boolean
  forumThreads?: ForumThreadAccess
  /** DIDs of forum moderators (hide topics/posts from this wiki's forum). */
  forumMods?: string[]
  /** AT-URIs of posts hidden from this wiki's forum. */
  forumHiddenPosts?: string[]
}

export interface LichenPageGrantRecord {
  uri: string
  cid: string
  wikiRef: string
  noteSlug: string
  memberDid: string
  role: PageGrantRole
  createdAt: string
}

export interface LichenSuggestionRecord {
  uri: string
  cid: string
  /** DID of the author (repo that holds the record). */
  authorDid: string
  wikiRef: string
  noteSlug: string
  kind: SuggestionKind
  /** Full proposed article content, for kind 'edit'. */
  content?: string
  title?: string
  baseRevision?: string
  message?: string
  /** Submitted photos, for kind 'image' (author's own blobs). */
  blobs?: unknown[]
  alt?: string
  status?: SuggestionStatus
  createdAt: string
}

export interface LichenApprovedMediaRecord {
  uri: string
  cid: string
  wikiRef: string
  /** Blob CID in the wiki owner's repo, as referenced by `blob:CID` embeds. */
  imageCid: string
  blob?: unknown
  mimeType?: string
  alt?: string
  addedBy?: string
  source?: 'owner' | 'submission'
  createdAt: string
}

/**
 * An ATProto blob reference as stored on a record. Read from the PDS it may be a
 * `BlobRef` instance or plain JSON (`{ $type: 'blob', ref: { $link }, mimeType, size }`).
 * We preserve the raw value so it can be written back unchanged.
 */
export type LichenBlobRef = unknown

export interface LichenHeaderLink {
  label: string
  /**
   * Internal note slug/path, or an absolute URL (http/https/mailto). Empty when
   * the link has no destination yet — it still renders, as a plain label.
   */
  url: string
  /** Optional icon image, stored as an ATProto blob. */
  image?: LichenBlobRef
}

/** Top navbar text link (no icon). */
export interface LichenNavLink {
  label: string
  /** Internal note slug/path, or an absolute URL (http/https/mailto). */
  url: string
}

export interface LichenWikiRecord {
  uri: string
  cid: string
  slug: string
  ownerDid: string
  name: string
  visibility: WikiVisibility
  language: string
  description?: string
  theme?: 'light' | 'dark'
  /** Accent colour for links and highlights, as a CSS hex value. */
  accentColor?: string
  /** Page background colour. */
  bgColor?: string
  /** Article card / elevated surface colour. */
  cardColor?: string
  /** Sidebar surface colour. */
  sidebarColor?: string
  /** App header / nav chrome colour. */
  headerColor?: string
  /** Content font family name. */
  fontFamily?: string
  /** Reading column width for wiki content. */
  layoutWidth?: 'narrow' | 'medium' | 'wide'
  createdAt: string
  /** AT-URI of the source wiki.lichen.wiki record this wiki was forked from. */
  forkedFrom?: string
  /** When this wiki was forked from its source. */
  forkedAt?: string
  /** Illustrated navigation links shown at the top of wiki pages. */
  headerLinks?: LichenHeaderLink[]
  /** Text links shown in the app top navbar while viewing this wiki. */
  navbarLinks?: LichenNavLink[]
  /** Ordered note slugs for the left sidebar. When set, only these are shown. */
  sidebarOrder?: string[]
  /** Optional header logo shown in place of the default pckt wordmark. */
  headerImage?: LichenBlobRef
  /** When set, the wiki is in trash and should be hidden from normal views. */
  deletedAt?: string
  /** Visibility before soft-delete; restored on undelete. */
  deletedFromVisibility?: WikiVisibility
  /** If set, this slug is a redirect stub pointing at another slug owned by the same DID. */
  redirectSlug?: string
}

export interface LichenNoteRecord {
  uri: string
  cid: string
  slug: string
  title: string
  /**
   * Optional sidebar / quick-nav label. When absent, UI falls back to `title`
   * so the page H1 can stay long while the nav button stays short.
   */
  navTitle?: string
  wikiRef: string
  createdAt: string
  /** Page-specific subheader links shown under the page title. */
  subheaderLinks?: LichenHeaderLink[]
}

export interface LichenNoteWithContent extends LichenNoteRecord {
  content: string
  latestRevisionUri: string | null
  /**
   * How many of this note's revisions could not be replayed since the last
   * authoritative snapshot. Above zero, the live content is missing those edits.
   */
  damagedRevisions?: number
  /** URIs of revisions that could not be replayed (same set as the count). */
  damagedRevisionUris?: string[]
}

export interface LichenRevisionRecord {
  /**
   * Full note text as of this revision, written periodically. Replay re-anchors
   * to it, so a diff that will not apply can only cost the edits since the last
   * snapshot rather than everything after it. Absent on most revisions.
   */
  snapshot?: string
  uri: string
  cid: string
  noteRef: string
  parentRevision?: string
  diff: string
  diffFormat: string
  message?: string
  createdAt: string
}

export interface LichenMembershipRecord {
  uri: string
  cid: string
  memberDid: string
  wikiRef: string
  role: MemberRole
  createdAt: string
}

export interface LichenMemberRequestRecord {
  uri: string
  cid: string
  /** DID of the requester (repo that holds the record). */
  requesterDid: string
  wikiRef: string
  createdAt: string
}

export interface StandardSiteDocument {
  uri: string
  cid: string
  title?: string
  path?: string
  description?: string
  content?: string
  publishedAt?: string
  updatedAt?: string
}

export interface StandardSitePublication {
  uri: string
  name?: string
  description?: string
  url?: string
}

export interface ActorProfile {
  displayName?: string
  description?: string
  avatar?: string
  handle?: string
}

export interface PcktTheme {
  accentColor?: string
  bgColor?: string
  cardColor?: string
  sidebarColor?: string
  headerColor?: string
  fontFamily?: string
  mode?: 'light' | 'dark' | 'auto'
  layoutWidth?: 'narrow' | 'medium' | 'wide'
}

export const STANDARD_PUBLICATION = 'site.standard.publication'
export const STANDARD_DOCUMENT = 'site.standard.document'

export const DEFAULT_PCKT_THEME: PcktTheme = {
  accentColor: '#ff5d5b',
  fontFamily: 'Lora',
  mode: 'auto',
  layoutWidth: 'medium',
}

export const FONT_OPTIONS = [
  'Lora',
  'Literata',
  'Newsreader',
  'Georgia',
  'system-ui',
] as const

export const ACCENT_PRESETS = [
  '#ff5d5b',
  '#58a7ff',
  '#21dc66',
  '#ffca46',
  '#111827',
  '#8b5cf6',
] as const

/** Neutral swatches for layout-region theming (bg / card / sidebar / header). */
export const SURFACE_PRESETS = [
  '#ffffff',
  '#f9fafb',
  '#f3f4f6',
  '#e5e7eb',
  '#1f2937',
  '#111827',
  '#f4ead8',
  '#0f172a',
] as const

export const PCKT_THEME_KEY = 'pckt.wiki.theme'

/** Theme fields stored on the wiki.lichen.wiki record. */
export type WikiThemeColors = Pick<
  PcktTheme,
  'accentColor' | 'bgColor' | 'cardColor' | 'sidebarColor' | 'headerColor'
>

export type ThemeRegion = 'bg' | 'card' | 'sidebar' | 'header' | 'accent'

export const THEME_REGION_FIELDS: Record<ThemeRegion, keyof WikiThemeColors> = {
  bg: 'bgColor',
  card: 'cardColor',
  sidebar: 'sidebarColor',
  header: 'headerColor',
  accent: 'accentColor',
}

export const THEME_REGION_LABELS: Record<ThemeRegion, string> = {
  bg: 'Page background',
  card: 'Article card',
  sidebar: 'Sidebars',
  header: 'Header / nav',
  accent: 'Accent / links',
}
