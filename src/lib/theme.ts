import type { PcktTheme } from '@/types/lichen'
import { DEFAULT_PCKT_THEME, PCKT_THEME_KEY } from '@/types/lichen'
import { accentHover, adjustColor, contentFontStack, hexToRgba } from '@/lib/theme-colors'

export type ResolvedThemeMode = 'light' | 'dark'

export function resolveThemeMode(mode?: PcktTheme['mode']): ResolvedThemeMode {
  const resolved = mode ?? 'auto'
  if (resolved === 'dark') return 'dark'
  if (resolved === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function setOrClear(root: HTMLElement, prop: string, value: string | undefined | null) {
  if (value) root.style.setProperty(prop, value)
  else root.style.removeProperty(prop)
}

export const DEFAULT_ACCENT_LIGHT = '#3366cc'

export function applyWikiTheme(theme?: PcktTheme): void {
  const merged = { ...DEFAULT_PCKT_THEME, ...theme }
  const root = document.documentElement

  // No explicit accent means the stylesheet owns it, so light and dark mode
  // each get their own readable blue (Wikipedia #3366cc / #6e9fff).
  const accent = merged.accentColor
  if (accent) {
    root.style.setProperty('--pckt-accent', accent)
    root.style.setProperty('--pckt-accent-hover', accentHover(accent))
    root.style.setProperty('--pckt-link', accent)
    root.style.setProperty('--pckt-accent-soft', hexToRgba(accent, 0.12))
  } else {
    root.style.removeProperty('--pckt-accent')
    root.style.removeProperty('--pckt-accent-hover')
    root.style.removeProperty('--pckt-link')
    root.style.removeProperty('--pckt-accent-soft')
  }
  root.style.setProperty('--pckt-font-content', contentFontStack(merged.fontFamily))

  setOrClear(root, '--pckt-bg', merged.bgColor)
  // Prefer an explicit card/sidebar color, otherwise stay flat with the page bg.
  setOrClear(root, '--pckt-bg-elevated', merged.cardColor ?? merged.bgColor)
  setOrClear(root, '--pckt-bg-muted', merged.sidebarColor ?? merged.bgColor)
  // Wiki layout regions: only paint when the user set an explicit color so the
  // default stays a flat transparent surface over --pckt-bg.
  setOrClear(root, '--pckt-wiki-card-bg', merged.cardColor)
  setOrClear(root, '--pckt-wiki-sidebar-bg', merged.sidebarColor)
  if (merged.sidebarColor ?? merged.bgColor) {
    root.style.setProperty(
      '--pckt-bg-subtle',
      adjustColor((merged.sidebarColor ?? merged.bgColor)!, -12),
    )
  } else {
    root.style.removeProperty('--pckt-bg-subtle')
  }
  setOrClear(root, '--pckt-header-bg', merged.headerColor ?? merged.bgColor)

  root.setAttribute('data-theme', resolveThemeMode(merged.mode))

  root.classList.remove('layout-width-narrow', 'layout-width-medium', 'layout-width-wide')
  root.classList.add(`layout-width-${merged.layoutWidth ?? 'medium'}`)
}

let systemThemeCleanup: (() => void) | null = null

export function initSystemThemeListener(): void {
  systemThemeCleanup?.()
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const local = loadLocalTheme()
    if ((local.mode ?? 'auto') === 'auto') {
      applyWikiTheme(local)
    }
  }
  mq.addEventListener('change', handler)
  systemThemeCleanup = () => mq.removeEventListener('change', handler)
}

export function saveLocalTheme(theme: PcktTheme): void {
  localStorage.setItem(PCKT_THEME_KEY, JSON.stringify(theme))
}

export function loadLocalTheme(): PcktTheme {
  try {
    const raw = localStorage.getItem(PCKT_THEME_KEY)
    if (!raw) return { ...DEFAULT_PCKT_THEME }
    return { ...DEFAULT_PCKT_THEME, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_PCKT_THEME }
  }
}

export function resetAppTheme(): void {
  applyWikiTheme(loadLocalTheme())
}

/** Pull presentation fields off a wiki record into a PcktTheme patch. */
export function themeFromWiki(wiki: {
  theme?: 'light' | 'dark'
  accentColor?: string
  bgColor?: string
  cardColor?: string
  sidebarColor?: string
  headerColor?: string
  fontFamily?: string
  layoutWidth?: PcktTheme['layoutWidth']
}): PcktTheme {
  return {
    ...(wiki.theme ? { mode: wiki.theme } : {}),
    ...(wiki.accentColor ? { accentColor: wiki.accentColor } : {}),
    ...(wiki.bgColor ? { bgColor: wiki.bgColor } : {}),
    ...(wiki.cardColor ? { cardColor: wiki.cardColor } : {}),
    ...(wiki.sidebarColor ? { sidebarColor: wiki.sidebarColor } : {}),
    ...(wiki.headerColor ? { headerColor: wiki.headerColor } : {}),
    ...(wiki.fontFamily ? { fontFamily: wiki.fontFamily } : {}),
    ...(wiki.layoutWidth ? { layoutWidth: wiki.layoutWidth } : {}),
  }
}

export function wikiHasCustomTheme(wiki: {
  theme?: string
  accentColor?: string
  bgColor?: string
  cardColor?: string
  sidebarColor?: string
  headerColor?: string
  fontFamily?: string
  layoutWidth?: string
}): boolean {
  return !!(
    wiki.theme ||
    wiki.accentColor ||
    wiki.bgColor ||
    wiki.cardColor ||
    wiki.sidebarColor ||
    wiki.headerColor ||
    wiki.fontFamily ||
    wiki.layoutWidth
  )
}
