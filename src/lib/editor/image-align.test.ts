import { describe, expect, it } from 'vitest'
import { applyAction, activeActions } from '@/lib/editor/actions'
import {
  findConsecutiveImageRun,
  findImageAt,
  findMarkdownImages,
  moveBlockContaining,
  moveImageToPosition,
  moveImageWithinRun,
  parseImageAlign,
  parseImageTitle,
  removeImageFromDoc,
  serializeImageTitle,
  setImageAlignAt,
  setImageMasonryAt,
  setImageSizeAt,
} from '@/lib/editor/image-align'

function apply(
  doc: string,
  from: number,
  id:
    | 'imageAlignLeft'
    | 'imageAlignCenter'
    | 'imageAlignRight'
    | 'imageSizeSm'
    | 'imageSizeMd'
    | 'imageSizeLg'
    | 'imageSizeFull'
    | 'imageCropRounded'
    | 'imageCropCircle'
    | 'imageCropSquare'
    | 'imageCropWide'
    | 'imageCropTall'
    | 'imageMasonry'
    | 'imageGapFlush'
    | 'imageGapSm'
    | 'imageGapMd'
    | 'imageGapLg'
    | 'imageMoveUp'
    | 'imageMoveDown',
) {
  const patch = applyAction(doc, from, from, id)
  return doc.slice(0, patch.from) + patch.insert + doc.slice(patch.to)
}

describe('parseImageAlign', () => {
  it('accepts exact keywords only', () => {
    expect(parseImageAlign('left')).toBe('left')
    expect(parseImageAlign('Center')).toBe('center')
    expect(parseImageAlign('RIGHT')).toBe('right')
    expect(parseImageAlign('Photo of a cat')).toBeNull()
    expect(parseImageAlign('')).toBeNull()
  })

  it('reads align beside a thumb token', () => {
    expect(parseImageAlign('center thumb:blob:bafythumb')).toBe('center')
    expect(parseImageTitle('thumb:blob:bafythumb').thumbUrl).toBe('blob:bafythumb')
    expect(parseImageTitle('right thumb:blob:bafythumb')).toEqual({
      align: 'right',
      size: null,
      crop: null,
      masonry: false,
      gap: null,
      thumbUrl: 'blob:bafythumb',
      width: null,
      height: null,
      isCaption: false,
    })
  })

  it('reads intrinsic dimensions', () => {
    expect(parseImageTitle('1600x900')).toEqual({
      align: null,
      size: null,
      crop: null,
      masonry: false,
      gap: null,
      thumbUrl: null,
      width: 1600,
      height: 900,
      isCaption: false,
    })
    expect(parseImageTitle('center thumb:blob:x 800x600')).toEqual({
      align: 'center',
      size: null,
      crop: null,
      masonry: false,
      gap: null,
      thumbUrl: 'blob:x',
      width: 800,
      height: 600,
      isCaption: false,
    })
  })

  it('reads display size tokens', () => {
    expect(parseImageTitle('md')).toEqual({
      align: null,
      size: 'md',
      crop: null,
      masonry: false,
      gap: null,
      thumbUrl: null,
      width: null,
      height: null,
      isCaption: false,
    })
    expect(parseImageTitle('left sm thumb:blob:x 800x600')).toEqual({
      align: 'left',
      size: 'sm',
      crop: null,
      masonry: false,
      gap: null,
      thumbUrl: 'blob:x',
      width: 800,
      height: 600,
      isCaption: false,
    })
  })

  it('reads masonry token', () => {
    expect(parseImageTitle('masonry')).toEqual({
      align: null,
      size: null,
      crop: null,
      masonry: true,
      gap: null,
      thumbUrl: null,
      width: null,
      height: null,
      isCaption: false,
    })
    expect(parseImageTitle('md masonry 800x600')).toEqual({
      align: null,
      size: 'md',
      crop: null,
      masonry: true,
      gap: null,
      thumbUrl: null,
      width: 800,
      height: 600,
      isCaption: false,
    })
  })

  it('reads crop tokens', () => {
    expect(parseImageTitle('square')).toEqual({
      align: null,
      size: null,
      crop: 'square',
      masonry: false,
      gap: null,
      thumbUrl: null,
      width: null,
      height: null,
      isCaption: false,
    })
    expect(parseImageTitle('left md circle 800x600')).toEqual({
      align: 'left',
      size: 'md',
      crop: 'circle',
      masonry: false,
      gap: null,
      thumbUrl: null,
      width: 800,
      height: 600,
      isCaption: false,
    })
  })

  it('reads gallery gap tokens', () => {
    expect(parseImageTitle('masonry gap0').gap).toBe('flush')
    expect(parseImageTitle('masonry gapsm').gap).toBe('sm')
    expect(parseImageTitle('masonry gaplg').gap).toBe('lg')
  })
})

