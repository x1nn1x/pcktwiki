import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Plugin } from 'vite'
// The OAuth scope has one home. client-metadata.json is generated from it below
// so the served document and the app can never drift apart.
import { OAUTH_SCOPE } from './src/lib/lichen/collections'

// Dropbox-synced node_modules makes Vite's dep optimizer hang (white screen).
const viteCacheDir = join(tmpdir(), 'pcktwiki-vite')

/**
 * Where this build will be served from. Everything origin- or path-dependent
 * (Vite's base, the PWA manifest, the OAuth client id, CNAME) is derived from
 * this single value so a fork only has to answer one question: what URL is it?
 *
 * Unset means the canonical deployment. Forks set VITE_SITE_URL — either a
 * custom domain (https://my.wiki/) or a GitHub Pages project page
 * (https://user.github.io/repo/), which is served under a subpath.
 */
const DEFAULT_SITE_URL = 'https://pckt.wiki/'

// Both real environment variables and a local .env file, so `VITE_SITE_URL=… npm
// run build` and a checked-out .env behave the same. See .env.example.
const siteEnv = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), '')

function resolveSiteUrl(): URL {
  const raw = siteEnv.VITE_SITE_URL?.trim() || DEFAULT_SITE_URL

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`VITE_SITE_URL must be an absolute URL (got: ${raw})`)
  }

  // The PDS fetches the client id over the network and refuses anything else.
  if (url.protocol !== 'https:') {
    throw new Error(`VITE_SITE_URL must use https:// — AT Protocol OAuth rejects ${url.protocol}//`)
  }

  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

const siteUrl = resolveSiteUrl()
/** Shown on the PDS consent screen, so a fork should say who it is. */
const siteName =
  siteEnv.SITE_NAME?.trim() || (siteUrl.href === DEFAULT_SITE_URL ? 'pckt.wiki' : siteUrl.host)
/** Always starts and ends with '/': '/' for a domain, '/repo/' for a project page. */
const base = siteUrl.pathname
const clientId = `${siteUrl.href}client-metadata.json`

/**
 * A custom domain needs a CNAME file; *.github.io does not (and writing one
 * there would fight the repository's own Pages settings).
 */
