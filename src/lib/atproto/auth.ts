import { BrowserOAuthClient, type OAuthSession } from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'
import { getDevLoopbackClientMetadata, getHandleResolver, getOAuthConfig } from '@/lib/config'
import { getRepoReadAgent } from '@/lib/atproto/pds'
import { getCachedDid, setCachedDid } from '@/lib/atproto/handle-cache'
import { createRetryFetch, toUserFacingNetworkError, withRetry } from '@/lib/http-retry'

const SESSION_SUB_KEY = 'pckt.wiki.sessionSub'

let oauthClient: BrowserOAuthClient | null = null
let activeSession: OAuthSession | null = null
let initPromise: ReturnType<typeof initializeAuth> | null = null

export async function getOAuthClient(): Promise<BrowserOAuthClient> {
  if (oauthClient) return oauthClient

  const config = getOAuthConfig()

  const handleResolver = getHandleResolver()

  if (import.meta.env.DEV) {
    oauthClient = new BrowserOAuthClient({
      handleResolver,
      clientMetadata: getDevLoopbackClientMetadata(),
    })
  } else {
    oauthClient = await BrowserOAuthClient.load({
      clientId: config.clientId,
      handleResolver,
    })
  }

  return oauthClient
}

export async function initializeAuth(): Promise<{
  session: OAuthSession
  agent: Agent
  did: string
  handle: string | null
} | null> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    const client = await getOAuthClient()
    const result = await client.init()

    if (result?.session) {
      activeSession = result.session
      localStorage.setItem(SESSION_SUB_KEY, result.session.sub)
      const agent = new Agent(result.session)
      const handle = await fetchHandle(agent)
      return {
        session: result.session,
        agent,
        did: agent.accountDid,
        handle,
      }
    }

    return null
  })()

  try {
    return await initPromise
  } catch (err) {
    initPromise = null
    throw err
  }
}

async function fetchHandle(agent: Agent): Promise<string | null> {
  try {
    const profile = await agent.getProfile({ actor: agent.accountDid })
    return profile.data.handle ?? null
  } catch {
    return null
  }
}

export async function signIn(handle: string): Promise<void> {
  await initializeAuth()
  const client = await getOAuthClient()
  // The library otherwise uses the first metadata redirect URI, which would
  // finish a custom-domain sign-in on the canonical origin instead of this one.
  const { redirectUri } = getOAuthConfig()
  await client.signInRedirect(handle, {
    redirect_uri: redirectUri as `https://${string}` | `http://127.0.0.1:${string}`,
  })
}

export async function signOut(): Promise<void> {
  if (activeSession) {
    await activeSession.signOut()
    activeSession = null
  }
  localStorage.removeItem(SESSION_SUB_KEY)
}

export async function getAuthenticatedAgent(): Promise<Agent | null> {
  if (activeSession) {
    return new Agent(activeSession)
  }

  const storedSub = localStorage.getItem(SESSION_SUB_KEY)
  if (!storedSub) return null

  try {
    const client = await getOAuthClient()
    const session = await client.restore(storedSub)
    activeSession = session
    return new Agent(session)
  } catch {
    localStorage.removeItem(SESSION_SUB_KEY)
    return null
  }
}

let publicAgent: Agent | null = null

export async function resolveHandleToDid(handle: string): Promise<string> {
  const normalized = normalizeHandle(handle)
  // A repo discovered through the relay may have no handle in its DID document,
  // so its wiki is addressed by DID. Those are already resolved.
  if (normalized.startsWith('did:')) return normalized

  const cached = getCachedDid(normalized)
  if (cached) return cached

  try {
    const did = await withRetry(async () => {
      const agent = getPublicAgent()
      const resolved = await agent.resolveHandle({ handle: normalized })
      return resolved.data.did
    })
    setCachedDid(normalized, did)
    return did
  } catch (err) {
    throw new Error(toUserFacingNetworkError(err))
  }
}

function normalizeHandle(handle: string): string {
  return handle.startsWith('@') ? handle.slice(1) : handle
}

export function getPublicAgent(): Agent {
  if (!publicAgent) {
    publicAgent = new Agent({
      service: 'https://public.api.bsky.app',
      fetch: createRetryFetch(),
    })
  }
  return publicAgent
}

/** AppView for profiles/handles; repo lexicon reads use the account PDS instead. */
export async function getReadAgentForRepo(
  repoDid: string,
  authenticatedAgent: Agent | null = null,
  viewerDid: string | null = null,
): Promise<Agent> {
  if (authenticatedAgent && viewerDid === repoDid) {
    return authenticatedAgent
  }
  return getRepoReadAgent(repoDid)
}

export function generateRecordKey(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
