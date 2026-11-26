# Username subdomains and custom-domain handles

Two kinds of host are served by this Worker:

- **Username subdomains** — `oseanstudio.allour.wiki` shows the wikis of
  `oseanstudio.bsky.social` (or a custom-domain handle whose first label
  matches, such as `oseanstudio.com`).
- **Custom-domain handles** — `joyboy.wiki` shows the wikis of `@joyboy.wiki`.
  The whole host is the handle; list it in `CUSTOM` in `worker.js`.

A request to either is proxied to `https://allour.wiki` with the same path. The
Worker exists because GitHub Pages serves one custom domain and cannot issue
certificates for arbitrary hosts on its own; Cloudflare's certificates can.

The app reads `window.location.hostname` before the router starts and rewrites:

- `/` → `/by/<label>` (that person's wiki list)
- `/<wiki>/<page>` → `/by/<label>/<wiki>/<page>`

Deep links keep the label because it may name a custom-domain handle
(`mfzx.net`). A redirect route resolves it — the handle itself first, then the
public wiki directory — and continues to `/@<handle>/...`.

See `src/lib/host-routing.ts`. The rewrite has to happen in the app: a proxy
changes the upstream path but the browser still shows the original URL, and Vue
Router reads the address bar.

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

### 3. Custom-domain handle (`joyboy.wiki`)

A domain a person owns can be their handle and their wiki host at once. The
domain must be a zone on the same Cloudflare account — Workers routes only
attach to zones Cloudflare serves — so move its nameservers to Cloudflare first.

1. **Before switching DNS**, copy the `_atproto` TXT record. Bluesky's handle
   check follows the nameservers, so recreate it in Cloudflare or the handle
   breaks. It is one record: `_atproto` `TXT` `did=did:plc:…`.
2. Add `joyboy.wiki` as a zone and set the registrar's nameservers to the pair
   Cloudflare shows.
3. Add a proxied apex record. A dummy `A @ 192.0.2.1` (orange cloud **on**) is
   enough when the Worker route handles every request. Do the same for `www`,
   and give each host its own route — a route without a wildcard host matches
   only that hostname.
4. Add `joyboy.wiki` to `CUSTOM` in `worker.js`, then deploy with the extra
   routes:

   ```sh
   npx wrangler deploy worker.js \
     --name allour-subdomains \
     --compatibility-date 2026-01-01 \
     --route '*.allour.wiki/*' \
     --route 'joyboy.wiki/*' \
     --route 'www.joyboy.wiki/*'
   ```

5. Build the site so the custom origin can finish OAuth sign-in:

   ```sh
   VITE_SITE_URL=https://allour.wiki/ \
   VITE_OAUTH_REDIRECT_URIS=https://joyboy.wiki/ \
   npm run build
   ```

   The generated `client-metadata.json` then lists both origins. On GitHub
   Pages, set the repository variable `OAUTH_REDIRECT_URIS` to
   `https://joyboy.wiki/` instead of passing it by hand.

6. Keep GitHub Pages' custom domain at `allour.wiki`. The Worker proxies
   `joyboy.wiki` to it; no second Pages site is needed.

Verify:

```sh
curl -sI https://joyboy.wiki/ | head -5
curl -s  https://joyboy.wiki/ | grep -o '<title>[^<]*</title>'
```

The handle itself is verified separately in Bluesky (Settings → Account →
Handle → I have my own domain). The `_atproto` TXT record is independent of the
web records, so it works whether the web traffic is proxied or redirected.

### 4. Verify a subdomain

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
  cache headers continue to apply per host.
- Nothing is cached per label; two subdomains share the origin cache but not
  the browser cache, which is what you want because the app renders the
  profile client-side.
- If you later add a redirect from subdomains to the canonical `/@handle/...`
  URL, do it in `host-routing.ts`, not in the Worker, so the path survives.
