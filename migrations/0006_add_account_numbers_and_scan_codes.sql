-- Independent directory account numbers.
ALTER TABLE directory_contacts ADD COLUMN account_number TEXT;

UPDATE directory_contacts
SET account_number = 'MM-' || upper(substr(replace(id, '-', ''), 1, 10))
WHERE trim(coalesce(account_number, '')) = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_contacts_account_number_unique
  ON directory_contacts(account_number)
  WHERE account_number IS NOT NULL AND trim(account_number) <> '';
