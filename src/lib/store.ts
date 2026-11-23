/**
 * Store client — merch and digital goods sold through the donations worker
 * (`worker/`). Products are priced server-side; this module never sends an
 * amount, only product ids and quantities, so a tampered cart cannot change
 * what a buyer pays.
 */

import { DONATIONS_API_URL } from '@/lib/donations'

export type StoreProductKind = 'physical' | 'pod' | 'digital'

export interface StoreProduct {
  id: string
  name: string
  description: string
  /** Price in minor units (cents). */
  amount: number
  kind: StoreProductKind
  image?: string
}

export interface StoreOrderItem {
  productId: string
  name: string
  kind: StoreProductKind
  amount: number
  quantity: number
}

export interface StoreOrder {
  amount: number
  currency: string
  createdAt: string
  items: StoreOrderItem[]
  downloads: Array<{ name: string; url: string }>
}

export function isStoreConfigured(): boolean {
  return DONATIONS_API_URL !== null
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!DONATIONS_API_URL) throw new Error('The store is not connected yet.')
  const response = await fetch(`${DONATIONS_API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Store API error ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Products and currency share the donations `/api/config` endpoint. */
export async function fetchStoreConfig(): Promise<{
  currency: string
  products: StoreProduct[]
}> {
  const config = await api<{ currency?: string; products?: StoreProduct[] }>('/api/config')
  return {
    currency: config.currency ?? 'usd',
    products: Array.isArray(config.products) ? config.products : [],
  }
}

/** Creates a hosted Checkout Session and returns the URL to send the buyer to. */
export async function startStoreCheckout(
  items: Array<{ id: string; quantity: number }>,
  handle?: string,
): Promise<string> {
  const { url } = await api<{ url: string }>('/api/store/checkout', {
    method: 'POST',
    body: JSON.stringify({ items, handle }),
  })
  if (!url) throw new Error('Stripe did not return a checkout URL.')
  return url
}

export async function fetchStoreOrder(sessionId: string): Promise<StoreOrder> {
  return api<StoreOrder>(`/api/store/order?session_id=${encodeURIComponent(sessionId)}`)
}

export const KIND_LABEL: Record<StoreProductKind, string> = {
  physical: 'Made and posted by hand',
  pod: 'Printed and shipped on demand',
  digital: 'Instant download',
}