describe('serializeImageTitle', () => {
  it('joins align, size, crop, masonry, gap, thumb, and dimensions', () => {
    expect(serializeImageTitle({ align: 'center', thumbUrl: 'blob:x' })).toBe(
      'center thumb:blob:x',
    )
    expect(serializeImageTitle({ thumbUrl: 'blob:x' })).toBe('thumb:blob:x')
    expect(serializeImageTitle({ width: 1600, height: 900 })).toBe('1600x900')
    expect(
      serializeImageTitle({ align: 'left', size: 'sm', thumbUrl: 'blob:t', width: 800, height: 600 }),
    ).toBe('left sm thumb:blob:t 800x600')
    expect(serializeImageTitle({ size: 'full' })).toBeNull()
    expect(serializeImageTitle({ size: 'lg' })).toBe('lg')
    expect(serializeImageTitle({ masonry: true })).toBe('masonry')
    expect(serializeImageTitle({ size: 'md', masonry: true })).toBe('md masonry')
    expect(serializeImageTitle({ crop: 'wide' })).toBe('wide')
    expect(serializeImageTitle({ size: 'sm', crop: 'rounded', masonry: true })).toBe(
      'sm rounded masonry',
    )
    expect(serializeImageTitle({ masonry: true, gap: 'flush' })).toBe('masonry gap0')
    expect(serializeImageTitle({ masonry: true, gap: 'md' })).toBe('masonry')
    expect(serializeImageTitle({ masonry: true, gap: 'lg' })).toBe('masonry gaplg')
    expect(serializeImageTitle({})).toBeNull()
  })
})

describe('setImageAlignAt', () => {
  it('adds an alignment title to a plain image', () => {
    const doc = 'Hello\n\n![Cat](blob:bafy)\n\nMore'
    const img = findImageAt(doc, doc.indexOf('!['))
    expect(img?.align).toBeNull()
    const patch = setImageAlignAt(doc, img!.from, img!.from, 'center')
    expect(patch).not.toBeNull()
    const next = doc.slice(0, patch!.from) + patch!.insert + doc.slice(patch!.to)
    expect(next).toContain('![Cat](blob:bafy "center")')
  })

  it('toggles the same alignment off', () => {
    const doc = '![Cat](blob:bafy "left")'
    expect(apply(doc, 0, 'imageAlignLeft')).toBe('![Cat](blob:bafy)')
  })

  it('switches between alignments', () => {
    const doc = '![Cat](blob:bafy "left")'
    expect(apply(doc, 0, 'imageAlignRight')).toBe('![Cat](blob:bafy "right")')
  })

  it('preserves thumb and dimensions when changing alignment', () => {
    const doc = '![Cat](blob:bafy "thumb:blob:tiny 1200x800")'
    expect(apply(doc, 0, 'imageAlignCenter')).toBe(
      '![Cat](blob:bafy "center thumb:blob:tiny 1200x800")',
    )
    expect(apply('![Cat](blob:bafy "center thumb:blob:tiny 1200x800")', 0, 'imageAlignCenter')).toBe(
      '![Cat](blob:bafy "thumb:blob:tiny 1200x800")',
    )
  })

  it('preserves size when changing alignment', () => {
    const doc = '![Cat](blob:bafy "md")'
    expect(apply(doc, 0, 'imageAlignLeft')).toBe('![Cat](blob:bafy "left md")')
  })

  it('no-ops when the caret is not on an image', () => {
    const doc = 'Just text'
    expect(apply(doc, 0, 'imageAlignCenter')).toBe(doc)
  })

  it('marks the active alignment in the toolbar state', () => {
    const doc = '![Cat](blob:bafy "center")'
    const active = activeActions(doc, 0, 0)
    expect(active.has('imageAlignCenter')).toBe(true)
    expect(active.has('imageAlignLeft')).toBe(false)
  })
})

