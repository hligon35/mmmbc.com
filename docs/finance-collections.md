# Manual collections and envelope reconciliation

The scanner and QR issuance workflow is retired. Use the admin finance Controls workspace for manual collection entries; retired scan endpoints return 410.

1. Create or select an editable service collection batch.
2. Look up the donor by account number, then enter payment method, check number when applicable, and envelope total in cents.
3. Allocate the amount across funds. Allocations must exactly equal the envelope total.
4. Save and enter the next envelope. Duplicate entries and edits to locked batches are rejected.
5. Add loose giving and complete the configured counter/approval process.
6. Reconcile declared and recorded totals, finalize, and confirm the deposit through the existing finance workflow.

Donors and their envelope numbers are managed in the Donors page. The Envelope Designer still prints donor/account details and offering fields; it no longer generates QR codes. Historical code snapshots remain attached to old entries.

Canonical code is in src/worker-finance-reconciliation.js and admin/public/finance_modern.js. Database history is in migrations/admin/; apply migrations through Wrangler to the correct database after taking a backup. Generated cf_site assets are rebuilt with npm run build and are not edited or tracked separately.
