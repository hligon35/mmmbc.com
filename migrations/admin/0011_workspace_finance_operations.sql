-- Extend the existing ledger and reconciliation model; no sample financial data.
CREATE TABLE IF NOT EXISTS finance_fund_profiles (
  fund_id TEXT PRIMARY KEY REFERENCES finance_funds(id),
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_fund_transfers (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  from_fund_id TEXT NOT NULL REFERENCES finance_funds(id),
  to_fund_id TEXT NOT NULL REFERENCES finance_funds(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','declined')),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(from_fund_id <> to_fund_id)
);
CREATE INDEX IF NOT EXISTS idx_fund_transfer_source ON finance_fund_transfers(from_fund_id,status);
CREATE INDEX IF NOT EXISTS idx_fund_transfer_destination ON finance_fund_transfers(to_fund_id,status);
CREATE TABLE IF NOT EXISTS finance_housing_profiles (
  id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_housing_annual_records (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES finance_housing_profiles(id),
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_board_report_packages (
  id TEXT PRIMARY KEY,
  package_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS finance_operations_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  record_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
