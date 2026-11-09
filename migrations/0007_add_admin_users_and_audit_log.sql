CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'website_editor'
    CHECK (role IN ('administrator', 'website_editor', 'finance_entry', 'treasurer', 'auditor')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  invited_by TEXT,
  invited_at TEXT NOT NULL,
  activated_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_users_status_role
  ON admin_users(status, role);
CREATE INDEX IF NOT EXISTS idx_admin_users_email_normalized
  ON admin_users(lower(email));
CREATE INDEX IF NOT EXISTS idx_admin_users_role
  ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_users_status
  ON admin_users(status);
CREATE INDEX IF NOT EXISTS idx_admin_users_last_login
  ON admin_users(last_login_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_email TEXT NOT NULL COLLATE NOCASE,
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_email TEXT COLLATE NOCASE,
  previous_value_json TEXT,
  new_value_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
  ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
  ON admin_audit_log(actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target_email
  ON admin_audit_log(target_email, created_at DESC);

INSERT OR IGNORE INTO admin_users (
  id, email, full_name, role, status, invited_by, invited_at,
  activated_at, last_login_at, created_at, updated_at
)
SELECT
  id,
  lower(trim(email)),
  '',
  CASE
    WHEN lower(trim(role)) IN ('administrator', 'website_editor', 'finance_entry', 'treasurer', 'auditor')
      THEN lower(trim(role))
    ELSE 'website_editor'
  END,
  CASE WHEN lower(trim(status)) = 'revoked' THEN 'revoked' ELSE 'active' END,
  lower(trim(COALESCE(invited_by, ''))),
  invited_at,
  CASE WHEN lower(trim(status)) = 'revoked' THEN NULL ELSE invited_at END,
  NULL,
  invited_at,
  updated_at
FROM admin_invites
WHERE trim(COALESCE(email, '')) <> '';