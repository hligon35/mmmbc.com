-- Cloudflare D1 schema

CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY,
  album TEXT NOT NULL,
  label TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  file_key TEXT NOT NULL,
  thumb_key TEXT,
  original_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gallery_album ON gallery_items(album);
CREATE INDEX IF NOT EXISTS idx_gallery_created_at ON gallery_items(created_at);

CREATE TABLE IF NOT EXISTS giving_donations (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_connected_account_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  fund_code TEXT NOT NULL,
  frequency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL,
  payment_method_type TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  connected_account_id TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_giving_paid_at ON giving_donations(paid_at);
CREATE INDEX IF NOT EXISTS idx_giving_fund ON giving_donations(fund_code);
CREATE INDEX IF NOT EXISTS idx_giving_email ON giving_donations(donor_email);
