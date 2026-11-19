import type { PcktTheme } from '@/types/lichen'

/**
 * Portable wiki theme. Shared as a short markdown file so people can paste it
 * into chats, posts, or wiki pages — not only as JSON.
 */
export interface ThemePack {
  name: string
  accent: string
  bg?: string
  card?: string
  sidebar?: string
  header?: string
  font: string
  layoutWidth: 'narrow' | 'default' | 'medium' | 'wide'
  wikiLightDark?: 'light' | 'dark'
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function isThemePack(value: unknown): value is ThemePack {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && typeof v.accent === 'string' && typeof v.font === 'string'
}

function optionalHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return HEX_RE.test(trimmed) ? trimmed : undefined
}

function normalizeLayoutWidth(
  value: unknown,
): ThemePack['layoutWidth'] {
  if (value === 'narrow' || value === 'wide' || value === 'medium' || value === 'default') {
    return value
  }
  return 'default'
}

function normalizeMode(value: unknown): ThemePack['wikiLightDark'] {
  if (value === 'light' || value === 'dark') return value
  return undefined
}

/** Build a shareable pack from the live theme state. */
export function themeToPack(theme: PcktTheme, name = 'Custom theme'): ThemePack {
  return {
    name,
    accent: theme.accentColor ?? '#3366cc',
    bg: theme.bgColor,
    card: theme.cardColor,
    sidebar: theme.sidebarColor,
    header: theme.headerColor,
    font: theme.fontFamily ?? 'Lora',
    layoutWidth:
      theme.layoutWidth === 'medium' ? 'default' : (theme.layoutWidth ?? 'default'),
    wikiLightDark:
      theme.mode === 'light' || theme.mode === 'dark' ? theme.mode : undefined,
  }
}

/** Apply a pack onto an existing theme (preserves unset pack fields). */
export function packToTheme(
  pack: ThemePack,
  base: PcktTheme = {},
  opts: { colorsOnly?: boolean } = {},
): PcktTheme {
  const font =
    pack.font === 'legible'
      ? 'Atkinson Hyperlegible'
      : pack.font === 'serif'
        ? 'Literata'
        : pack.font

  return {
    ...base,
    accentColor: pack.accent,
    bgColor: pack.bg,
    cardColor: pack.card,
    sidebarColor: pack.sidebar,
    headerColor: pack.header,
    // Themes must not change layout size — keep the current width.
    layoutWidth: base.layoutWidth,
    mode: pack.wikiLightDark ?? base.mode,
    // Color palettes leave typography alone so text metrics stay put.
    ...(opts.colorsOnly ? {} : { fontFamily: font }),
  }
}

export function exportThemePack(pack: ThemePack): string {
  return JSON.stringify(pack, null, 2)
}

/**
 * Human-readable markdown theme card. Safe to paste into Bluesky, Discord,
 * wiki pages, or email — import accepts the whole file or just the fence.
 */
export function exportThemeMarkdown(pack: ThemePack): string {
  const lines = [
    `name: ${pack.name}`,
    `accent: ${pack.accent}`,
  ]
  if (pack.bg) lines.push(`bg: ${pack.bg}`)
  if (pack.card) lines.push(`card: ${pack.card}`)
  if (pack.sidebar) lines.push(`sidebar: ${pack.sidebar}`)
  if (pack.header) lines.push(`header: ${pack.header}`)
  lines.push(`font: ${pack.font}`)
  lines.push(`width: ${pack.layoutWidth === 'medium' ? 'default' : pack.layoutWidth}`)
  if (pack.wikiLightDark) lines.push(`mode: ${pack.wikiLightDark}`)

  return [
    `# ${pack.name}`,
    '',
    'A [pckt](https://pckt.wiki) wiki theme. Import this file (or paste the block below) in Theme settings or Theme mode.',
    '',
    '```pckt-theme',
    ...lines,
    '```',
    '',
  ].join('\n')
}

function parseKeyValueBlock(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/)
    if (!match) continue
    out[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function packFromMap(map: Record<string, string>): ThemePack {
  const accent = optionalHex(map.accent) ?? map.accent
  if (!map.name?.trim() || !accent || !map.font?.trim()) {
    throw new Error('Invalid theme pack')
  }
  return {
    name: map.name.trim(),
    accent,
    bg: optionalHex(map.bg),
    card: optionalHex(map.card),
    sidebar: optionalHex(map.sidebar),
    header: optionalHex(map.header),
    font: map.font.trim(),
    layoutWidth: normalizeLayoutWidth(map.width ?? map.layoutwidth ?? map.layout),
    wikiLightDark: normalizeMode(map.mode ?? map.wikilightdark),
  }
}

/** Extract a ` ```pckt-theme ` fence, or fall back to the whole text as key/values. */
export function parseThemeMarkdown(text: string): ThemePack {
  const fence = text.match(/```pckt-theme\s*([\s\S]*?)```/i)
  if (fence) return packFromMap(parseKeyValueBlock(fence[1]))

  // YAML-ish frontmatter between --- fences
  const front = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (front && /pckt-theme|accent\s*:/i.test(front[1])) {
    return packFromMap(parseKeyValueBlock(front[1]))
  }

  // Bare key/value body (no markdown chrome)
  if (/^\s*name\s*:/im.test(text) && /^\s*accent\s*:/im.test(text)) {
    return packFromMap(parseKeyValueBlock(text))
  }

  throw new Error('No pckt theme found in markdown')
}

/**
 * Import JSON (legacy `.pckt-theme.json`) or markdown theme cards.
 */
export function importThemePack(raw: string): ThemePack {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Invalid theme pack')

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isThemePack(parsed)) throw new Error('Invalid theme pack')
    return {
      ...parsed,
      bg: optionalHex((parsed as ThemePack).bg),
      card: optionalHex((parsed as ThemePack).card),
      sidebar: optionalHex((parsed as ThemePack).sidebar),
      header: optionalHex((parsed as ThemePack).header),
      layoutWidth: normalizeLayoutWidth(parsed.layoutWidth),
      wikiLightDark: normalizeMode(parsed.wikiLightDark),
    }
  }

  return parseThemeMarkdown(trimmed)
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'theme'
}

export function downloadThemePack(pack: ThemePack): void {
  const blob = new Blob([exportThemeMarkdown(pack)], {
    type: 'text/markdown;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slugifyName(pack.name)}.pckt-theme.md`
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyThemeMarkdown(pack: ThemePack): Promise<void> {
  await navigator.clipboard.writeText(exportThemeMarkdown(pack))
}
