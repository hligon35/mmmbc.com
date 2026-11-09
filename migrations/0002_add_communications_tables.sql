-- Admin user invites (email-allowlist entries granted via an invite-link email flow).
-- Access itself is still enforced by Cloudflare Access; requireAdmin() additionally
-- allows any email found here with status = 'invited', on top of ADMIN_ALLOW_EMAILS.
CREATE TABLE IF NOT EXISTS admin_invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'website_editor',
  status TEXT NOT NULL DEFAULT 'invited', -- invited | revoked
  invited_by TEXT,
  invited_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The original newsletter_records table (from 0001) was never populated by any working
-- code path (the Worker only ever returned a hardcoded empty stub for it), so it is safe
-- to replace with the fuller schema needed for real draft/scheduled/history tracking.
DROP TABLE IF EXISTS newsletter_records;
CREATE TABLE IF NOT EXISTS newsletter_records (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  emails TEXT NOT NULL DEFAULT '[]', -- JSON array of recipient emails
  status TEXT NOT NULL, -- draft | scheduled | sent | skipped | failed | retrying
  sent_count INTEGER NOT NULL DEFAULT 0,
  schedule_at TEXT,
  schedule_date TEXT,
  schedule_time TEXT,
  schedule_timezone TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);
