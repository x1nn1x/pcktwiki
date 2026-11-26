import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirrors the constant vite.config.ts injects, so modules that read the
  // deployment URL import cleanly under the test runner.
  define: {
    __SITE_URL__: JSON.stringify('https://pckt.wiki/'),
    __OAUTH_REDIRECT_URIS__: JSON.stringify(['https://pckt.wiki/']),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Pure logic only — no DOM needed for the modules under test.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
