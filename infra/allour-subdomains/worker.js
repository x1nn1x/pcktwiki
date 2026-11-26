/**
 * Cloudflare Worker: username subdomains for allour.wiki / pckt.wiki, plus
 * custom-domain handles such as joyboy.wiki.
 *
 * `oseanstudio.allour.wiki` is proxied to the normal origin at
 * `https://allour.wiki` with the same path. The app itself does the routing
 * (`src/lib/host-routing.ts`) because a proxy cannot change the path the
 * single-page app reads from `window.location`.
 *
 * Deploy instructions: ./README.md
 */

const APEX = {
  'allour.wiki': 'https://allour.wiki',
  'pckt.wiki': 'https://pckt.wiki',
}

/**
 * Custom-domain handles served at their own apex. The whole host is the handle
 * (`joyboy.wiki`), so the app rewrites `/` to `/by/joyboy.wiki`.
 */
const CUSTOM = {
  'joyboy.wiki': 'https://allour.wiki',
}

/** Labels that belong to infrastructure, not people. */
const RESERVED = new Set(['www', 'api', 'assets', 'static', 'cdn'])

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const host = url.hostname.toLowerCase()

    // A custom-domain handle: the whole host is the label.
    const customHost = host.startsWith('www.') ? host.slice(4) : host
    const customTarget = CUSTOM[customHost]
    if (customTarget) return proxy(request, url, customTarget, customHost)

    const apex = Object.keys(APEX).find((domain) => host.endsWith(`.${domain}`))
    if (!apex) return new Response('Not found', { status: 404 })

    const label = host.slice(0, -(apex.length + 1))
    if (!label || label.includes('.') || RESERVED.has(label)) {
      return new Response('Not found', { status: 404 })
    }

    return proxy(request, url, APEX[apex], label)
  },
}

async function proxy(request, url, targetOrigin, label) {
  const target = new URL(targetOrigin)
  target.pathname = url.pathname
  target.search = url.search

  const proxied = new Request(target.toString(), request)
  proxied.headers.set('X-Allour-Subdomain', label)

  const response = await fetch(proxied)

  // Keep redirects on the public host instead of leaking visitors to the apex.
  const location = response.headers.get('location')
  if (location && location.startsWith(targetOrigin)) {
    const rewritten = new Response(response.body, response)
    rewritten.headers.set(
      'location',
      location.replace(targetOrigin, `https://${url.hostname}`),
    )
    return rewritten
  }

  return response
}