describe('setImageSizeAt', () => {
  it('adds a size token to a plain image', () => {
    const doc = '![Cat](blob:bafy)'
    const patch = setImageSizeAt(doc, 0, 0, 'sm')
    expect(patch).not.toBeNull()
    const next = doc.slice(0, patch!.from) + patch!.insert + doc.slice(patch!.to)
    expect(next).toBe('![Cat](blob:bafy "sm")')
  })

  it('switches sizes and preserves align/thumb/dims', () => {
    const doc = '![Cat](blob:bafy "left thumb:blob:t 800x600")'
    expect(apply(doc, 0, 'imageSizeMd')).toBe(
      '![Cat](blob:bafy "left md thumb:blob:t 800x600")',
    )
    expect(apply('![Cat](blob:bafy "left md thumb:blob:t 800x600")', 0, 'imageSizeLg')).toBe(
      '![Cat](blob:bafy "left lg thumb:blob:t 800x600")',
    )
  })

  it('full clears the size token', () => {
    expect(apply('![Cat](blob:bafy "md")', 0, 'imageSizeFull')).toBe('![Cat](blob:bafy)')
  })

  it('toggles the same size off', () => {
    expect(apply('![Cat](blob:bafy "sm")', 0, 'imageSizeSm')).toBe('![Cat](blob:bafy)')
  })

  it('marks the active size in the toolbar state', () => {
    const doc = '![Cat](blob:bafy "lg")'
    const active = activeActions(doc, 0, 0)
    expect(active.has('imageSizeLg')).toBe(true)
    expect(active.has('imageSizeSm')).toBe(false)
  })

  it('treats missing size as full', () => {
    const doc = '![Cat](blob:bafy)'
    const active = activeActions(doc, 0, 0)
    expect(active.has('imageSizeFull')).toBe(true)
  })
})

describe('setImageCropAt', () => {
  it('adds a crop token to a plain image', () => {
    expect(apply('![Cat](blob:bafy)', 0, 'imageCropSquare')).toBe(
      '![Cat](blob:bafy "square")',
    )
  })

  it('switches crops and preserves align/size/thumb/dims', () => {
    const doc = '![Cat](blob:bafy "left sm thumb:blob:t 800x600")'
    expect(apply(doc, 0, 'imageCropWide')).toBe(
      '![Cat](blob:bafy "left sm wide thumb:blob:t 800x600")',
    )
    expect(apply('![Cat](blob:bafy "left sm wide thumb:blob:t 800x600")', 0, 'imageCropCircle')).toBe(
      '![Cat](blob:bafy "left sm circle thumb:blob:t 800x600")',
    )
  })

  it('toggles the same crop off', () => {
    expect(apply('![Cat](blob:bafy "rounded")', 0, 'imageCropRounded')).toBe('![Cat](blob:bafy)')
  })

  it('marks the active crop in the toolbar state', () => {
    const active = activeActions('![Cat](blob:bafy "tall")', 0, 0)
    expect(active.has('imageCropTall')).toBe(true)
    expect(active.has('imageCropSquare')).toBe(false)
  })
})

