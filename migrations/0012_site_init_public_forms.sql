-- "site" D1 database: anonymous public-form submissions only. Never joined
-- against the "admin" D1 database (physically separate databases).

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received', -- received | emailed | email_failed
  email_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at);

CREATE TABLE IF NOT EXISTS facility_rental_requests (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'member', -- member | non_member
  person_responsible TEXT NOT NULL,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  date_of_use TEXT NOT NULL,
  time_from TEXT NOT NULL,
  time_to TEXT NOT NULL,
  contact_email TEXT,
  form_json TEXT NOT NULL DEFAULT '{}', -- full submitted form, for admin review
  status TEXT NOT NULL DEFAULT 'received', -- received | emailed | email_failed
  email_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facility_rental_requests_created_at ON facility_rental_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_facility_rental_requests_date_of_use ON facility_rental_requests(date_of_use);

-- Lightweight D1-backed rate limiting for anonymous public form endpoints.
-- key = sha256(form_type + ':' + CF-Connecting-IP); one row per submission, pruned by age.
CREATE TABLE IF NOT EXISTS form_rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form_rate_limits_key_created ON form_rate_limits(rate_key, created_at);

