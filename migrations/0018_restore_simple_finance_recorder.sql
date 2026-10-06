-- Restore the simple money-recording ledger only.
-- The retired finance dashboard, funds/transfers, reconciliation, clergy housing,
-- envelope tools, donor accounting, board reports, and other advanced finance
-- tooling remain removed.
CREATE TABLE IF NOT EXISTS finance_entries (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income','expense')),
  category TEXT,
  fund TEXT,
  method TEXT,
  party TEXT,
  memo TEXT,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_entries_date ON finance_entries(entry_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_entries_type_date ON finance_entries(type, entry_date DESC);
