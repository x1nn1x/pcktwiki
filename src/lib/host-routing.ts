/**
 * Username subdomains and custom-domain handles.
 *
 * `oseanstudio.allour.wiki` is the same app, scoped to the wikis of
 * `oseanstudio.bsky.social`. A handle can also be a domain the user owns
 * (`joyboy.wiki`), proxied to this app by `infra/allour-subdomains`. Either way
 * the browser keeps the original host, so the rewrite has to happen here: a
 * proxy cannot change the path the SPA router sees in `location`.
 */

/** Apex domains that serve username subdomains. */
const SUBDOMAIN_ROOTS = ['allour.wiki', 'pckt.wiki']

/** Hosts that are the app itself, never a custom-domain handle. */
const APP_HOSTS = new Set([
  'allour.wiki',
  'pckt.wiki',
  'www.allour.wiki',
  'www.pckt.wiki',
  'localhost',
  '127.0.0.1',
])

/** Preview origins that are never a custom-domain handle. */
const NON_HANDLE_SUFFIXES = [
  '.github.io',
  '.pages.dev',
  '.workers.dev',
  '.vercel.app',
  '.netlify.app',
  '.onrender.com',
  '.fly.dev',
  '.local',
]

/** Infrastructure labels that must keep their normal meaning. */
const RESERVED_LABELS = new Set(['www', 'app', 'api', 'assets', 'static', 'cdn'])

/** App routes that are not wiki slugs when they appear first in the path. */
const TOP_LEVEL_ROUTES = new Set([
  'learn',
  'wikis',
  'explore',
  'faq',
  'donate',
  'store',
  'search',
  'library',
  'feed',
  'draft',
  'dashboard',
  'wiki',
  'dock-button',
])

/** The hostname this build was made for (`allour.wiki`, `user.github.io`, …). */
function siteHost(): string {
  try {
    return new URL(__SITE_URL__).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * Whether a host that is not a username subdomain should be treated as a
 * custom-domain handle. A host that is the build's own origin is the app, not a
 * handle — that keeps a fork deployed at `my.wiki` from rewriting its home page.
 * The proxy Worker only serves the custom domains it is configured for, so any
 * other host the app appears on is a handle, except known preview origins.
 */
function isCustomWikiHost(host: string): boolean {
  if (APP_HOSTS.has(host) || isIpAddress(host)) return false
  if (host === siteHost()) return false
  if (SUBDOMAIN_ROOTS.some((root) => host === root || host.endsWith(`.${root}`))) return false
  if (NON_HANDLE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  return host.includes('.')
}

/**
 * The `/by/...` path for one handle host, or `null` when the path is an app
 * route or already canonical.
 */
function rewriteForHandle(handle: string, pathname: string): string | null {
  const path = pathname || '/'
  if (path === '/') return `/by/${handle}`
  if (path.startsWith('/@') || path.startsWith('/by/')) return null

  const first = path.split('/')[1]?.toLowerCase() ?? ''
  if (!first || TOP_LEVEL_ROUTES.has(first)) return null

  // `/my-wiki/article` is that user's wiki, not an app page. Keep the handle:
  // the router resolves it through the async hop to /@handle/...
  return `/by/${handle}${path}`
}

/**
 * The path to rewrite to for a username-subdomain or custom-domain request, or
 * `null` when the host is an apex/infrastructure host or the path needs no
 * change.
 */
export function resolveHostRedirect(hostname: string, pathname: string): string | null {
  const host = hostname.toLowerCase()

  const root = SUBDOMAIN_ROOTS.find((domain) => host.endsWith(`.${domain}`))
  if (root) {
    const label = host.slice(0, -(root.length + 1))
    if (!label || label.includes('.') || RESERVED_LABELS.has(label)) return null
    return rewriteForHandle(label, pathname)
  }

  // `www.joyboy.wiki` and `joyboy.wiki` are the same handle.
  const handleHost = host.startsWith('www.') ? host.slice(4) : host
  if (!isCustomWikiHost(handleHost)) return null
  return rewriteForHandle(handleHost, pathname)
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
