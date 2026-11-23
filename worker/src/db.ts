import type { DonorInfo, Env } from './types'
import { tierForAmount } from './config'

interface PaymentInput {
  eventId: string
  kind: 'one_time' | 'monthly'
  amount: number
  currency: string
  customerId: string
  subscriptionId: string | null
  sessionId?: string | null
  invoiceId?: string | null
  paidAt: string
}

function donationInsertStmt(env: Env, input: PaymentInput) {
  return env.DB.prepare(
    `INSERT INTO donations
       (event_id, kind, amount, currency, customer_id, session_id, invoice_id, subscription_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    input.eventId,
    input.kind,
    input.amount,
    input.currency,
    input.customerId,
    input.sessionId ?? null,
    input.invoiceId ?? null,
    input.subscriptionId,
    input.paidAt,
  )
}

/**
 * Credit info rides in the INSERT values; ON CONFLICT folds the new payment
 * into the existing row. Donor-entered fields only move forward: new
 * non-empty values win, and once someone agreed to be listed they stay
 * listed. One-time payments (NULL monthly fields) never disturb an existing
 * subscription state.
 */
function supporterUpsertStmt(env: Env, input: PaymentInput, donor: DonorInfo) {
  const monthly = input.kind === 'monthly'
  return env.DB.prepare(
    `INSERT INTO supporters
       (customer_id, subscription_id, name, company, url, handle, listed, tier,
        monthly_amount, currency, subscription_status, total_paid, first_paid_at,
        last_paid_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14)
     ON CONFLICT(customer_id) DO UPDATE SET
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE supporters.name END,
       company = CASE WHEN excluded.company != '' THEN excluded.company ELSE supporters.company END,
       url = CASE WHEN excluded.url != '' THEN excluded.url ELSE supporters.url END,
       handle = CASE WHEN excluded.handle != '' THEN excluded.handle ELSE supporters.handle END,
       listed = MAX(supporters.listed, excluded.listed),
       tier = COALESCE(excluded.tier, supporters.tier),
       monthly_amount = COALESCE(excluded.monthly_amount, supporters.monthly_amount),
       subscription_id = COALESCE(excluded.subscription_id, supporters.subscription_id),
       subscription_status = COALESCE(excluded.subscription_status, supporters.subscription_status),
       total_paid = supporters.total_paid + excluded.total_paid,
       first_paid_at = COALESCE(supporters.first_paid_at, excluded.first_paid_at),
       last_paid_at = excluded.last_paid_at,
       updated_at = excluded.updated_at`,
  ).bind(
    input.customerId,
    input.subscriptionId,
    donor.name,
    donor.company,
    donor.url,
    donor.handle,
    donor.listed ? 1 : 0,
    monthly ? (tierForAmount(input.amount)?.label ?? null) : null,
    monthly ? input.amount : null,
    input.currency,
    monthly ? 'active' : null,
    input.amount,
    input.paidAt,
    new Date().toISOString(),
  )
}

/** D1 surfaces constraint violations as plain SQLite error messages. */
function isUniqueViolation(cause: unknown): boolean {
  return cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)
}

/**
 * Record a completed payment. Each payment is written as ONE transaction:
 * the donations row (whose event_id is UNIQUE) and the supporters upsert
 * either both apply or neither does. A Stripe retry after a partial failure
 * therefore replays the whole batch instead of skipping the supporter write,
 * and a retry after full success no-ops on the UNIQUE constraint — money is
 * counted exactly once, no matter how the webhook is delivered.
 */
export async function recordCompletedCheckout(
  env: Env,
  checkout: {
    eventId: string
    sessionId: string
    customerId: string
    subscriptionId: string | null
    mode: 'payment' | 'subscription'
    amount: number
    currency: string
    createdAt: string
    donor: DonorInfo
  },
): Promise<void> {
  const input: PaymentInput = {
    eventId: checkout.eventId,
    kind: checkout.mode === 'subscription' ? 'monthly' : 'one_time',
    amount: checkout.amount,
    currency: checkout.currency,
    customerId: checkout.customerId,
    subscriptionId: checkout.subscriptionId,
    sessionId: checkout.sessionId,
    paidAt: checkout.createdAt,
  }
  try {
    await env.DB.batch([donationInsertStmt(env, input), supporterUpsertStmt(env, input, checkout.donor)])
  } catch (cause) {
    if (isUniqueViolation(cause)) return
    throw cause
  }
}

/** invoice.paid (billing_reason = subscription_cycle) — a monthly renewal. */
export async function recordMonthlyRenewal(
  env: Env,
  input: {
    eventId: string
    customerId: string
    subscriptionId: string
    amount: number
    currency: string
    paidAt: string
  },
): Promise<void> {
  try {
    await env.DB.batch([
      donationInsertStmt(env, {
        eventId: input.eventId,
        kind: 'monthly',
        amount: input.amount,
        currency: input.currency,
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        paidAt: input.paidAt,
      }),
      env.DB.prepare(
        `UPDATE supporters SET
           subscription_status = 'active',
           total_paid = total_paid + ?2,
           last_paid_at = ?3,
           updated_at = ?4
         WHERE customer_id = ?1`,
      ).bind(input.customerId, input.amount, input.paidAt, new Date().toISOString()),
    ])
  } catch (cause) {
    if (isUniqueViolation(cause)) return
    throw cause
  }
}

/** customer.subscription.deleted / updated-to-canceled — drop out of the
 * monthly totals and move to the "past supporters" credits section. */
export async function markSubscriptionCanceled(
  env: Env,
  subscriptionId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE supporters SET
       subscription_status = 'canceled',
       monthly_amount = NULL,
       updated_at = ?2
     WHERE subscription_id = ?1`,
  )
    .bind(subscriptionId, new Date().toISOString())
    .run()
}