describe('setImageMasonryAt', () => {
  it('toggles masonry on and off', () => {
    const doc = '![Cat](blob:bafy)'
    const on = setImageMasonryAt(doc, 0, 0)
    expect(on).not.toBeNull()
    const withMasonry = doc.slice(0, on!.from) + on!.insert + doc.slice(on!.to)
    expect(withMasonry).toBe('![Cat](blob:bafy "masonry")')
    expect(apply(withMasonry, 0, 'imageMasonry')).toBe('![Cat](blob:bafy)')
  })

  it('preserves size, align, and crop', () => {
    expect(apply('![Cat](blob:bafy "left md square")', 0, 'imageMasonry')).toBe(
      '![Cat](blob:bafy "left md square masonry")',
    )
  })

  it('marks masonry active in the toolbar state', () => {
    const active = activeActions('![Cat](blob:bafy "masonry")', 0, 0)
    expect(active.has('imageMasonry')).toBe(true)
  })

  it('enables masonry on the whole consecutive image run', () => {
    const doc = '![A](blob:a)\n\n![B](blob:b)\n\n![C](blob:c)'
    expect(apply(doc, 0, 'imageMasonry')).toBe(
      '![A](blob:a "masonry")\n\n![B](blob:b "masonry")\n\n![C](blob:c "masonry")',
    )
  })

  it('does not cross non-image content when enabling a run', () => {
    const doc = '![A](blob:a)\n\nHello\n\n![B](blob:b)'
    expect(apply(doc, 0, 'imageMasonry')).toBe('![A](blob:a "masonry")\n\nHello\n\n![B](blob:b)')
  })

  it('clears masonry for the whole run when toggling off', () => {
    const doc =
      '![A](blob:a "masonry")\n\n![B](blob:b "masonry")\n\n![C](blob:c "masonry")'
    expect(apply(doc, doc.indexOf('![B]'), 'imageMasonry')).toBe(
      '![A](blob:a)\n\n![B](blob:b)\n\n![C](blob:c)',
    )
  })
})

describe('setImageGapAt', () => {
  it('sets flush gap across the masonry run', () => {
    const doc = '![A](blob:a "masonry")\n\n![B](blob:b "masonry")'
    expect(apply(doc, 0, 'imageGapFlush')).toBe(
      '![A](blob:a "masonry gap0")\n\n![B](blob:b "masonry gap0")',
    )
  })

  it('resets default gap by omitting the token', () => {
    const doc = '![A](blob:a "masonry gap0")\n\n![B](blob:b "masonry gap0")'
    expect(apply(doc, 0, 'imageGapMd')).toBe(
      '![A](blob:a "masonry")\n\n![B](blob:b "masonry")',
    )
  })

  it('marks the active gap in the toolbar state', () => {
    const active = activeActions('![Cat](blob:bafy "masonry gaplg")', 0, 0)
    expect(active.has('imageGapLg')).toBe(true)
    expect(active.has('imageGapFlush')).toBe(false)
    expect(active.has('imageMasonry')).toBe(true)
  })
})

describe('findConsecutiveImageRun', () => {
  it('groups images separated only by whitespace', () => {
    const doc = '![A](blob:a)\n\n![B](blob:b)\n\nPara\n\n![C](blob:c)'
    const images = findMarkdownImages(doc)
    expect(findConsecutiveImageRun(doc, images[0]!).map((img) => img.alt)).toEqual(['A', 'B'])
    expect(findConsecutiveImageRun(doc, images[2]!).map((img) => img.alt)).toEqual(['C'])
  })
})

