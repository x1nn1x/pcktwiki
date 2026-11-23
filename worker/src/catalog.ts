/**
 * Store catalogue.
 *
 * Prices live here rather than in the Stripe dashboard so a product change is
 * a code change with review, and test/live mode share the same list. Checkout
 * sends them as inline `price_data`, which means no Products or Prices need to
 * exist in Stripe before the first sale.
 *
 * Replace the placeholder rows before going live. `kind` decides fulfilment:
 *   physical — you pack and post it; Checkout collects a shipping address
 *   pod      — print-on-demand partner produces and ships it
 *   digital  — no shipping; the buyer gets a download link after payment
 */

export type ProductKind = 'physical' | 'pod' | 'digital'

export interface StoreProduct {
  /** Stable slug used in carts and order rows. Changing it breaks old links. */
  id: string
  name: string
  description: string
  /** Price in minor units (cents). */
  amount: number
  kind: ProductKind
  /** Optional absolute image URL shown in Stripe Checkout. */
  image?: string
  /** Digital goods: absolute URL of the file the buyer downloads. */
  file?: string
  active?: boolean
}

export const STORE_PRODUCTS: StoreProduct[] = [
  {
    id: 'osean-tee',
    name: 'OSEAN WORLD tee',
    description: 'Heavyweight cotton tee, printed to order. Unisex sizes S–3XL.',
    amount: 3200,
    kind: 'pod',
    active: false,
  },
  {
    id: 'pckt-sticker-pack',
    name: 'pckt sticker pack',
    description: 'Five die-cut vinyl stickers. Weatherproof, laptop-sized.',
    amount: 900,
    kind: 'physical',
    active: false,
  },
  {
    id: 'pckt-print',
    name: 'pckt risograph print',
    description: 'A4 two-colour print, signed and posted by hand.',
    amount: 1800,
    kind: 'physical',
    active: false,
  },
  {
    id: 'theme-pack',
    name: 'pckt theme pack',
    description: 'Twelve extra wiki palettes as a downloadable pack.',
    amount: 600,
    kind: 'digital',
    file: 'https://pckt.wiki/downloads/pckt-theme-pack.zip',
    active: false,
  },
]

/** Products a buyer can actually order right now. */
export function activeProducts(): StoreProduct[] {
  return STORE_PRODUCTS.filter((product) => product.active !== false)
}

export function productById(id: string): StoreProduct | undefined {
  return activeProducts().find((product) => product.id === id)
}

export function needsShipping(products: StoreProduct[]): boolean {
  return products.some((product) => product.kind !== 'digital')
}

/** Countries Checkout may ship to. Add rows rather than loosening the list. */
export const SHIPPING_COUNTRIES = [
  'US',
  'CA',
  'GB',
  'IE',
  'DE',
  'FR',
  'NL',
  'BE',
  'ES',
  'IT',
  'SE',
  'DK',
  'NO',
  'FI',
  'AU',
  'NZ',
  'JP',
] as const
