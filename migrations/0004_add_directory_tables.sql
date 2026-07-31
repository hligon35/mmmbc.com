-- Directory and newsletter relationship model.
-- Directory contacts are canonical church records.
-- Newsletter subscribers are opt-in delivery records and remain distinct.

CREATE TABLE IF NOT EXISTS directory_contacts (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  suffix TEXT,
  contact_type TEXT NOT NULL DEFAULT 'member',
  membership_status TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  primary_email TEXT,
  secondary_email TEXT,
  mobile_phone TEXT,
  home_phone TEXT,
  preferred_contact_method TEXT,
  address_line_1 TEXT,
  address_line_2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  birth_month INTEGER,
  birth_day INTEGER,
  anniversary_month INTEGER,
  anniversary_day INTEGER,
  member_since TEXT,
  notes TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  normalized_primary_phone TEXT,
  normalized_home_phone TEXT
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES directory_contacts(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  consent_source TEXT,
  consent_date TEXT,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  suppression_reason TEXT,
  last_emailed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'ministry',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES directory_groups(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES directory_contacts(id) ON DELETE CASCADE,
  role TEXT,
  joined_at TEXT NOT NULL,
  ended_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS newsletter_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS newsletter_list_members (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES newsletter_lists(id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE IF NOT EXISTS directory_activity_log (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_subscribers_email
  ON newsletter_subscribers(email);

CREATE INDEX IF NOT EXISTS idx_directory_contacts_status_archived
  ON directory_contacts(status, archived_at);

CREATE INDEX IF NOT EXISTS idx_directory_contacts_name
  ON directory_contacts(last_name, first_name);

CREATE INDEX IF NOT EXISTS idx_directory_contacts_email
  ON directory_contacts(primary_email);

CREATE INDEX IF NOT EXISTS idx_directory_contacts_mobile_norm
  ON directory_contacts(normalized_primary_phone);

CREATE INDEX IF NOT EXISTS idx_directory_contacts_home_norm
  ON directory_contacts(normalized_home_phone);

CREATE INDEX IF NOT EXISTS idx_directory_group_members_group
  ON directory_group_members(group_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_directory_group_members_contact
  ON directory_group_members(contact_id, ended_at);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_status
  ON newsletter_subscribers(status);

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_contact
  ON newsletter_subscribers(contact_id);

CREATE INDEX IF NOT EXISTS idx_newsletter_lists_status
  ON newsletter_lists(status);

CREATE INDEX IF NOT EXISTS idx_newsletter_list_members_list
  ON newsletter_list_members(list_id, removed_at);

CREATE INDEX IF NOT EXISTS idx_newsletter_list_members_subscriber
  ON newsletter_list_members(subscriber_id, removed_at);

CREATE INDEX IF NOT EXISTS idx_directory_activity_entity
  ON directory_activity_log(entity_type, entity_id, created_at);

CREATE INDEX IF NOT EXISTS idx_directory_activity_actor
  ON directory_activity_log(actor_email, created_at);
