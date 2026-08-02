-- Account numbers, directory-to-finance linkage, and generalized QR scan codes.
-- Preserves existing donor/envelope history while extending the model.

ALTER TABLE directory_contacts ADD COLUMN account_number TEXT;

UPDATE directory_contacts
SET account_number = 'MM-' || upper(substr(replace(id, '-', ''), 1, 10))
WHERE trim(coalesce(account_number, '')) = '';

ALTER TABLE finance_donors ADD COLUMN directory_contact_id TEXT REFERENCES directory_contacts(id) ON DELETE SET NULL;
ALTER TABLE finance_donors ADD COLUMN account_number TEXT;
ALTER TABLE finance_donors ADD COLUMN donor_kind TEXT NOT NULL DEFAULT 'member';
ALTER TABLE finance_donors ADD COLUMN merged_into_donor_id TEXT REFERENCES finance_donors(id) ON DELETE SET NULL;

ALTER TABLE finance_collection_envelopes ADD COLUMN transaction_kind TEXT NOT NULL DEFAULT 'registered_envelope';

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_contacts_account_number_unique
  ON directory_contacts(account_number)
  WHERE account_number IS NOT NULL AND trim(account_number) <> '';

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_scan_codes_value
  ON finance_scan_codes(code_value);

CREATE INDEX IF NOT EXISTS idx_finance_scan_codes_family_status
  ON finance_scan_codes(code_family, status);

UPDATE finance_donors
SET directory_contact_id = (
      SELECT c.id
      FROM directory_contacts c
      WHERE trim(coalesce(finance_donors.email, '')) <> ''
        AND lower(coalesce(c.primary_email, '')) = lower(finance_donors.email)
      LIMIT 1
    ),
    account_number = coalesce(finance_donors.account_number, (
      SELECT c.account_number
      FROM directory_contacts c
      WHERE trim(coalesce(finance_donors.email, '')) <> ''
        AND lower(coalesce(c.primary_email, '')) = lower(finance_donors.email)
      LIMIT 1
    ))
WHERE directory_contact_id IS NULL;

UPDATE finance_donors
SET directory_contact_id = (
      SELECT c.id
      FROM directory_contacts c
      WHERE trim(coalesce(finance_donors.first_name, '')) <> ''
        AND trim(coalesce(finance_donors.last_name, '')) <> ''
        AND lower(c.first_name) = lower(finance_donors.first_name)
        AND lower(c.last_name) = lower(finance_donors.last_name)
        AND (
          SELECT count(*)
          FROM directory_contacts c2
          WHERE lower(c2.first_name) = lower(finance_donors.first_name)
            AND lower(c2.last_name) = lower(finance_donors.last_name)
        ) = 1
      LIMIT 1
    ),
    account_number = coalesce(finance_donors.account_number, (
      SELECT c.account_number
      FROM directory_contacts c
      WHERE trim(coalesce(finance_donors.first_name, '')) <> ''
        AND trim(coalesce(finance_donors.last_name, '')) <> ''
        AND lower(c.first_name) = lower(finance_donors.first_name)
        AND lower(c.last_name) = lower(finance_donors.last_name)
        AND (
          SELECT count(*)
          FROM directory_contacts c2
          WHERE lower(c2.first_name) = lower(finance_donors.first_name)
            AND lower(c2.last_name) = lower(finance_donors.last_name)
        ) = 1
      LIMIT 1
    ))
WHERE directory_contact_id IS NULL;

