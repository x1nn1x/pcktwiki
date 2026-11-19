import { describe, expect, it } from 'vitest'
import { responsiveImage } from '@/lib/media/responsive-image'

describe('responsiveImage', () => {
  it('builds Wikimedia thumb variants from an original upload URL', () => {
    const result = responsiveImage(
      'https://upload.wikimedia.org/wikipedia/commons/e/e0/Example.jpg',
    )
    expect(result.src).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Example.jpg/800px-Example.jpg',
    )
    expect(result.srcSet).toContain('480px-Example.jpg 480w')
    expect(result.srcSet).toContain('1280px-Example.jpg 1280w')
  })

  it('normalises an existing thumb URL instead of nesting it', () => {
    const result = responsiveImage(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e0/Example.jpg/330px-Example.jpg',
    )
    expect(result.src).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Example.jpg/800px-Example.jpg',
    )
    expect(result.srcSet).toContain('480px-Example.jpg 480w')
  })

  it('renders SVG originals to PNG thumbs', () => {
    const result = responsiveImage(
      'https://upload.wikimedia.org/wikipedia/commons/1/1e/Map.svg',
    )
    expect(result.src.endsWith('/800px-Map.svg.png')).toBe(true)
    expect(result.srcSet).toContain('480px-Map.svg.png 480w')
  })

  it('uses Fandom scale-to-width-down variants', () => {
    const result = responsiveImage(
      'https://static.wikia.nocookie.net/example/images/1/1a/Pic.png/revision/latest/scale-to-width-down/1000?cb=20240101',
    )
    expect(result.src).toBe(
      'https://static.wikia.nocookie.net/example/images/1/1a/Pic.png/revision/latest/scale-to-width-down/800?cb=20240101',
    )
    expect(result.srcSet).toContain(
      'https://static.wikia.nocookie.net/example/images/1/1a/Pic.png/revision/latest/scale-to-width-down/480?cb=20240101 480w',
    )
  })

  it('leaves unknown hosts and inline images untouched', () => {
    const external = 'https://example.com/picture.png'
    expect(responsiveImage(external)).toEqual({ src: external })
    expect(responsiveImage('data:image/png;base64,abc')).toEqual({
      src: 'data:image/png;base64,abc',
    })
    expect(responsiveImage('blob:https://example.com/123')).toEqual({
      src: 'blob:https://example.com/123',
    })
  })
})
