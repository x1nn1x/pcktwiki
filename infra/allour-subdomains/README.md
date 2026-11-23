# Username subdomains: `oseanstudio.allour.wiki`

A request to `https://<label>.allour.wiki/` shows the wikis of the Bluesky
handle `<label>.bsky.social` (or a custom-domain handle whose first label
matches, such as `oseanstudio.com`).

Two pieces make this work:

1. **This Worker** proxies every `<label>.allour.wiki` request to
   `https://allour.wiki` with the same path. It exists because GitHub Pages
   serves one custom domain and cannot issue certificates for arbitrary
   subdomains on its own; Cloudflare's wildcard certificate can.
2. **The app** reads `window.location.hostname` before the router starts and
   rewrites:
   - `/` → `/by/<label>` (that person's wiki list)
   - `/<wiki>/<page>` → `/by/<label>/<wiki>/<page>`

   Deep links keep the label because it may name a custom-domain handle
   (`mfzx.net`). A redirect route resolves it — `<label>.bsky.social` first,
   then the public wiki directory — and continues to `/@<handle>/...`.

   See `src/lib/host-routing.ts`. The rewrite has to happen in the app: a
   proxy changes the upstream path but the browser still shows the original
   URL, and Vue Router reads the address bar.

## Setup

Assumes the zone (`allour.wiki`) is already on Cloudflare and the apex points
at the GitHub Pages site.

### 1. Wildcard DNS

Add a proxied record (orange cloud **on**):

| Type  | Name | Content        | Proxy  |
| ----- | ---- | -------------- | ------ |
| CNAME | `*`  | `allour.wiki`  | Proxied |

or, if the GitHub Pages custom domain is the target, `xox.github.io`.

The orange cloud is required: Cloudflare Universal SSL covers
`allour.wiki` and `*.allour.wiki`, but only for proxied records.

### 2. Deploy the Worker

Using the dashboard:

1. **Workers & Pages → Create → Worker**.
2. Paste `worker.js`, deploy.
3. **Settings → Domains & Routes → Add route**:
   `*.allour.wiki/*` (zone `allour.wiki`).
4. Repeat for `*.pckt.wiki/*` if that domain is also on the account.

Using Wrangler:

```sh
cd infra/allour-subdomains
npx wrangler deploy worker.js \
  --name allour-subdomains \
  --compatibility-date 2026-01-01 \
  --route '*.allour.wiki/*'
```

Add `--route '*.pckt.wiki/*'` as well if needed.

### 3. Verify

```sh
curl -sI https://oseanstudio.allour.wiki/ | head -5
curl -s  https://oseanstudio.allour.wiki/ | grep -o '<title>[^<]*</title>'
```

Open `https://oseanstudio.allour.wiki/` in a browser; it should show the
profile page for `@oseanstudio.bsky.social`. Deep links such as
`https://oseanstudio.allour.wiki/my-wiki/my-page` should open that user's
article.

## Caching notes

- The Worker returns the origin response untouched, so GitHub Pages' asset
  cache headers continue to apply per subdomain.
- Nothing is cached per label; two subdomains share the origin cache but not
  the browser cache, which is what you want because the app renders the
  profile client-side.
- If you later add a redirect from subdomains to the canonical `/@handle/...`
  URL, do it in `host-routing.ts`, not in the Worker, so the path survives.