export interface DonationSummary {
  totalRaised: number
  currency: string
  supporterCount: number
  monthlyTotal: number
  activeMonthlyCount: number
  recent: Array<{ amount: number; name: string | null; createdAt: string }>
}

export async function getSummary(env: Env, currency: string): Promise<DonationSummary> {
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT customer_id) AS supporters
     FROM donations WHERE currency = ?1`,
  )
    .bind(currency)
    .first<{ total: number; supporters: number }>()

  const monthly = await env.DB.prepare(
    `SELECT COALESCE(SUM(monthly_amount), 0) AS monthly, COUNT(*) AS active
     FROM supporters WHERE subscription_status = 'active' AND monthly_amount IS NOT NULL AND currency = ?1`,
  )
    .bind(currency)
    .first<{ monthly: number; active: number }>()

  const recent = await env.DB.prepare(
    `SELECT d.amount, d.created_at AS createdAt,
            CASE WHEN s.listed = 1 THEN COALESCE(NULLIF(s.name, ''), s.handle) END AS name
     FROM donations d LEFT JOIN supporters s ON s.customer_id = d.customer_id
     WHERE d.currency = ?1
     ORDER BY d.created_at DESC LIMIT 8`,
  )
    .bind(currency)
    .all<{ amount: number; createdAt: string; name: string | null }>()

  return {
    totalRaised: totals?.total ?? 0,
    currency,
    supporterCount: totals?.supporters ?? 0,
    monthlyTotal: monthly?.monthly ?? 0,
    activeMonthlyCount: monthly?.active ?? 0,
    recent: recent.results ?? [],
  }
}

export interface CreditsResult {
  corporate: Array<{ name: string; url: string | null; tier: string | null; monthlyAmount: number | null; since: string | null }>
  individual: Array<{ name: string; url: string | null; handle: string | null; tier: string | null; monthlyAmount: number | null; since: string | null }>
  past: Array<{ name: string; url: string | null; handle: string | null; tier: string | null; monthlyAmount: number | null; since: string | null }>
  oneTime: Array<{ name: string; url: string | null; handle: string | null; since: string | null }>
}

export async function getCredits(env: Env, currency: string): Promise<CreditsResult> {
  const selectBase = `url, tier, first_paid_at AS since`

  const corporate = await env.DB.prepare(
    `SELECT company AS name, ${selectBase}, monthly_amount AS monthlyAmount
     FROM supporters
     WHERE listed = 1 AND subscription_status = 'active' AND COALESCE(company, '') != '' AND currency = ?1
     ORDER BY monthly_amount DESC LIMIT 100`,
  )
    .bind(currency)
    .all<CreditsResult['corporate'][number]>()

  const individualName = `COALESCE(NULLIF(name, ''), handle) AS name`
  const individual = await env.DB.prepare(
    `SELECT ${individualName}, url, handle, tier, monthly_amount AS monthlyAmount, first_paid_at AS since
     FROM supporters
     WHERE listed = 1 AND subscription_status = 'active' AND COALESCE(company, '') = '' AND currency = ?1
     ORDER BY monthly_amount DESC LIMIT 200`,
  )
    .bind(currency)
    .all<CreditsResult['individual'][number]>()

  const past = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(company, ''), NULLIF(name, ''), handle) AS name,
            url, handle, tier, monthly_amount AS monthlyAmount, first_paid_at AS since
     FROM supporters
     WHERE listed = 1 AND subscription_status = 'canceled' AND currency = ?1
     ORDER BY last_paid_at DESC LIMIT 100`,
  )
    .bind(currency)
    .all<CreditsResult['past'][number]>()

  const oneTime = await env.DB.prepare(
    `SELECT ${individualName}, url, handle, first_paid_at AS since
     FROM supporters
     WHERE listed = 1 AND subscription_id IS NULL AND currency = ?1 AND total_paid > 0
     ORDER BY last_paid_at DESC LIMIT 100`,
  )
    .bind(currency)
    .all<CreditsResult['oneTime'][number]>()

  return {
    corporate: corporate.results ?? [],
    individual: individual.results ?? [],
    past: past.results ?? [],
    oneTime: oneTime.results ?? [],
  }
}

