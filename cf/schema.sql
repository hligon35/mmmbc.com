-- Cloudflare D1 schema

CREATE TABLE IF NOT EXISTS gallery_items (
  id TEXT PRIMARY KEY,
  album TEXT NOT NULL,
  label TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  file_key TEXT NOT NULL,
  thumb_key TEXT,
  original_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  position INTEGER,
  is_hidden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_gallery_album ON gallery_items(album);
CREATE INDEX IF NOT EXISTS idx_gallery_created_at ON gallery_items(created_at);
CREATE INDEX IF NOT EXISTS idx_gallery_is_hidden_created_at ON gallery_items(is_hidden, created_at DESC);

CREATE TABLE IF NOT EXISTS giving_donations (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_connected_account_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  fund_code TEXT NOT NULL,
  frequency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL,
  payment_method_type TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS giving_subscription_payments (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT,
  stripe_invoice_id TEXT UNIQUE NOT NULL,
  stripe_subscription_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_connected_account_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  fund_code TEXT NOT NULL,
  amount_due_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL,
  billing_reason TEXT,
  period_start TEXT,
  period_end TEXT,
  paid_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS giving_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_connected_account_id TEXT,
  stripe_customer_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  fund_code TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  platform_fee_percent REAL NOT NULL DEFAULT 2.5,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT,
  current_period_end TEXT,
  canceled_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  connected_account_id TEXT,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_giving_paid_at ON giving_donations(paid_at);
CREATE INDEX IF NOT EXISTS idx_giving_fund ON giving_donations(fund_code);
CREATE INDEX IF NOT EXISTS idx_giving_email ON giving_donations(donor_email);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid_at ON giving_subscription_payments(paid_at);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_subscription ON giving_subscription_payments(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_fund ON giving_subscription_payments(fund_code);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON giving_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON giving_subscriptions(donor_email);

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
  account_number TEXT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_contacts_account_number_unique
  ON directory_contacts(account_number)
  WHERE account_number IS NOT NULL AND trim(account_number) <> '';

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
  directory_contact_id TEXT REFERENCES directory_contacts(id) ON DELETE SET NULL,
  account_number TEXT,
  donor_kind TEXT NOT NULL DEFAULT 'member',
  merged_into_donor_id TEXT REFERENCES finance_donors(id) ON DELETE SET NULL,
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
  transaction_kind TEXT NOT NULL DEFAULT 'registered_envelope',
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

CREATE TABLE IF NOT EXISTS finance_scan_codes (
  id TEXT PRIMARY KEY,
  code_value TEXT NOT NULL,
  code_family TEXT NOT NULL,
  donor_id TEXT REFERENCES finance_donors(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  replaced_by_code_value TEXT,
  note TEXT,
  created_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_envelope_unique_batch_code
  ON finance_collection_envelopes(batch_id, envelope_code_snapshot);

CREATE INDEX IF NOT EXISTS idx_finance_donors_name
  ON finance_donors(last_name, first_name);

CREATE INDEX IF NOT EXISTS idx_finance_donors_envelope_number
  ON finance_donors(envelope_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_donors_directory_contact_unique
  ON finance_donors(directory_contact_id)
  WHERE directory_contact_id IS NOT NULL AND trim(directory_contact_id) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_donors_account_number_unique
  ON finance_donors(account_number)
  WHERE account_number IS NOT NULL AND trim(account_number) <> '';

CREATE INDEX IF NOT EXISTS idx_finance_donors_account_number
  ON finance_donors(account_number);

CREATE INDEX IF NOT EXISTS idx_finance_donors_kind
  ON finance_donors(donor_kind, active);

CREATE INDEX IF NOT EXISTS idx_finance_donors_merged_into
  ON finance_donors(merged_into_donor_id);

CREATE INDEX IF NOT EXISTS idx_finance_donor_codes_code
  ON finance_donor_envelope_codes(envelope_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_scan_codes_value
  ON finance_scan_codes(code_value);

CREATE INDEX IF NOT EXISTS idx_finance_scan_codes_family_status
  ON finance_scan_codes(code_family, status);

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
