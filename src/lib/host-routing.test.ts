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
})
