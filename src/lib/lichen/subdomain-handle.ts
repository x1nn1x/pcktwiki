import { resolveHandleToDid } from '@/lib/atproto/auth'
import { loadWikiDirectory, type DirectoryWiki } from '@/lib/lichen/wiki-directory'

/**
 * One label of a username subdomain. `oseanstudio.allour.wiki` maps to
 * `oseanstudio.bsky.social`; a label can never contain a dot, so custom-domain
 * handles are only discoverable through the public wiki directory.
 */
export function defaultHandleForLabel(label: string): string {
  return `${label}.bsky.social`
}

/**
 * The handle whose wikis a subdomain label should show. Prefers the default
 * Bluesky handle, then a directory handle that starts with the same label
 * (`mfzx.allour.wiki` → `mfzx.net`). Falls back to the default handle so the
 * caller can render a normal "not found" state.
 */
export async function resolveSubdomainHandle(label: string): Promise<string> {
  const primary = defaultHandleForLabel(label)

  try {
    await resolveHandleToDid(primary)
    return primary
  } catch {
    // No such bsky.social handle — look for a custom domain.
  }

  const directory = await loadWikiDirectory().catch(() => [] as DirectoryWiki[])
  const match =
    directory.find((row) => row.handle.toLowerCase() === primary) ??
    directory.find((row) => row.handle.toLowerCase().split('.')[0] === label)

  return match?.handle ?? primary
}
