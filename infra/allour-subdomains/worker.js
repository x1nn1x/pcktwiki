/**
 * Cloudflare Worker: username subdomains for allour.wiki / pckt.wiki.
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

/** Labels that belong to infrastructure, not people. */
const RESERVED = new Set(['www', 'api', 'assets', 'static', 'cdn'])

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const host = url.hostname.toLowerCase()
    const apex = Object.keys(APEX).find((domain) => host.endsWith(`.${domain}`))
    if (!apex) return new Response('Not found', { status: 404 })

    const label = host.slice(0, -(apex.length + 1))
    if (!label || label.includes('.') || RESERVED.has(label)) {
      return new Response('Not found', { status: 404 })
    }

    const target = new URL(APEX[apex])
    target.pathname = url.pathname
    target.search = url.search

    const proxied = new Request(target.toString(), request)
    proxied.headers.set('X-Allour-Subdomain', label)

    const response = await fetch(proxied)

    // Keep redirects on the subdomain instead of leaking visitors to the apex.
    const location = response.headers.get('location')
    if (location && location.startsWith(APEX[apex])) {
      const rewritten = new Response(response.body, response)
      rewritten.headers.set(
        'location',
        location.replace(APEX[apex], `https://${host}`),
      )
      return rewritten
    }

    return response
  },
}
