import {
  AtprotoDohHandleResolver,
  type HandleResolver,
} from '@atproto/oauth-client-browser'
import { buildAtprotoLoopbackClientMetadata } from '@atproto/oauth-types'
// Single source for the scope — vite.config.ts reads the same constant when it
// generates client-metadata.json, so the served document and the request the
// app makes cannot drift apart (the PDS compares them and fails the
// authorization outright on a mismatch).
import { OAUTH_SCOPE } from '@/lib/lichen/collections'

export function normalizeHandle(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('@')) return trimmed.slice(1)
  return trimmed
}

/**
 * Where this build is deployed — a custom domain, or a GitHub Pages project
 * page served under a subpath. Set at build time from VITE_SITE_URL, which also
 * generates the matching client-metadata.json; the two are the same string by
 * construction, and the PDS rejects the login if they ever disagree.
 */
const SITE_URL = __SITE_URL__
const PRODUCTION_CLIENT_ID = `${SITE_URL}client-metadata.json`
const PRODUCTION_REDIRECT_URI = SITE_URL

/**
 * The redirect URI to finish a sign-in on. A custom-domain handle shares the
 * canonical client-metadata.json, which lists every allowed origin; pick the
 * one matching the page the user is actually on.
 */
function currentRedirectUri(): string {
  if (typeof window === 'undefined') return PRODUCTION_REDIRECT_URI
  const origin = window.location.origin
  return (
    __OAUTH_REDIRECT_URIS__.find((uri) => {
      try {
        return new URL(uri).origin === origin
      } catch {
        return false
      }
    }) ?? PRODUCTION_REDIRECT_URI
  )
}

/** DNS-over-HTTPS resolver — works for handles on any PDS, including custom domains. */
let handleResolver: HandleResolver | null = null

export function getHandleResolver(): HandleResolver {
  if (!handleResolver) {
    handleResolver = new AtprotoDohHandleResolver({
      dohEndpoint: 'https://dns.google/resolve',
    })
  }
  return handleResolver
}

export function getOAuthConfig() {
  const isDev = import.meta.env.DEV
  if (isDev) {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:5173'
    return {
      clientId: origin,
      redirectUri: `${origin}${import.meta.env.BASE_URL}`,
    }
  }

  return {
    clientId: PRODUCTION_CLIENT_ID,
    redirectUri: currentRedirectUri(),
  }
}

/**
 * Loopback OAuth metadata for local dev. No client-metadata.json is fetched over
 * the network, so dev works without any deployment URL configured.
 */
export function getDevLoopbackClientMetadata() {
  const { redirectUri } = getOAuthConfig()
  return buildAtprotoLoopbackClientMetadata({
    redirect_uris: [redirectUri],
    scope: OAUTH_SCOPE,
  })
}

export function parsePcktBlogUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('pckt.blog')) return null
    return parsed.toString()
  } catch {
    return null
  }
}