function resolveCname(): string | null {
  if (siteEnv.SITE_CNAME === '0') return null
  if (siteEnv.SITE_CNAME) return siteEnv.SITE_CNAME.trim()
  if (siteUrl.hostname.endsWith('.github.io')) return null
  return siteUrl.hostname
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function siteConfigPlugin(): Plugin {
  let isBuild = false

  return {
    name: 'site-config',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    // Emitted during buildStart rather than committed to the repo: the document
    // has to name the URL it is actually served from, which only this build
    // knows. Emitting this early also puts it in the bundle before the PWA
    // plugin builds its precache manifest.
    buildStart() {
      if (!isBuild) return

      const metadata = {
        client_id: clientId,
        client_name: siteName,
        client_uri: siteUrl.href,
        logo_uri: `${siteUrl.href}android-chrome-512x512.png`,
        policy_uri: siteUrl.href,
        tos_uri: siteUrl.href,
        redirect_uris: [siteUrl.href],
        scope: OAUTH_SCOPE,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        dpop_bound_access_tokens: true,
      }

      this.emitFile({
        type: 'asset',
        fileName: 'client-metadata.json',
        source: `${JSON.stringify(metadata, null, 2)}\n`,
      })

      const cname = resolveCname()
      if (cname) {
        this.emitFile({ type: 'asset', fileName: 'CNAME', source: `${cname}\n` })
      }

      console.log(`[site-config] building for ${siteUrl.href} (base ${base})`)
    },
    transformIndexHtml: {
      // After Vite's own HTML asset handling, so it never sees (and warns about)
      // an already-based path.
      order: 'post',
      handler(html) {
        return html.replaceAll('%SITE_URL%', siteUrl.href).replaceAll('%BASE_URL%', base)
      },
    },
  }
}

function guestFeedSnapshotPlugin(): Plugin {
  let root = process.cwd()

  return {
    name: 'guest-feed-snapshot',
    // Snapshot generation fetches the network and can block startup for minutes.
    apply: 'build',
    configResolved(config) {
      root = config.root
    },
    async buildStart() {
      if (process.env.SKIP_GUEST_FEED_SNAPSHOT === '1') return

      const outPath = resolve(root, 'public/guest-feed-snapshot.json')
      if (existsSync(outPath)) {
        try {
          const existing = JSON.parse(readFileSync(outPath, 'utf8')) as { fetchedAt?: string }
          const age = Date.now() - Date.parse(existing.fetchedAt ?? '')
          if (!Number.isNaN(age) && age < 30 * 60 * 1000) {
            console.log('[guest-feed-snapshot] reusing recent public/guest-feed-snapshot.json')
            return
          }
        } catch {
          // Regenerate below.
        }
      }

      const snapshotTimeoutMs = 120_000
      let server: Awaited<ReturnType<(typeof import('vite'))['createServer']>> | null = null

      try {
        const { createServer } = await import('vite')
        server = await createServer({
          configFile: resolve(__dirname, 'vite.snapshot.config.ts'),
          root,
          logLevel: 'error',
        })
        const mod = (await server.ssrLoadModule('/src/lib/lichen/guest-feed.ts')) as {
          fetchGuestFeedCore: () => Promise<unknown>
          buildGuestFeedSnapshot: (core: unknown, network: unknown[], degraded: boolean) => unknown
        }

        const core = await Promise.race([
          mod.fetchGuestFeedCore(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('guest feed snapshot timed out')), snapshotTimeoutMs)
          }),
        ])
        const snapshot = mod.buildGuestFeedSnapshot(core, [], false)

        writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`)
        console.log('[guest-feed-snapshot] wrote public/guest-feed-snapshot.json')
      } catch (error) {
        console.warn('[guest-feed-snapshot] skipped:', error)
      } finally {
        await server?.close()
      }
    },
  }
}

export default defineConfig({
  base,
  define: {
    // Read by src/lib/config.ts so the app's OAuth client id is the same string
    // the emitted client-metadata.json advertises.
    __SITE_URL__: JSON.stringify(siteUrl.href),
  },
  // Keep Vite caches on a local disk, not Dropbox.
  cacheDir: viteCacheDir,
  optimizeDeps: {
    // Prefer a local node_modules (symlink out of Dropbox). Dropbox-synced
    // node_modules hangs Vite's dep crawler; if you must keep deps in Dropbox,
    // set noDiscovery: true and explicitly include CJS packages below.
    include: [
      'diff-match-patch',
      'core-js/es/symbol/dispose.js',
      'core-js/es/symbol/async-dispose.js',
    ],
    // Silkdown must share the app's CodeMirror instance. Prebundling it pulls
    // nested @codemirror copies from silkdown-monorepo and breaks live preview.
    exclude: ['@silkdown/core', 'silkdown-monorepo'],
  },
  server: {
    // AT Protocol OAuth loopback requires 127.0.0.1 (not localhost/::1).
    host: '127.0.0.1',
    port: 5173,
    fs: {
      // node_modules is often symlinked to a local cache outside the Dropbox project root.
      allow: [
        resolve(__dirname),
        viteCacheDir,
        resolve(process.env.HOME ?? '', 'Library/Caches/pcktwiki'),
      ],
    },
  },
  plugins: [
    vue(),
    siteConfigPlugin(),
    guestFeedSnapshotPlugin(),
    VitePWA({
      devOptions: {
        enabled: false,
      },
      registerType: 'prompt',
      includeAssets: [
        'favicon.ico',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
        'android-chrome-192x192.png',
        'android-chrome-512x512.png',
      ],
      manifest: {
        name: 'pckt.wiki',
        short_name: 'pckt',
        description: 'Your personal wiki on the open social web',
        theme_color: '#ff5d5b',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: base,
        start_url: base,
        categories: ['productivity', 'social'],
        icons: [
          {
            src: `${base}favicon-16x16.png`,
            sizes: '16x16',
            type: 'image/png',
          },
          {
            src: `${base}favicon-32x32.png`,
            sizes: '32x32',
            type: 'image/png',
          },
          {
            src: `${base}android-chrome-192x192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: `${base}android-chrome-512x512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2,json}'],
        navigateFallback: `${base}index.html`,
        // The PDS fetches this document directly; it must never be answered
        // with the app shell.
        navigateFallbackDenylist: [new RegExp(`^${escapeRegExp(base)}client-metadata\\.json$`)],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/plc\.directory\//i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'plc-directory',
              expiration: { maxEntries: 200, maxAgeSeconds: 86_400 },
            },
          },
          {
            urlPattern: /^https:\/\/public\.api\.bsky\.app\//i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'bsky-public-api',
              expiration: { maxEntries: 120, maxAgeSeconds: 3_600 },
            },
          },
          {
            // Avatars/media from Bluesky's CDN (versioned URLs, immutable).
            urlPattern: /^https:\/\/cdn\.bsky\.app\/img\//i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'bsky-cdn-images',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 300, maxAgeSeconds: 2_592_000 },
            },
          },
          {
            urlPattern: /^https:\/\/constellation\.microcosm\.blue\//i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'constellation',
              expiration: { maxEntries: 100, maxAgeSeconds: 600 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/xrpc/com.atproto.repo.'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'atproto-repo-reads',
              expiration: { maxEntries: 400, maxAgeSeconds: 1_800 },
            },
          },
          {
            // Wiki media is immutable by CID: the same URL always returns the
            // same bytes, so CacheFirst is forever-correct. PDSes send
            // `cache-control: private`, which makes the browser refetch on
            // every refresh — this cache is what stops that. 600 entries /
            // 180 days holds a media-heavy wiki's whole library.
            urlPattern: ({ url }) => url.pathname.includes('/xrpc/com.atproto.sync.getBlob'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'atproto-blobs',
              cacheableResponse: { statuses: [0, 200] },
              expiration: {
                maxEntries: 600,
                maxAgeSeconds: 15_552_000,
              },
            },
          },
        ],
      },
    }),
    {
      name: 'copy-404',
      closeBundle() {
        const indexPath = resolve(__dirname, 'dist/index.html')
        const notFoundPath = resolve(__dirname, 'dist/404.html')
        if (existsSync(indexPath)) {
          copyFileSync(indexPath, notFoundPath)
        }
      },
    },
  ],
  resolve: {
    // One CodeMirror identity — Silkdown decorations break with duplicates.
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/lang-markdown',
      '@codemirror/language-data',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/markdown',
    ],
    alias: [
      {
        find: '@silkdown/core/theme.css',
        replacement: resolve(
          __dirname,
          'node_modules/silkdown-monorepo/packages/core/dist/theme.css',
        ),
      },
      {
        find: '@silkdown/core',
        replacement: resolve(
          __dirname,
          'node_modules/silkdown-monorepo/packages/core/dist/index.js',
        ),
      },
      {
        find: '@',
        replacement: resolve(__dirname, 'src'),
      },
    ],
  },
})
