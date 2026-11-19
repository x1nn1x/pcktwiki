#!/usr/bin/env node
/**
 * build-featured-snapshot — write public/featured-wikis-snapshot.json.
 *
 * The landing page's "featured wikis" come from many separate PDS repos. Doing
 * that on every cold page load leaves the previews blank for seconds, so the
 * same data is precomputed here and shipped with the site. The runtime loads
 * the snapshot instantly and refreshes from the network only when it is stale.
 *
 *   npm run build:featured
 *
 * Network access is required. Commit the result when the featured catalog or
 * the wikis themselves change meaningfully.
 */
import { createServer } from 'vite'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = resolve(root, 'public/featured-wikis-snapshot.json')

const server = await createServer({
  configFile: resolve(root, 'vite.snapshot.config.ts'),
  root,
  logLevel: 'error',
})

try {
  const mod = await server.ssrLoadModule('/src/lib/lichen/featured-wiki-loader.ts')

  const wikis = await mod.loadFeaturedWikis({ force: true })
  if (!wikis.length) throw new Error('no featured wikis loaded')
  const snapshot = mod.buildFeaturedWikiSnapshot(wikis)
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`[featured-snapshot] wrote ${wikis.length} wikis to public/featured-wikis-snapshot.json`)
} catch (error) {
  console.error('[featured-snapshot] failed:', error)
  process.exitCode = 1
} finally {
  await server.close()
}