describe('moveBlockContaining', () => {
  it('moves an image block down past the next paragraph', () => {
    const doc = '![A](blob:a)\n\nPara\n\n![B](blob:b)'
    const patch = moveBlockContaining(doc, 0, 1)
    expect(patch).not.toBeNull()
    const next = patch!.insert
    expect(next.indexOf('![A]')).toBeGreaterThan(next.indexOf('Para'))
  })

  it('moves an image block up', () => {
    const doc = 'Intro\n\n![A](blob:a)\n\nOutro'
    const img = findImageAt(doc, doc.indexOf('!['))!
    expect(apply(doc, img.from, 'imageMoveUp')).toMatch(/^!\[A]/)
  })
})

describe('moveImageWithinRun', () => {
  it('reorders a gallery run and keeps images adjacent', () => {
    const doc = '![A](blob:a "masonry")\n![B](blob:b "masonry")\n![C](blob:c "masonry")'
    const run = findMarkdownImages(doc)
    const patch = moveImageWithinRun(doc, run, run[0]!, 2)
    expect(patch).not.toBeNull()
    const next = doc.slice(0, patch!.from) + patch!.insert + doc.slice(patch!.to)
    expect(next).toBe('![B](blob:b "masonry")\n![C](blob:c "masonry")\n![A](blob:a "masonry")')
  })

  it('treats the target index as post-removal order', () => {
    const doc = '![A](blob:a "masonry")\n![B](blob:b "masonry")\n![C](blob:c "masonry")'
    const run = findMarkdownImages(doc)
    const patch = moveImageWithinRun(doc, run, run[0]!, 1)
    const next = doc.slice(0, patch!.from) + patch!.insert + doc.slice(patch!.to)
    expect(next).toBe('![B](blob:b "masonry")\n![A](blob:a "masonry")\n![C](blob:c "masonry")')
  })

  it('returns null for single-image runs and out-of-range targets', () => {
    const doc = '![A](blob:a "masonry")'
    const run = findMarkdownImages(doc)
    expect(moveImageWithinRun(doc, run, run[0]!, 0)).toBeNull()
    expect(moveImageWithinRun(doc, run, run[0]!, 3)).toBeNull()
  })
})

describe('removeImageFromDoc', () => {
  it('removes an image that owns its line, newline included', () => {
    const doc = 'Intro\n\n![A](blob:a)\n\nOutro'
    const image = findMarkdownImages(doc)[0]!
    const patch = removeImageFromDoc(doc, image)
    const next = doc.slice(0, patch.from) + doc.slice(patch.to)
    expect(next).toBe('Intro\n\nOutro')
  })

  it('keeps the line when the image shares it with text', () => {
    const doc = 'Lead ![A](blob:a) tail'
    const image = findMarkdownImages(doc)[0]!
    const patch = removeImageFromDoc(doc, image)
    const next = doc.slice(0, patch.from) + doc.slice(patch.to)
    expect(next).toBe('Lead  tail')
  })
})

describe('moveImageToPosition', () => {
  it('moves a gallery image into text as a standalone block', () => {
    const doc = '![A](blob:a "masonry")\n![B](blob:b "masonry")\n\nPara one\n\nPara two'
    const images = findMarkdownImages(doc)
    const patch = moveImageToPosition(doc, images[0]!, doc.indexOf('Para two'))
    expect(patch).not.toBeNull()
    const next = patch!.insert
    expect(next).not.toContain('"masonry")\n![B')
    // The moved image is standalone (no masonry) and sits before Para two.
    expect(next).toMatch(/!\[A\]\(blob:a\)\n\nPara two/)
    expect(next).toContain('![B](blob:b "masonry")')
  })

  it('can place an image at the top of the document (thumbnail)', () => {
    const doc = 'Intro text\n\n![A](blob:a)'
    const image = findMarkdownImages(doc)[0]!
    const patch = moveImageToPosition(doc, image, 0)
    const next = patch!.insert
    expect(next.startsWith('![A](blob:a)')).toBe(true)
    expect(next).toContain('Intro text')
  })
})
