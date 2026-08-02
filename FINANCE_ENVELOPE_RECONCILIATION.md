# Envelope Scan & Sunday Collection Reconciliation

This project now includes a finance workflow for Sunday/service collection batches with QR scanning, two-person verification, reconciliation, donor reassignment, printable envelope design, and deposit confirmation.

## Canonical Source and Build

- Canonical admin source files are under `admin/public/`.
- Cloudflare-deployed static mirror is generated into `cf_site/` by `npm run build:cf`.
- Do not hand-edit `cf_site/`; regenerate it.
- `npm run build:cf` now uses the cross-platform Node script `scripts/build_cf_site.mjs`.

## Schema and Migration

Added migration:

- `migrations/0005_add_envelope_collection_reconciliation.sql`
- `migrations/0006_add_account_numbers_and_scan_codes.sql`

Updated canonical schema:

- `cf/schema.sql`

New tables include:

- `finance_donors`
- `finance_donor_envelope_codes`
- `finance_scan_codes`
- `finance_collection_batches`
- `finance_collection_counters`
- `finance_collection_counter_approvals`
- `finance_collection_envelopes`
- `finance_collection_allocations`
- `finance_collection_loose_giving`
- `finance_collection_audit_events`

### Apply migration (local/test D1)

Example commands:

```powershell
npx wrangler d1 migrations apply mmdb --local
npx wrangler d1 migrations apply mmdb --env preview
```

Use your project-specific database binding/name if different.

## Required Bindings and Variables

This workflow uses existing Worker auth and D1 bindings:

- `DB` D1 binding (required)
- Session/auth configuration already used by admin routes (`SESSION_SECRET`, Google/admin allow-list vars)

No new secrets are required for scanning/reconciliation.

## Envelope Code Format and Generation

Registered payload formats:

- `MMMBC-ENV-V1:<uuid>`
- `MMMBC-ONETIME-V1:<uuid>`

Design decisions:

- Contains opaque random identifier only.
- Contains no donor name, email, address, phone, or internal numeric ID.
- Replaced/deactivated codes are invalid for future scans but historical entries remain intact.
- One-time donor codes are church-issued reusable guest codes and may be used more than once, including in the same batch.

## Mobile `/scan` Workflow

Route:

- `/scan`

Workflow:

1. Authenticated finance user opens `/scan`.
2. User scans with the rear camera when supported, or with a keyboard-style USB/Bluetooth scanner.
3. Server validates that the code is an MMMBC registered code and that it is still active.
4. Server creates or reuses the current day’s editable collection batch.
5. Registered member codes show minimal donor confirmation only.
6. One-time codes allow anonymous or identified guest gifts.
7. User enters fund, amount, payment method, and optional check number.
8. Gift is saved in integer cents and the form resets for the next scan.

Browser behavior:

- Uses `BarcodeDetector` and `getUserMedia` when supported.
- Falls back to manual entry or keyboard-scanner input when camera detection is unavailable.
- Stops all camera tracks when scanning completes or the page unloads.

## API Surface (Authenticated Finance)

Donors and envelope identity:

- `GET /api/finances/donors`
- `POST /api/finances/donors`
- `PUT /api/finances/donors/:donorId`
- `POST /api/finances/donors/:donorId/envelope-code/issue`
- `POST /api/finances/donors/:donorId/envelope-code/replace`
- `POST /api/finances/donors/:donorId/envelope-code/deactivate`
- `GET /api/finances/donors/:donorId/envelope-label?format=svg`
- `GET /api/finances/donors/:donorId/history`

Collection batches:

- `GET /api/finances/collections`
- `POST /api/finances/collections`
- `GET /api/finances/collections/:batchId`
- `PUT /api/finances/collections/:batchId`
- `POST /api/finances/collections/:batchId/start`
- `POST /api/finances/collections/:batchId/submit-verification`
- `POST /api/finances/collections/:batchId/counters`
- `POST /api/finances/collections/:batchId/envelopes`
- `POST /api/finances/collections/:batchId/loose-giving`
- `GET /api/finances/collections/:batchId/reconciliation`
- `POST /api/finances/collections/:batchId/approvals`
- `POST /api/finances/collections/:batchId/finalize`
- `POST /api/finances/collections/:batchId/deposit`
- `POST /api/finances/collections/:batchId/reopen`
- `POST /api/finances/collections/:batchId/void`
- `POST /api/finances/collections/resolve-envelope`

Scan workflow:

- `POST /api/finances/scans/resolve`
- `POST /api/finances/scans/record`
- `POST /api/finances/scans/entries/:entryId/identify`
- `POST /api/finances/scan-codes/one-time`
- `GET /api/finances/scan-codes/render?code=...`

## Sunday Workflow