/* ---------------------------------- store --------------------------------- */

export interface StoreOrderItemInput {
  productId: string
  name: string
  kind: string
  amount: number
  quantity: number
}

export interface StoreOrderInput {
  eventId: string
  sessionId: string
  customerId: string | null
  email: string | null
  amount: number
  currency: string
  shipping: unknown
  items: StoreOrderItemInput[]
  /** Files to mint download tokens for, one per digital product. */
  downloads: Array<{ productId: string; file: string }>
  createdAt: string
}

/** How many times one download token may be used. */
export const DOWNLOAD_LIMIT = 25

/**
 * Records a paid store order exactly once. The order insert is the gate: if
 * Stripe retries the webhook, `meta.changes` is 0 and the line items and
 * download tokens are left untouched, so a retry cannot mint new tokens.
 */
export async function recordStoreOrder(env: Env, input: StoreOrderInput): Promise<boolean> {
  const inserted = await env.DB.prepare(
    `INSERT INTO store_orders
       (session_id, event_id, customer_id, email, amount, currency, shipping_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(session_id) DO NOTHING`,
  )
    .bind(
      input.sessionId,
      input.eventId,
      input.customerId,
      input.email,
      input.amount,
      input.currency,
      input.shipping ? JSON.stringify(input.shipping) : null,
      input.createdAt,
    )
    .run()

  if (!inserted.meta.changes) return false

  const statements = [
    ...input.items.map((item) =>
      env.DB.prepare(
        `INSERT INTO store_order_items (session_id, product_id, name, kind, amount, quantity)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
      ).bind(input.sessionId, item.productId, item.name, item.kind, item.amount, item.quantity),
    ),
    ...input.downloads.map((download) =>
      env.DB.prepare(
        `INSERT INTO store_downloads (token, session_id, product_id, file, downloads, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
      ).bind(crypto.randomUUID().replace(/-/g, ''), input.sessionId, download.productId, download.file, input.createdAt),
    ),
  ]

  if (statements.length) await env.DB.batch(statements)
  return true
}

export interface StoreOrderView {
  sessionId: string
  amount: number
  currency: string
  createdAt: string
  items: Array<{ productId: string; name: string; kind: string; amount: number; quantity: number }>
  downloads: Array<{ name: string; token: string }>
}

export async function getStoreOrder(env: Env, sessionId: string): Promise<StoreOrderView | null> {
  const order = await env.DB.prepare(
    `SELECT session_id, amount, currency, created_at FROM store_orders WHERE session_id = ?1`,
  )
    .bind(sessionId)
    .first<{ session_id: string; amount: number; currency: string; created_at: string }>()
  if (!order) return null

  const items = await env.DB.prepare(
    `SELECT product_id, name, kind, amount, quantity
       FROM store_order_items WHERE session_id = ?1 ORDER BY name`,
  )
    .bind(sessionId)
    .all<{ product_id: string; name: string; kind: string; amount: number; quantity: number }>()

  const downloads = await env.DB.prepare(
    `SELECT token, product_id FROM store_downloads WHERE session_id = ?1`,
  )
    .bind(sessionId)
    .all<{ token: string; product_id: string }>()

  const nameFor = (productId: string) =>
    items.results.find((item) => item.product_id === productId)?.name ?? productId

  return {
    sessionId: order.session_id,
    amount: order.amount,
    currency: order.currency,
    createdAt: order.created_at,
    items: items.results.map((item) => ({
      productId: item.product_id,
      name: item.name,
      kind: item.kind,
      amount: item.amount,
      quantity: item.quantity,
    })),
    downloads: downloads.results.map((row) => ({ name: nameFor(row.product_id), token: row.token })),
  }
}

/** File behind a download token, or null when the token is unknown/used up. */
export async function redeemDownload(
  env: Env,
  token: string,
): Promise<{ file: string; downloads: number } | null> {
  const row = await env.DB.prepare(
    `SELECT file, downloads FROM store_downloads WHERE token = ?1`,
  )
    .bind(token)
    .first<{ file: string; downloads: number }>()
  if (!row || row.downloads >= DOWNLOAD_LIMIT) return null

  await env.DB.prepare(`UPDATE store_downloads SET downloads = downloads + 1 WHERE token = ?1`)
    .bind(token)
    .run()

  return { file: row.file, downloads: row.downloads + 1 }
}
