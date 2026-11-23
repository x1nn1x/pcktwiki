export interface Env {
  DB: D1Database
  STRIPE_SECRET_KEY: string
  STRIPE_PUBLISHABLE_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  /** Comma-separated origins allowed to call config/checkout, e.g. "https://pckt.wiki,http://127.0.0.1:5173". */
  ALLOWED_ORIGINS: string
  /** ISO currency code for all donations and products, lowercase (e.g. "usd"). */
  CURRENCY?: string
  SITE_NAME?: string
  /** Public site origin used for Checkout return URLs, e.g. https://pckt.wiki */
  SITE_URL?: string
  /**
   * Cloudflare rate-limit binding (see wrangler.jsonc). Guards config/checkout
   * against session-creation spam; optional so local dev runs without it.
   */
  RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }
}

export interface DonorInfo {
  name: string
  company: string
  url: string
  handle: string
  listed: boolean
}
