-- Zeffy imports intentionally stay outside finance_entries (manual bookkeeping).
CREATE TABLE IF NOT EXISTS zeffy_payments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  donor_name TEXT NOT NULL DEFAULT '',
  donor_email TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT '',
  amount_value TEXT NOT NULL DEFAULT '',
  refund_json TEXT NOT NULL DEFAULT 'null',
  seen_run TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0,1)),
  synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zeffy_payments_date ON zeffy_payments(created_at DESC,id);
CREATE TABLE IF NOT EXISTS zeffy_sync_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  scope TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  run_started INTEGER,
  campaign_index INTEGER NOT NULL DEFAULT 0,
  cursor TEXT NOT NULL DEFAULT '',
  last_success TEXT,
  last_attempt TEXT,
  last_error TEXT,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO zeffy_sync_state(id) VALUES(1);
