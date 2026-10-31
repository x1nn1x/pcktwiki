import { cpSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreDir = resolve(root, 'node_modules/silkdown-monorepo/packages/core')
const distEntry = resolve(coreDir, 'dist/index.js')

if (existsSync(distEntry)) {
  process.exit(0)
}

if (!existsSync(coreDir)) {
  console.warn('[build-silkdown] silkdown-monorepo not installed; skipping')
  process.exit(0)
}

// Upstream ships the core package unbuilt, and building it needs a nested
// `npm install` inside this repo's node_modules — which is unreliable (npm's
// arborist crashes under `npm ci` on CI, and esbuild's binary loses its exec
// bit locally). The built dist is therefore vendored at vendor/silkdown-core
// instead. Re-vendor it if the pinned upstream
// (github:magarcia/silkdown#main:packages/core) ever changes.
const vendorDir = resolve(root, 'vendor/silkdown-core')
if (!existsSync(resolve(vendorDir, 'index.js'))) {
  console.warn('[build-silkdown] vendor/silkdown-core is missing; cannot stage dist')
  process.exit(0)
}

cpSync(vendorDir, resolve(coreDir, 'dist'), { recursive: true })
