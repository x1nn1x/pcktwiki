import Stripe from 'stripe'
import type { Env } from './types'
import { needsShipping, SHIPPING_COUNTRIES, type StoreProduct } from './catalog'

let stripe: Stripe | null = null
let cryptoProvider: Stripe.CryptoProvider | null = null

/**
 * stripe-node runs on Workers with the fetch HTTP client. Webhook signature
 * verification is async on this runtime (no Node crypto), so it needs the
 * SubtleCrypto provider — both cached per isolate.
 */
export function getStripe(env: Env): Stripe {
  stripe ??= new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  })
  return stripe
}

export function verifyWebhookEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  secret: string,
): Promise<Stripe.Event> {
  cryptoProvider ??= Stripe.createSubtleCryptoProvider()
  return stripe.webhooks.constructEventAsync(payload, signature, secret, undefined, cryptoProvider)
}

export interface CheckoutInput {
  amount: number
  interval: 'one_time' | 'month'
  currency: string
  donor: {
    name: string
    company: string
    url: string
    handle: string
    listed: boolean
  }
  tierLabel: string | null
  siteName: string
  /** Public site origin; embedded Checkout needs a return URL. */
  siteUrl: string
}

/**
 * Creates an Embedded Checkout Session (what support.mesh2motion.org does):
 * the browser mounts the session's client_secret and Stripe renders the
 * payment form inline. Donor credit info rides along in metadata so the
 * webhook can build the supporters page without extra round-trips.
 */
export async function createDonationCheckout(
  stripe: Stripe,
  input: CheckoutInput,
): Promise<string> {
  const monthly = input.interval === 'month'
  const productName = monthly
    ? `${input.siteName} monthly support${input.tierLabel ? ` — ${input.tierLabel}` : ''}`
    : `${input.siteName} one-time donation`

  const metadata: Record<string, string> = {
    donor_name: input.donor.name,
    donor_company: input.donor.company,
    donor_url: input.donor.url,
    donor_handle: input.donor.handle,
    donor_listed: input.donor.listed ? '1' : '0',
  }

  const session = await stripe.checkout.sessions.create({
    ui_mode: 'embedded',
    mode: monthly ? 'subscription' : 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency,
          unit_amount: input.amount,
          product_data: { name: productName },
          ...(monthly ? { recurring: { interval: 'month' as const } } : {}),
        },
      },
    ],
    metadata,
    // Embedded Checkout always requires somewhere to return to. `if_required`
    // keeps card payments inline; redirect-based methods come back here.
    return_url: `${input.siteUrl}/donate`,
    redirect_on_completion: 'if_required',
    ...(monthly
      ? { subscription_data: { metadata } }
      : { submit_type: 'donate' as const }),
  })

  return session.client_secret as string
}

export interface StoreCheckoutInput {
  items: Array<{ product: StoreProduct; quantity: number }>
  currency: string
  /** Public site origin, e.g. https://pckt.wiki */
  siteUrl: string
  /** AT Protocol handle of a signed-in buyer, when known. */
  buyerHandle?: string
}

/**
 * Hosted Checkout for the store. A hosted session keeps shipping, tax and
 * payment-method changes in Stripe's hands, and returns a URL the browser can
 * simply navigate to. Physical and print-on-demand carts collect a shipping
 * address; digital-only carts skip it.
 */
export async function createStoreCheckout(
  stripe: Stripe,
  input: StoreCheckoutInput,
): Promise<string> {
  const { items, currency, siteUrl } = input
  const cart = items.map(({ product, quantity }) => `${product.id}:${quantity}`).join(',')
  const metadata: Record<string, string> = { store: '1', cart }
  if (input.buyerHandle) metadata.buyer_handle = input.buyerHandle

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: items.map(({ product, quantity }) => ({
      quantity,
      price_data: {
        currency,
        unit_amount: product.amount,
        product_data: {
          name: product.name,
          ...(product.description ? { description: product.description } : {}),
          ...(product.image ? { images: [product.image] } : {}),
        },
      },
    })),
    customer_creation: 'always',
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    ...(needsShipping(items.map((item) => item.product))
      ? {
          shipping_address_collection: { allowed_countries: [...SHIPPING_COUNTRIES] },
          phone_number_collection: { enabled: true },
        }
      : {}),
    metadata,
    success_url: `${siteUrl}/store/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/store`,
  })

  if (!session.url) throw new Error('Stripe did not return a Checkout URL.')
  return session.url
}
