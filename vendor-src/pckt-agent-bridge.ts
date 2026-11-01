/**
 * Same-origin agent bridge: exposes the AT Protocol client libraries the app
 * already depends on (bundled by esbuild into public/vendor) for maintenance
 * tooling that runs inside a signed-in session. Libraries only — the session
 * itself stays in the app's own storage, untouched.
 */
import { Agent } from '@atproto/api'
import { BrowserOAuthClient } from '@atproto/oauth-client-browser'

const w = window as unknown as { pcktAgentBridge?: unknown }
w.pcktAgentBridge = { Agent, BrowserOAuthClient }
