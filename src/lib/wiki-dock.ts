import homeArt from '@/assets/dock/home.webp'
import comicsArt from '@/assets/dock/comics.webp'
import downloadsArt from '@/assets/dock/downloads.webp'
import shopArt from '@/assets/dock/shop.webp'
import cartArt from '@/assets/dock/cart.webp'
import videosArt from '@/assets/dock/videos.webp'
import gamesArt from '@/assets/dock/games.webp'
import avatarArt from '@/assets/dock/avatar.webp'
import menuArt from '@/assets/dock/menu.webp'
import eggArt from '@/assets/dock/egg.webp'

/**
 * Osean World OS dock bubbles, ported for wiki navbar links.
 *
 * A navbar link's label picks the bubble art by word match ("Manga" → the
 * comics bubble, "Members" → the avatar bubble); labels with no matching art
 * fall back to a letter bubble in the shell's frame style.
 */

const ART = {
  home: homeArt,
  comics: comicsArt,
  downloads: downloadsArt,
  shop: shopArt,
  cart: cartArt,
  videos: videosArt,
  games: gamesArt,
  avatar: avatarArt,
  menu: menuArt,
  egg: eggArt,
} as const

export type DockArtKey = keyof typeof ART

/** Label word → bubble art, covering the OS dock's own vocabulary. */
const LABEL_TO_ART: Record<string, DockArtKey> = {
  home: 'home',
  start: 'home',
  manga: 'comics',
  comics: 'comics',
  comic: 'comics',
  downloads: 'downloads',
  download: 'downloads',
  files: 'downloads',
  shop: 'shop',
  store: 'shop',
  merch: 'shop',
  cart: 'cart',
  tv: 'videos',
  videos: 'videos',
  video: 'videos',
  anime: 'videos',
  games: 'games',
  game: 'games',
  play: 'games',
  members: 'avatar',
  member: 'avatar',
  profile: 'avatar',
  account: 'avatar',
  club: 'avatar',
  menu: 'menu',
  about: 'menu',
  support: 'menu',
}

/** Lowercase letters only, so "✪ MEMBERS ✪" matches like "members". */
export function normalizeDockLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z]/g, '')
}

/** Bubble art for a navbar label, or null when a letter bubble should render. */
export function dockArtFor(label: string): string | null {
  const word = normalizeDockLabel(label)
  if (!word) return null
  const key = LABEL_TO_ART[word]
  return key ? ART[key] : null
}

/** Accent cycle for letter bubbles, straight from the OS shell tokens. */
export const DOCK_ACCENTS = ['#e4007f', '#0f4fc8', '#1faf38', '#e8a200'] as const

export function dockAccentFor(index: number): string {
  return DOCK_ACCENTS[index % DOCK_ACCENTS.length]
}

export interface DockLink {
  label: string
  /** Internal note slug/path, or an absolute http(s)/mailto/tel URL. */
  url: string
}

export function isExternalDockUrl(url: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(url)
}

/** Router target for an internal dock link (`/@handle/wiki/slug`), or '' when inert. */
export function dockInternalTarget(url: string, basePath: string): string {
  const trimmed = url.trim().replace(/^\/+/, '')
  if (!trimmed || trimmed === '.') return basePath
  return `${basePath}/${trimmed}`
}

/**
 * Is this dock link the page currently on? The wiki root counts as "home" so
 * the home bubble stays lit while browsing /@handle/wiki without a slug.
 */
export function isDockLinkActive(url: string, noteSlug: string | undefined): boolean {
  const trimmed = url.trim().replace(/^\/+/, '').toLowerCase()
  const current = (noteSlug ?? 'home').toLowerCase()
  if (!trimmed || trimmed === '.') return current === 'home'
  return trimmed === current
}
