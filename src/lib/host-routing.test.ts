import { describe, expect, it } from 'vitest'
import { resolveHostRedirect } from '@/lib/host-routing'

describe('resolveHostRedirect', () => {
  it('sends a bare username subdomain to that handle profile', () => {
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/')).toBe('/by/oseanstudio')
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '')).toBe('/by/oseanstudio')
  })

  it('sends a deep link through the label so custom handles can resolve', () => {
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/my-wiki/article')).toBe(
      '/by/oseanstudio/my-wiki/article',
    )
  })

  it('leaves app routes and canonical paths alone', () => {
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/learn')).toBeNull()
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/wikis')).toBeNull()
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/store')).toBeNull()
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/store/thanks')).toBeNull()
    expect(resolveHostRedirect('oseanstudio.allour.wiki', '/by/oseanstudio')).toBeNull()
    expect(
      resolveHostRedirect('oseanstudio.allour.wiki', '/@oseanstudio.bsky.social/my-wiki'),
    ).toBeNull()
  })

  it('ignores apex hosts, www and multi-label subdomains', () => {
    expect(resolveHostRedirect('allour.wiki', '/')).toBeNull()
    expect(resolveHostRedirect('www.allour.wiki', '/')).toBeNull()
    expect(resolveHostRedirect('api.allour.wiki', '/')).toBeNull()
    expect(resolveHostRedirect('a.b.allour.wiki', '/')).toBeNull()
    expect(resolveHostRedirect('localhost:5173', '/')).toBeNull()
    expect(resolveHostRedirect('pckt.wiki', '/')).toBeNull()
  })

  it('supports the pckt.wiki root as well', () => {
    expect(resolveHostRedirect('oseanstudio.pckt.wiki', '/')).toBe('/by/oseanstudio')
  })

  it('treats a custom-domain host as its own handle', () => {
    expect(resolveHostRedirect('joyboy.wiki', '/')).toBe('/by/joyboy.wiki')
    expect(resolveHostRedirect('joyboy.wiki', '')).toBe('/by/joyboy.wiki')
    expect(resolveHostRedirect('joyboy.wiki', '/my-wiki/article')).toBe(
      '/by/joyboy.wiki/my-wiki/article',
    )
  })

  it('handles www and leaves app routes alone on a custom domain', () => {
    expect(resolveHostRedirect('www.joyboy.wiki', '/')).toBe('/by/joyboy.wiki')
    expect(resolveHostRedirect('joyboy.wiki', '/learn')).toBeNull()
    expect(resolveHostRedirect('joyboy.wiki', '/store')).toBeNull()
    expect(resolveHostRedirect('joyboy.wiki', '/by/joyboy.wiki')).toBeNull()
    expect(resolveHostRedirect('joyboy.wiki', '/@joyboy.wiki/my-wiki')).toBeNull()
  })

  it('does not treat preview or multi-label hosts as custom handles', () => {
    expect(resolveHostRedirect('xox.github.io', '/')).toBeNull()
    expect(resolveHostRedirect('pcktwiki.pages.dev', '/')).toBeNull()
    expect(resolveHostRedirect('a.b.allour.wiki', '/')).toBeNull()
  })
})
