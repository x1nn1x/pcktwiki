/**
 * Whether publishing a page also posts it to the author's Bluesky account.
 * On by default: wiki pages are public writing, and the shared hashtag scheme
 * only organizes a profile if it is used consistently. Stored locally so the
 * choice follows the device, not the wiki record.
 */
const POST_TO_BLUESKY_KEY = 'pckt.postToBluesky'

export function readPostToBlueskyPref(): boolean {
  try {
    const raw = localStorage.getItem(POST_TO_BLUESKY_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

export function writePostToBlueskyPref(value: boolean): void {
  try {
    localStorage.setItem(POST_TO_BLUESKY_KEY, value ? '1' : '0')
  } catch {
    // ignore quota / private mode
  }
}
