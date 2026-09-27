## Summary

- Adds a mobile `/scan` workflow for registered member-envelope and church-issued one-time donor QR codes.
- Extends finance reconciliation APIs with strict registered-code validation, current-day batch reuse/creation, one-time donor recording, and later donor identification.
- Adds directory `account_number` support with normalization, uniqueness checks, import/export support, and finance-donor synchronization.
- Adds `/admin/finances/envelopes` for QR envelope design and printing, including A2, A7, A9, and #10 layouts.
- Replaces the PowerShell-only `build:cf` path with a cross-platform Node build script and regenerates `cf_site` from canonical sources.

## Mobile `/scan` Workflow

- Finance users can open Finance → Record Money → `Scan QR Code` or navigate directly to `/scan`.
- Camera scanning uses `BarcodeDetector` with rear-camera preference when available.
- USB/Bluetooth scanner and manual entry fallback are supported.
- The server validates the QR family and registration before any donor or batch data is exposed.
- The workflow creates or reuses the current day’s editable batch and records gifts in integer cents.

## Registered-Code Validation

- Supported code families:
  - `MMMBC-ENV-V1:<uuid>`
  - `MMMBC-ONETIME-V1:<uuid>`
- Payloads remain opaque and contain no PII.
- Unknown, malformed, inactive, replaced, or non-MMMBC code families are rejected.
- Member codes keep duplicate protection within a batch.
- Reusable one-time codes may be recorded multiple times.

## One-Time Donor Handling

- One-time gifts can remain unnamed initially.
- Matching order is exact account number first, then exact normalized donor name.
- Duplicate-name ambiguity is rejected and requires an account number.
- Internal Controls now includes `Identify Donor` for one-time entries.
- Reassignment audits the change and safely deactivates/merges temporary donor records when no longer referenced.

## Directory Account Numbers and Imports

- Adds `directory_contacts.account_number` with normalized `MM-...` formatting.
- Preserves manual/imported values and generates values when blank.
- Supports CSV aliases:
  - `account_number`
  - `account_id`
  - `member_number`
  - `donor_number`
- Syncs directory contact identity into linked `finance_donors` records.

## Envelope Designer

- Adds `/admin/finances/envelopes`.
- Supports A2, A7, A9, and #10 envelope previews.
- Supports member search by name, account number, or envelope number.
- Supports issuing/reusing registered member QR codes and generating reusable one-time donor QR codes.
- Supports optional local-only background images with adjustable opacity and print-friendly output.

## Migration and Rollout

- Adds migration `0006_add_account_numbers_and_scan_codes.sql`.
- Keeps `cf/schema.sql` aligned with the new schema.
- Recommended rollout order:
  1. deploy preview and validate `/scan` and `/admin/finances/envelopes`
  2. apply migrations
  3. verify account-number backfill and donor linking
  4. verify member scan, one-time scan, and donor identification
  5. deploy production assets/Worker

## Verification

- `npm ci`
- `npm test`
- `npm ci --prefix admin`
- `npm test --prefix admin`
- `npm run build:cf`
- `node --check src/worker-finance-reconciliation.js`
- `node --check src/worker-directory.js`
- `node --check admin/public/finance_modern.js`
- `node --check admin/public/admin-directory.js`
- `node --check admin/public/finance_envelope_designer.js`
- `node --check scan.js`
- `npx wrangler d1 migrations apply mmdb --local`
- `npx wrangler deploy --env preview --dry-run`
- `git diff --check`

## Limitations

- Full authenticated browser-path manual testing of donor retrieval and one-time recording still requires a real signed-in finance session.
- Full physical mobile-camera testing remains required on an actual phone/tablet browser.
- Browser-based print output was implemented, but final print-stock calibration should still be verified with real A2/A7/A9/#10 envelopes.