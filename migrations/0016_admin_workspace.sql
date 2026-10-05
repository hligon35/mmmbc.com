-- Workspace metadata lives beside its sources, allowing indexed joins without
-- copying church records across the two physically separate D1 databases.
CREATE TABLE mailbox_state (
  item_key TEXT PRIMARY KEY,
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK(folder IN ('inbox','archive','deleted')),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX idx_mailbox_state_folder ON mailbox_state(folder,is_read,starred);
INSERT INTO mailbox_state(item_key,folder,is_read,updated_at,updated_by)
SELECT 'contact:'||id, CASE WHEN archived_at IS NULL THEN 'inbox' ELSE 'archive' END,
  CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at, 'system:migration' FROM contact_messages;
INSERT INTO mailbox_state(item_key,folder,is_read,updated_at,updated_by)
SELECT 'facility_rental:'||id, CASE WHEN archived_at IS NULL THEN 'inbox' ELSE 'archive' END,
  CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at, 'system:migration' FROM facility_rental_requests;
CREATE TABLE mailbox_drafts (
  actor TEXT NOT NULL, draft_key TEXT NOT NULL,
  recipient TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(actor,draft_key)
);
CREATE TABLE mailbox_outbound (
  id TEXT PRIMARY KEY, item_key TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL,
  recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','accepted','failed','uncertain')),
  provider_id TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT
);
CREATE INDEX idx_mailbox_outbound_thread ON mailbox_outbound(item_key,created_at);
CREATE INDEX idx_mailbox_outbound_actor ON mailbox_outbound(actor,created_at);
CREATE TABLE rental_workflow (
  rental_id TEXT PRIMARY KEY REFERENCES facility_rental_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  version INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_rental_workflow_status ON rental_workflow(status);
CREATE TABLE workspace_audit (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, item_key TEXT NOT NULL,
  action TEXT NOT NULL, value_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_audit_item ON workspace_audit(item_key,created_at);
