-- Donations ledger for the pckt.wiki donations worker.
-- Apply with:  npx wrangler d1 execute donations --remote --file=db/schema.sql

-- One row per donor identity (Stripe customer). Credit info comes from the
-- checkout metadata the visitor filled in before paying.
CREATE TABLE IF NOT EXISTS supporters (
  customer_id TEXT PRIMARY KEY,
  subscription_id TEXT,
  name TEXT,
  company TEXT,
  url TEXT,
  handle TEXT,
  listed INTEGER NOT NULL DEFAULT 0,
  tier TEXT,
  monthly_amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'usd',
  subscription_status TEXT,          -- 'active' | 'canceled' | NULL (one-time only)
  total_paid INTEGER NOT NULL DEFAULT 0,
  first_paid_at TEXT,
  last_paid_at TEXT,
  updated_at TEXT NOT NULL
);

-- One row per completed payment (one-time charges and monthly renewals).
-- event_id is UNIQUE so Stripe webhook retries never double-count.
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                -- 'one_time' | 'monthly'
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  session_id TEXT,
  invoice_id TEXT,
  subscription_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_donations_created ON donations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_customer ON donations (customer_id);
CREATE INDEX IF NOT EXISTS idx_supporters_listed ON supporters (listed, subscription_status);

-- Store orders. One row per paid Checkout Session for merch or digital goods.
-- event_id is UNIQUE so Stripe webhook retries never duplicate an order.
CREATE TABLE IF NOT EXISTS store_orders (
  session_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  customer_id TEXT,
  email TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  shipping_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_order_items (
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- 'physical' | 'pod' | 'digital'
  amount INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  PRIMARY KEY (session_id, product_id)
);

-- One token per digital item per order. Tokens are random, not derived from
-- the session id, so a shared order link cannot leak someone else's files.
CREATE TABLE IF NOT EXISTS store_downloads (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  file TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_store_orders_created ON store_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_downloads_session ON store_downloads (session_id);
