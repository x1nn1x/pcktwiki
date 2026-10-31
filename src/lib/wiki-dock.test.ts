import { describe, expect, it } from 'vitest'
import {
  dockAccentFor,
  dockArtFor,
  dockInternalTarget,
  isDockLinkActive,
  isExternalDockUrl,
  normalizeDockLabel,
} from '@/lib/wiki-dock'

describe('normalizeDockLabel', () => {
  it('strips decorations and case', () => {
    expect(normalizeDockLabel('✪ MEMBERS ✪')).toBe('members')
    expect(normalizeDockLabel('  Manga ')).toBe('manga')
  })
})

describe('dockArtFor', () => {
  it('maps the OS dock vocabulary to bubble art', () => {
    expect(dockArtFor('Home')).toContain('home.webp')
    expect(dockArtFor('Manga')).toContain('comics.webp')
    expect(dockArtFor('Downloads')).toContain('downloads.webp')
    expect(dockArtFor('Shop')).toContain('shop.webp')
    expect(dockArtFor('TV')).toContain('videos.webp')
    expect(dockArtFor('Anime')).toContain('videos.webp')
    expect(dockArtFor('Games')).toContain('games.webp')
    expect(dockArtFor('✪ MEMBERS ✪')).toContain('avatar.webp')
  })

  it('returns null for labels without matching art (letter bubble)', () => {
    expect(dockArtFor('Wiki')).toBeNull()
    expect(dockArtFor('')).toBeNull()
  })
})

describe('dockAccentFor', () => {
  it('cycles the OS accent palette', () => {
    expect(dockAccentFor(0)).toBe('#e4007f')
    expect(dockAccentFor(4)).toBe('#e4007f')
    expect(dockAccentFor(1)).toBe('#0f4fc8')
  })
})

describe('dock link targets', () => {
  it('builds internal paths under the wiki base', () => {
    expect(dockInternalTarget('manga', '/@oseanstudio.bsky.social/oseanworld')).toBe(
      '/@oseanstudio.bsky.social/oseanworld/manga',
    )
    expect(dockInternalTarget('  /nested/path ', '/@h/w')).toBe('/@h/w/nested/path')
    expect(dockInternalTarget('', '/@h/w')).toBe('/@h/w')
  })

  it('detects external destinations', () => {
    expect(isExternalDockUrl('https://osean.world')).toBe(true)
    expect(isExternalDockUrl('mailto:a@b.c')).toBe(true)
    expect(isExternalDockUrl('manga')).toBe(false)
  })
})

describe('isDockLinkActive', () => {
  it('lights home on the wiki front page', () => {
    expect(isDockLinkActive('home', undefined)).toBe(true)
    expect(isDockLinkActive('Home', 'Home')).toBe(true)
  })

  it('matches the open slug case-insensitively', () => {
    expect(isDockLinkActive('Manga', 'manga')).toBe(true)
    expect(isDockLinkActive('manga', 'characters')).toBe(false)
  })
})