1. Use Finance → Record Money → `Scan QR Code` or open `/scan` directly.
2. Scan a registered member or one-time donor code.
3. Server creates or reuses the current day’s draft/counting batch.
4. Registered member gifts keep duplicate protection per batch.
5. One-time donor gifts may be unnamed or matched by account number or exact name.
6. Save the gift and continue scanning.
7. Later, use Internal Controls → Recent Entries → `Identify Donor` to reassign one-time gifts when needed.
8. Review reconciliation totals and discrepancy.
9. Submit distinct counter approvals.
10. Finalize batch (discrepancy explanation required if nonzero).
11. Confirm bank deposit after finalization.

## Scanner Setup

### USB/Bluetooth Scanner

- Configure scanner to append Enter after each scan.
- Focus the scanner input in Internal Controls workspace.
- Scanned code is resolved immediately on Enter.

### Camera Fallback

- Uses browser `BarcodeDetector` + `getUserMedia` if available.
- No remote CDN dependency is required.
- If unavailable, manual/scanner input remains fully functional.

## One-Time Donor Behavior

- One-time donor QR codes are issued by the church and validated server-side.
- Gifts may be recorded without a donor name.
- Temporary one-time donor records are created when no returning donor match is supplied.
- Matching order is:
	1. exact account number
	2. exact normalized donor name
- If multiple donors share the same name, the system rejects the match and requires an account number.
- Later identification safely reassigns the collection entry and writes an audit record.
- Temporary donor records are never silently deleted; they are deactivated/merged when no longer referenced.

## Directory Account Numbers

- `directory_contacts.account_number` is now the canonical directory member/account identifier.
- Format is normalized to `MM-XXXXXXXXXX` style opaque church account numbering.
- Blank values are auto-generated for new contacts and backfilled contacts.
- Manual or imported values are preserved after normalization.
- Uniqueness is enforced in D1 with partial unique indexes.
- CSV import aliases supported:
	- `account_number`
	- `account_id`
	- `member_number`
	- `donor_number`
- Directory create/update flows synchronize linked `finance_donors` records.

## Envelope Designer

Admin route:

- `/admin/finances/envelopes`

Supported sizes:

- `A2` — `4.375 × 5.75 in`
- `A7` — `5.25 × 7.25 in`
- `A9` — `5.75 × 8.75 in`
- `#10` — `4.125 × 9.5 in`

Features:

- Search by donor name, account number, or envelope number.
- Issue or reuse an active registered member QR code.
- Generate reusable one-time donor QR codes for blank visitor envelopes.
- Visible member name, account number, and envelope number on the print layout.
- Live preview with optional local-only background image.
- Background opacity adjustment.
- Print-friendly popup output with admin controls removed from print view.
- QR payloads remain opaque and contain no PII.

## Label Printing

Recommended starting dimensions:

- 2.0 in x 1.0 in (or nearest stock size)

Current label output is SVG and includes:

- Church abbreviation/name
- Human-readable envelope number
- QR code for opaque envelope payload
- No donor PII in printed code payload

## Reconciliation and Corrections

Server-side controls include:

- Allocation sum must equal envelope total.
- Duplicate envelope code in same batch is blocked.
- Two assigned counters minimum.
- Counter approvals tied to assigned counters only.
- Approval invalidation after financial changes.
- Finalization blocked without required discrepancy explanation.
- Deposit confirmation only after finalization.
- Reopen/void requires explicit reason and audit.
- Finalized/deposited/voided batches are locked from normal edits.

Gift source and transaction-kind values now distinguish:

- `stripe`
- `registered_envelope`
- `one_time`
- `cash_envelope`
- `check_envelope`
- `loose_cash`

## Security and Privacy Decisions

- Envelope code payload is opaque and versioned.
- Both member and one-time codes are validated against server-side registration records.
- Resolution APIs are authenticated admin finance endpoints.
- All writes use server-side authenticated identity; no client user-id trust.
- Parameterized D1 statements are used.
- Check numbers are treated as sensitive and only returned to finance users.
- No cash/check images are stored.
- No bank-account details are stored.
- Background images selected in the envelope designer stay in the browser unless future persistence is explicitly added.
- QR payloads are never combined with donor PII in logs.

## Build and Preview Commands

```powershell
npm run build:cf
npx wrangler d1 migrations apply mmdb --local
npx wrangler deploy --env preview --dry-run
```

## Production Rollout Order

1. Deploy code to a preview environment and validate `/scan` and `/admin/finances/envelopes`.
2. Apply the next migration set to the target D1 database.
3. Verify account-number backfill and finance-donor links.
4. Verify one registered member scan, one reusable one-time scan, and one donor-identification correction.
5. Deploy the updated Worker and static assets to production.
6. Train finance users on duplicate protection, one-time donor identification, and printed envelope issuance.

## Rollback Considerations

- Revert UI changes by restoring `admin/public/index.html`, `admin/public/finances_controls.html`, `admin/public/finances_donors.html`, `admin/public/finance_modern.js`, `admin/public/finance_modern.css`, `scan.html`, `scan.css`, `scan.js`, and `admin/public/finance_envelope_designer.*`.
- Keep migration history immutable; if rollback is needed in data model, create a forward migration that deprecates features safely.
- Regenerate `cf_site/` with `npm run build:cf` after any rollback.