INSERT INTO finance_donors (
  id,
  first_name,
  middle_name,
  last_name,
  preferred_name,
  household_id,
  mailing_address,
  email,
  phone,
  statement_delivery,
  active,
  statement_eligible,
  envelope_number,
  envelope_code,
  envelope_code_status,
  envelope_code_issued_at,
  envelope_code_updated_at,
  created_at,
  updated_at,
  directory_contact_id,
  account_number,
  donor_kind,
  merged_into_donor_id
)
SELECT
  lower(hex(randomblob(16))),
  c.first_name,
  c.middle_name,
  c.last_name,
  c.preferred_name,
  NULL,
  trim(
    coalesce(c.address_line_1, '') ||
    CASE WHEN trim(coalesce(c.address_line_2, '')) <> '' THEN ', ' || c.address_line_2 ELSE '' END ||
    CASE WHEN trim(coalesce(c.city, '')) <> '' THEN ', ' || c.city ELSE '' END ||
    CASE WHEN trim(coalesce(c.state, '')) <> '' THEN ', ' || c.state ELSE '' END ||
    CASE WHEN trim(coalesce(c.postal_code, '')) <> '' THEN ' ' || c.postal_code ELSE '' END
  ),
  c.primary_email,
  coalesce(nullif(c.mobile_phone, ''), nullif(c.home_phone, '')),
  CASE
    WHEN trim(coalesce(c.primary_email, '')) <> '' THEN 'email'
    ELSE 'mail'
  END,
  CASE WHEN lower(coalesce(c.status, 'active')) = 'archived' THEN 0 ELSE 1 END,
  CASE WHEN lower(coalesce(c.contact_type, 'member')) IN ('member', 'repeat_donor', 'one_time_donor', 'visitor') THEN 1 ELSE 0 END,
  NULL,
  '',
  'inactive',
  NULL,
  NULL,
  coalesce(c.created_at, current_timestamp),
  coalesce(c.updated_at, current_timestamp),
  c.id,
  c.account_number,
  CASE
    WHEN lower(coalesce(c.contact_type, 'member')) = 'visitor' THEN 'one_time'
    WHEN lower(coalesce(c.contact_type, 'member')) = 'one_time_donor' THEN 'one_time'
    ELSE 'member'
  END,
  NULL
FROM directory_contacts c
WHERE NOT EXISTS (
  SELECT 1
  FROM finance_donors d
  WHERE d.directory_contact_id = c.id
)
  AND lower(coalesce(c.status, 'active')) <> 'archived';

UPDATE finance_donors
SET account_number = (
  SELECT c.account_number
  FROM directory_contacts c
  WHERE c.id = finance_donors.directory_contact_id
  LIMIT 1
)
WHERE trim(coalesce(account_number, '')) = ''
  AND directory_contact_id IS NOT NULL;

UPDATE finance_collection_envelopes
SET transaction_kind = CASE
  WHEN lower(coalesce(payment_method, 'cash')) = 'check' THEN 'check_envelope'
  ELSE 'cash_envelope'
END
WHERE trim(coalesce(transaction_kind, '')) = ''
   OR transaction_kind = 'registered_envelope';

INSERT OR IGNORE INTO finance_scan_codes (
  id,
  code_value,
  code_family,
  donor_id,
  status,
  issued_at,
  updated_at,
  replaced_by_code_value,
  note,
  created_by
)
SELECT
  c.id,
  c.envelope_code,
  'member_envelope',
  c.donor_id,
  c.status,
  c.issued_at,
  c.updated_at,
  c.replaced_by_code,
  c.note,
  NULL
FROM finance_donor_envelope_codes c
WHERE trim(coalesce(c.envelope_code, '')) <> '';

INSERT OR IGNORE INTO finance_scan_codes (
  id,
  code_value,
  code_family,
  donor_id,
  status,
  issued_at,
  updated_at,
  replaced_by_code_value,
  note,
  created_by
)
SELECT
  lower(hex(randomblob(16))),
  envelope_code,
  'member_envelope',
  id,
  envelope_code_status,
  coalesce(envelope_code_issued_at, created_at, current_timestamp),
  coalesce(envelope_code_updated_at, updated_at, current_timestamp),
  NULL,
  NULL,
  NULL
FROM finance_donors
WHERE trim(coalesce(envelope_code, '')) <> '';