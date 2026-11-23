# Donations and store worker

A small Cloudflare Worker + D1 database that gives pckt.wiki a live donations
page — one-time and monthly support via Stripe, live totals, and an automatic
supporters credits wall — and a storefront for merch and digital goods.

The design copies two proven setups:

- **support.mesh2motion.org** — the payment flow. The browser fetches a
  publishable key and Checkout Session client secrets from this worker and
  mounts Stripe's Embedded Checkout inline. No secret key ever ships to the
  client.
- **fund.blender.org** — the credits model. Every completed payment is
  recorded by a Stripe webhook, and the donate page shows live totals, a
  "latest activity" feed, and tiered supporter credits (companies and
  individuals) for donors who opted in at checkout.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Stripe publishable key, currency, tiers, amount limits |
| POST | `/api/donations/checkout` | Create an Embedded Checkout Session → `{ clientSecret }` |
| GET | `/api/donations/summary` | Total raised, supporter count, monthly total, recent activity |
| GET | `/api/donations/credits` | Corporate / individual / past / one-time supporter lists |
| POST | `/api/store/checkout` | Create a hosted Checkout Session for a cart → `{ url }` |
| GET | `/api/store/order?session_id=…` | Items and download links for a paid order |
| GET | `/api/store/download?token=…` | Redeem a download token (redirects to the file) |
| POST | `/api/webhook` | Stripe webhook target (signature-verified) |

`/api/donations/summary` and `/api/donations/credits` are public reads.
`/api/config` and `/api/donations/checkout` only answer requests whose
`Origin` is listed in `ALLOWED_ORIGINS`. Store reads (`/api/store/order`,
`/api/store/download`) stay public because the buyer arrives from Stripe
without an account; their secrets are the session id and the random download
token.

## Store

Products live in `src/catalog.ts`, not in Stripe. Each row carries an id, a
price in cents, and a `kind`:

| `kind` | Fulfilment |
| --- | --- |
| `physical` | You pack and post it. Checkout collects a shipping address. |
| `pod` | Print-on-demand partner produces and ships it. Checkout collects a shipping address. |
| `digital` | No shipping. The buyer gets a download token after payment. |

Only rows without `active: false` are listed and orderable. Checkout sends
inline `price_data`, so no Products or Prices need to exist in the Stripe
dashboard before the first sale — and a tampered cart cannot change a price,
because the browser only sends ids and quantities.

Digital files are served through `/api/store/download?token=…`. Each token is
random, belongs to one order and one product, and stops working after
`DOWNLOAD_LIMIT` uses (`src/db.ts`). Point `file` at a public URL (R2, a
release asset, or `https://pckt.wiki/downloads/…`).

The storefront is `/store`; Stripe returns to `/store/thanks`. Both hide
unless `VITE_DONATIONS_API_URL` is set, same as the donate page.

## Setup

