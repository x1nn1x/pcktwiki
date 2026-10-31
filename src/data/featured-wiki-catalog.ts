/**
 * Featured wiki catalog — add wikis with `handle/slug` paths (same as pckt.wiki URLs).
 *
 * Example: `'mfzx.net/at-protocol-paper-errata-and-details'`
 *
 * Names, descriptions, and article counts are fetched live from each wiki's PDS.
 * "Did you know" facts pull a sentence from a random article (including home).
 */

export const FEATURED_WIKI_HANDLES = [
  'juprodh.me/welcome-to-lichen',
  'mfzx.net/at-protocol-paper-errata-and-details',
  'stellapent.wiki/stellapent-cier-community-wiki',
  'rechargednintendo.eurosky.social/florets-retreat',
  'windfreaker.dev/digital-garden',
  'myrkvi.no/test',
  'oseanstudio.bsky.social/oseanworld',
] as const

export type FeaturedWikiHandle = (typeof FEATURED_WIKI_HANDLES)[number]

/**
 * Rotation pool for the "Featured wiki" box at the top of the portal — one is
 * picked at random on every load/refresh. Entries use the same `handle/slug`
 * form as the catalog above and are loaded even when absent from it.
 */
export const FEATURED_SPOTLIGHT_HANDLES = [
  'oseanstudio.bsky.social/oseanworld',
] as const
