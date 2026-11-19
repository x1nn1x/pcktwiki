/**
 * The pckt.blog reference drag UI: while an image is being dragged, a
 * "Drop here to set as thumbnail" strip appears above and a
 * "Drop here to delete" strip below. Pointer-based so the same zones work
 * with mouse and touch.
 */

export type ImageDragZoneKind = 'thumbnail' | 'delete'

export interface ImageDragZones {
  mount(getBounds: () => { top: DOMRect; bottom: DOMRect } | null): void
  hitTest(clientX: number, clientY: number): ImageDragZoneKind | null
  setTarget(kind: ImageDragZoneKind | null): void
  destroy(): void
}

const TOP_LABEL = 'Drop here to set as thumbnail'
const BOTTOM_LABEL = 'Drop here to delete'

const ZONE_STYLES = `
.sd-image-dropzone {
  position: fixed;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  height: 40px;
  border: 1.5px dashed var(--pckt-border, #ccc);
  border-radius: 10px;
  background: color-mix(in srgb, var(--pckt-bg-elevated, #fff) 92%, transparent);
  color: var(--pckt-text-muted, #777);
  font-family: var(--pckt-font-ui, system-ui, sans-serif);
  font-size: 0.8125rem;
  font-weight: 600;
  pointer-events: none;
  opacity: 0.92;
}
.sd-image-dropzone.is-target {
  border-color: var(--pckt-blue, #58a7ff);
  color: var(--pckt-blue, #58a7ff);
  background: color-mix(in srgb, var(--pckt-blue, #58a7ff) 12%, var(--pckt-bg-elevated, #fff));
}
.sd-image-polaroid-ghost {
  z-index: 130;
  padding: 8px 8px 14px;
  background: var(--pckt-bg-elevated, #fff);
  border: 1px solid var(--pckt-border, #ddd);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  transform: rotate(-3deg);
  pointer-events: none;
}
.sd-image-polaroid-ghost img {
  display: block;
  max-width: 180px;
  max-height: 150px;
  object-fit: cover;
  border-radius: 4px;
}
`

let stylesInjected = false

function injectZoneStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  if (!document.getElementById('pckt-drag-zone-styles')) {
    const style = document.createElement('style')
    style.id = 'pckt-drag-zone-styles'
    style.textContent = ZONE_STYLES
    document.head.appendChild(style)
  }
  stylesInjected = true
}

function makeZone(kind: ImageDragZoneKind): HTMLElement {
  const zone = document.createElement('div')
  zone.className = `sd-image-dropzone sd-image-dropzone--${kind}`
  zone.textContent = kind === 'thumbnail' ? TOP_LABEL : BOTTOM_LABEL
  zone.setAttribute('aria-hidden', 'true')
  return zone
}

export function createImageDragZones(): ImageDragZones {
  const top = makeZone('thumbnail')
  const bottom = makeZone('delete')
  let mounted = false
  let getBounds: (() => { top: DOMRect; bottom: DOMRect } | null) | null = null

  function position() {
    if (!mounted || !getBounds) return
    const bounds = getBounds()
    if (!bounds) return
    top.style.left = `${bounds.top.left}px`
    top.style.top = `${bounds.top.top}px`
    top.style.width = `${bounds.top.width}px`
    bottom.style.left = `${bounds.bottom.left}px`
    bottom.style.top = `${bounds.bottom.top}px`
    bottom.style.width = `${bounds.bottom.width}px`
  }

  return {
    mount(nextGetBounds) {
      injectZoneStyles()
      getBounds = nextGetBounds
      if (!mounted) {
        document.body.appendChild(top)
        document.body.appendChild(bottom)
        mounted = true
      }
      position()
    },
    hitTest(clientX, clientY) {
      if (!mounted) return null
      const inRect = (rect: DOMRect) =>
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      if (inRect(top.getBoundingClientRect())) return 'thumbnail'
      if (inRect(bottom.getBoundingClientRect())) return 'delete'
      return null
    },
    setTarget(kind) {
      top.classList.toggle('is-target', kind === 'thumbnail')
      bottom.classList.toggle('is-target', kind === 'delete')
    },
    destroy() {
      top.remove()
      bottom.remove()
      mounted = false
      getBounds = null
    },
  }
}
