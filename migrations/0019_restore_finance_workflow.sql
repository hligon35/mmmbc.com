-- Restore the lightweight finance workflow without resurrecting the retired finance dashboard.
-- Status/void metadata lives in a companion table so this migration is safe whether
-- finance_entries came from the historical schema or from 0018's simplified schema.

CREATE TABLE IF NOT EXISTS finance_entry_state (
  entry_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','voided')),
  voided_by TEXT,
  voided_at TEXT,
  void_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(entry_id) REFERENCES finance_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_finance_entry_state_status
  ON finance_entry_state(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS finance_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO finance_meta(key,value_json,updated_at)
VALUES(
  'simple-recorder',
  '{"categories":["Tithe","Offering","Donation","Utilities","Building Maintenance","Outreach","Supplies","Other"],"funds":["General Fund","Building Fund","Missions Fund","Benevolence Fund"]}',
  CURRENT_TIMESTAMP
);
