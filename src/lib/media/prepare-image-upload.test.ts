import { describe, expect, it } from 'vitest'
import { prepareImageUploadPreset } from '@/lib/media/prepare-image-upload'

describe('prepareImageUploadPreset', () => {
  it('exposes article / thumb / header / icon defaults', () => {
    expect(prepareImageUploadPreset('article').maxEdge).toBe(1600)
    expect(prepareImageUploadPreset('thumb').maxEdge).toBe(640)
    expect(prepareImageUploadPreset('header').maxEdge).toBe(800)
    expect(prepareImageUploadPreset('icon').maxEdge).toBe(256)
  })

  it('keeps quality high enough to be visually transparent', () => {
    // Illustrations and flat-colour art smear at low WebP qualities, so every
    // preset stays at or above 0.8 (0.92 for the header mark).
    for (const preset of ['article', 'thumb', 'header', 'icon'] as const) {
      expect(prepareImageUploadPreset(preset).quality).toBeGreaterThanOrEqual(0.8)
    }
    expect(prepareImageUploadPreset('header').quality).toBe(0.92)
  })
})
