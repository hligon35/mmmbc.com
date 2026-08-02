# Envelope Scan & Sunday Collection Reconciliation

This project now includes a finance workflow for Sunday/service collection batches with envelope scanning, two-person verification, reconciliation, and deposit confirmation.

## Canonical Source and Build

- Canonical admin source files are under `admin/public/`.
- Cloudflare-deployed static mirror is generated into `cf_site/` by `npm run build:cf`.
- Do not hand-edit `cf_site/`; regenerate it.

## Schema and Migration

Added migration:

- `migrations/0005_add_envelope_collection_reconciliation.sql`

Updated canonical schema:

- `cf/schema.sql`

New tables include:

- `finance_donors`
- `finance_donor_envelope_codes`
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

Envelope payload format:

- `MMMBC-ENV-V1:<uuid>`

Design decisions:

- Contains opaque random identifier only.
- Contains no donor name, email, address, phone, or internal numeric ID.
- Replaced/deactivated codes are invalid for future scans but historical entries remain intact.

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

## Sunday Workflow

1. Create/select a service batch.
2. Assign at least two counters.
3. Scan envelope code (USB/Bluetooth scanner input with Enter, or camera fallback).
4. Confirm donor, set payment method, amount, and one or more fund allocations.
5. Save and scan next.
6. Record loose giving separately (anonymous).
7. Review reconciliation totals and discrepancy.
8. Submit distinct counter approvals.
9. Finalize batch (discrepancy explanation required if nonzero).
10. Confirm bank deposit after finalization.

## Scanner Setup

### USB/Bluetooth Scanner

- Configure scanner to append Enter after each scan.
- Focus the scanner input in Internal Controls workspace.
- Scanned code is resolved immediately on Enter.

### Camera Fallback

- Uses browser `BarcodeDetector` + `getUserMedia` if available.
- No remote CDN dependency is required.
- If unavailable, manual/scanner input remains fully functional.

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

## Security and Privacy Decisions

- Envelope code payload is opaque and versioned.
- Resolution APIs are authenticated admin finance endpoints.
- All writes use server-side authenticated identity; no client user-id trust.
- Parameterized D1 statements are used.
- Check numbers are treated as sensitive and only returned to finance users.
- No cash/check images are stored.
- No bank-account details are stored.

## Rollback Considerations

- Revert UI changes by restoring `admin/public/finances_controls.html`, `admin/public/finances_donors.html`, `admin/public/finance_modern.js`, and `admin/public/finance_modern.css`.
- Keep migration history immutable; if rollback is needed in data model, create a forward migration that deprecates features safely.
- Regenerate `cf_site/` with `npm run build:cf` after any rollback.