Requires a [Stripe](https://dashboard.stripe.com/register) account and
[Node](https://nodejs.org). All commands run from this `worker/` directory.

### 1. Install and create the database

```sh
npm install
npx wrangler login
npx wrangler d1 create donations
```

Copy the `database_id` from the output into `wrangler.jsonc`, then create the
tables:

```sh
npx wrangler d1 execute donations --remote --file=db/schema.sql
```

### 2. Add your Stripe keys as secrets

From the Stripe dashboard API keys page take the **secret key**
(`sk_live_…` / `sk_test_…`) and the **publishable key** (`pk_live_…`):

```sh
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PUBLISHABLE_KEY
```

### 3. Deploy and register the webhook

```sh
npx wrangler deploy
```

Note the deployed URL (e.g. `https://pcktwiki-donations.<your-subdomain>.workers.dev`).

In the Stripe dashboard → **Developers → Webhooks → Add endpoint**:

- Endpoint URL: `https://<your-worker-url>/api/webhook`
- Events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `invoice.paid`
  - `customer.subscription.deleted`
  - `customer.subscription.updated`

Copy the signing secret (`whsec_…`) into the worker:

```sh
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 4. Point the site at the worker

In `wrangler.jsonc`, put your site's origin (and `http://127.0.0.1:5173` for
local dev) in `ALLOWED_ORIGINS`, then redeploy. In the site repo, set:

```sh
VITE_DONATIONS_API_URL=https://<your-worker-url>
```

and rebuild/redeploy the site. The **Donate** nav link appears automatically;
without this variable the site simply ships without a donate page.

## Testing

Stripe test mode lets you run the whole flow without real money. Use test keys
in steps 2–3, then run `npx wrangler dev` locally (apply the schema with
`npm run db:schema:local` first) and pay with the test card `4242 4242 4242
4242`, any future expiry and CVC. For local webhook delivery:

```sh
stripe listen --forward-to localhost:8787/api/webhook
```

Test-mode donations and test-mode credits are separate from live data —
switching keys switches datasets.

## How the pieces fit together

1. Visitor picks an amount (one-time or monthly tier) and fills in an optional
   display name, company, and link, plus a "list me on the supporters page"
   checkbox. Signed-in visitors get their AT Protocol handle prefilled.
2. `POST /api/donations/checkout` validates the amount (currently $1–$10,000)
   and opens a Checkout Session — `mode: payment` for one-time,
   `mode: subscription` with a monthly price for supporters — with the credit
   info stashed in session metadata.
3. The site mounts Stripe Embedded Checkout with the returned client secret.
   Card details go straight from the browser to Stripe; the wiki never sees
   them.
4. When the payment completes, Stripe calls `/api/webhook`. The worker
   verifies the signature, records the payment in D1 (idempotent by Stripe
   event id), and upserts the supporter: name/company/link/tier, plus the
   active subscription for monthly donors.
5. Renewals arrive as `invoice.paid` (`billing_reason: subscription_cycle`)
   and extend the supporter's total. Cancellations (`customer.subscription.*`)
   mark the supporter inactive — they move to "Past supporters" and stop
   counting toward the monthly total, like the Blender fund does.
6. The donate page reads `/api/donations/summary` and
   `/api/donations/credits` and renders the live numbers and the credits
   wall.

## Customizing

- **Tiers**: edit `TIERS` in `src/config.ts` (labels, amounts). The site
  picks the tier list up from `/api/config` — no frontend change needed.
- **Currency**: set `CURRENCY` in `wrangler.jsonc` (ISO code, lowercase).
- **Amount limits**: `MIN_AMOUNT` / `MAX_AMOUNT` in `src/config.ts`.
- **Corporate logos**: corporate sponsors are listed under the company name
  with a link; the Blender-style logo wall is a natural next step (add a logo
  URL column to `supporters` and render it in
  `SupportersCredits.vue`).
- **Receipts**: Stripe emails receipts automatically for one-time payments;
  enable subscription invoices under *Settings → Billing → Subscriptions and
  emails*.

## Privacy notes

- Donor names/credits are strictly opt-in via the checkout checkbox.
- The "latest activity" feed shows unlisted donors as "Someone".
- The `donor_handle` metadata is client-supplied; anyone could claim a handle
  they don't own. If that ever matters, have the worker verify the handle via
  a signed challenge from the site before storing it.

## Security posture

- **Webhook auth**: every event is verified with `constructEventAsync` and the
  signing secret; bodies over 400 KB are rejected, and the `donations.event_id`
  UNIQUE constraint makes processing exactly-once — retries after partial
  failures replay a transactional D1 batch instead of double-counting.
- **Input validation**: amounts must be whole numbers within `MIN_AMOUNT`–
  `MAX_AMOUNT`, intervals are whitelisted, and donor strings/URLs are
  length-capped and scheme-checked before storage.
- **Abuse limits**: `/api/config` and `/api/donations/checkout` are rate
  limited per IP (20/min) via the Workers rate-limit binding, and only answer
  origins listed in `ALLOWED_ORIGINS`.
- **SQL**: every query uses bound parameters; there is no string-built SQL
  from request data.
