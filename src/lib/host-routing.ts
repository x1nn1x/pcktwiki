/**
 * Username subdomains.
 *
 * `oseanstudio.allour.wiki` is the same app, scoped to the wikis of
 * `oseanstudio.bsky.social`. The edge (see `infra/allour-subdomains`) proxies the
 * subdomain to the normal origin, so the rewrite has to happen here: a proxy
 * cannot change the path the SPA router sees in `location`.
 */

/** Apex domains that serve username subdomains. */
const SUBDOMAIN_ROOTS = ['allour.wiki', 'pckt.wiki']

/** Infrastructure labels that must keep their normal meaning. */
const RESERVED_LABELS = new Set(['www', 'app', 'api', 'assets', 'static', 'cdn'])

/** App routes that are not wiki slugs when they appear first in the path. */
const TOP_LEVEL_ROUTES = new Set([
  'learn',
  'wikis',
  'explore',
  'faq',
  'donate',
  'search',
  'library',
  'feed',
  'draft',
  'dashboard',
  'wiki',
  'dock-button',
])

/**
 * The path to rewrite to for a username-subdomain request, or `null` when the
 * host is an apex/infrastructure host or the path needs no change.
 */
export function resolveHostRedirect(hostname: string, pathname: string): string | null {
  const host = hostname.toLowerCase()
  const root = SUBDOMAIN_ROOTS.find((domain) => host.endsWith(`.${domain}`))
  if (!root) return null

  const label = host.slice(0, -(root.length + 1))
  if (!label || label.includes('.') || RESERVED_LABELS.has(label)) return null

  const path = pathname || '/'
  if (path === '/') return `/by/${label}`
  if (path.startsWith('/@') || path.startsWith('/by/')) return null

  const first = path.split('/')[1]?.toLowerCase() ?? ''
  if (!first || TOP_LEVEL_ROUTES.has(first)) return null

  // `/my-wiki/article` is that user's wiki, not an app page. Keep the label:
  // a custom-domain handle (mfzx.net) can only be resolved through the public
  // directory, which is async, so the router handles the hop to /@handle/...
  return `/by/${label}${path}`
}

/** Rewrite the address bar before the router reads the initial location. */
export function applyHostRouting(): void {
  if (typeof window === 'undefined') return
  const target = resolveHostRedirect(window.location.hostname, window.location.pathname)
  if (!target) return
  window.history.replaceState(
    null,
    '',
    `${target}${window.location.search}${window.location.hash}`,
  )
}
