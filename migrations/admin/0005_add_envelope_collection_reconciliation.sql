-- Envelope scan + Sunday collection reconciliation model.
-- Money values are stored in integer cents.

CREATE TABLE IF NOT EXISTS finance_donors (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  household_id TEXT,
  mailing_address TEXT,
  email TEXT,
  phone TEXT,
  statement_delivery TEXT NOT NULL DEFAULT 'mail',
  active INTEGER NOT NULL DEFAULT 1,
  statement_eligible INTEGER NOT NULL DEFAULT 1,
  envelope_number TEXT UNIQUE,
  envelope_code TEXT UNIQUE,
  envelope_code_status TEXT NOT NULL DEFAULT 'inactive',
  envelope_code_issued_at TEXT,
  envelope_code_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_donor_envelope_codes (
  id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL REFERENCES finance_donors(id) ON DELETE CASCADE,
  envelope_code TEXT NOT NULL UNIQUE,
  envelope_number_snapshot TEXT,
  status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  replaced_by_code TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS finance_collection_batches (
  id TEXT PRIMARY KEY,
  service_date TEXT NOT NULL,
  service_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  declared_physical_cash_cents INTEGER NOT NULL DEFAULT 0,
  declared_check_cents INTEGER NOT NULL DEFAULT 0,
  calculated_envelope_total_cents INTEGER NOT NULL DEFAULT 0,
  calculated_loose_cash_total_cents INTEGER NOT NULL DEFAULT 0,
  calculated_batch_total_cents INTEGER NOT NULL DEFAULT 0,
  discrepancy_cents INTEGER NOT NULL DEFAULT 0,
  discrepancy_explanation TEXT,
  count_sheet_attachment_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  deposit_date TEXT,
  deposit_reference TEXT,
  deposited_amount_cents INTEGER,
  deposit_confirmed_at TEXT,
  deposit_verified_by TEXT,
  deposit_internal_control_exception TEXT,
  approval_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_collection_counters (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
  counter_email TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  UNIQUE(batch_id, counter_email)
);

CREATE TABLE IF NOT EXISTS finance_collection_counter_approvals (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
  counter_email TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  batch_version INTEGER NOT NULL,
  UNIQUE(batch_id, counter_email, batch_version)
);

CREATE TABLE IF NOT EXISTS finance_collection_envelopes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
  donor_id TEXT NOT NULL REFERENCES finance_donors(id),
  envelope_code_snapshot TEXT,
  envelope_number_snapshot TEXT,
  payment_method TEXT NOT NULL,
  check_number TEXT,
  envelope_total_cents INTEGER NOT NULL,
  entry_status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_collection_allocations (
  id TEXT PRIMARY KEY,
  envelope_entry_id TEXT NOT NULL REFERENCES finance_collection_envelopes(id) ON DELETE CASCADE,
  fund_id TEXT,
  fund_code TEXT,
  amount_cents INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_collection_loose_giving (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES finance_collection_batches(id) ON DELETE CASCADE,
  fund_id TEXT,
  fund_code TEXT,
  payment_method TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_collection_audit_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  donor_id TEXT,
  envelope_entry_id TEXT,
  event_type TEXT NOT NULL,
  event_action TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_envelope_unique_batch_code
  ON finance_collection_envelopes(batch_id, envelope_code_snapshot);

CREATE INDEX IF NOT EXISTS idx_finance_donors_name
  ON finance_donors(last_name, first_name);

CREATE INDEX IF NOT EXISTS idx_finance_donors_envelope_number
  ON finance_donors(envelope_number);

CREATE INDEX IF NOT EXISTS idx_finance_donor_codes_code
  ON finance_donor_envelope_codes(envelope_code);

CREATE INDEX IF NOT EXISTS idx_finance_batch_service_date
  ON finance_collection_batches(service_date);

CREATE INDEX IF NOT EXISTS idx_finance_batch_status
  ON finance_collection_batches(status);

CREATE INDEX IF NOT EXISTS idx_finance_envelope_batch
  ON finance_collection_envelopes(batch_id, created_at);

CREATE INDEX IF NOT EXISTS idx_finance_envelope_donor
  ON finance_collection_envelopes(donor_id, created_at);

CREATE INDEX IF NOT EXISTS idx_finance_alloc_fund
  ON finance_collection_allocations(fund_id, fund_code);

CREATE INDEX IF NOT EXISTS idx_finance_loose_batch
  ON finance_collection_loose_giving(batch_id, created_at);

CREATE INDEX IF NOT EXISTS idx_finance_audit_batch_time
  ON finance_collection_audit_events(batch_id, created_at);
