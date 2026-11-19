import type { LichenHeaderLink } from '@/types/lichen'

/** Absolute destinations open in a new tab; anything else is a wiki path. */
export function isExternalHeaderLink(url: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(url)
}

/** A link may exist as a label and image before it has a destination. */
export function headerLinkHasDestination(link: LichenHeaderLink): boolean {
  return !!link.url?.trim()
}

/**
 * Internal URLs are wiki paths: '' or '.' means the wiki home, and any leading
 * slashes are dropped because the base path already carries them.
 */
export function headerLinkHref(url: string, basePath: string): string {
  const trimmed = url.trim().replace(/^\/+/, '')
  if (!trimmed || trimmed === '.') return basePath
  return `${basePath}/${trimmed}`
}
