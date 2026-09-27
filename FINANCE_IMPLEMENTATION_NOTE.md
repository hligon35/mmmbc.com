# Finance Implementation Baseline (Pre-Change)

## What already works
- Senior-friendly Record Money wizard in [admin/public/index.html](admin/public/index.html) and [admin/public/admin.js](admin/public/admin.js).
- Money Received / Money Spent flows, validation, review, saved state, and unsaved/delete dialogs.
- Review Transactions table + mobile cards + filters + receipts + CSV export.
- Dedicated finance pages: dashboard, funds, donors, reports/board, controls, clergy housing under [admin/public](admin/public).
- Role-gated local finance APIs in [admin/server.js](admin/server.js).
- Existing JSON-backed data stores for entries, funds, donors/households, statements, controls, housing in [admin/data](admin/data).

## What data models currently exist
- Finance entries: date/type/category/fund/fundId/method/party/memo/amountCents and limited metadata.
- Funds model includes restrictions, balances, budgets, transfer/release workflows.
- Donor + household model exists with statement-related fields.
- Contribution statements model exists with generate/approve/deliver records.
- Stripe giving exists in Worker giving tables, separate from finance ledger.

## What must be extended now
- Add explicit transaction source and richer transaction status handling.
- Add financial account directory and link entries to accounts.
- Replace UI-led permanent delete path with controlled void/reversal operations.
- Add append-only finance audit events for entry lifecycle transitions.
- Normalize legacy entries safely so historical records remain readable.

## Backward compatibility requirements
- Keep existing finance wizard and entry endpoints functioning.
- Preserve existing JSON records in [admin/data/finances.json](admin/data/finances.json).
- Preserve amount storage in integer cents.
- Keep legacy DELETE endpoint temporarily for compatibility, while moving UI to void.

## Existing records that need migration/normalization
- Legacy entries missing source/status/account metadata must default safely.
- Historical fund references must continue resolving by fundId or fund name.
- Existing createdAt-only records must gain normalized updated metadata without changing totals.

## Requested capabilities not fully present yet (before this change)
- No robust void/reversal workflow in ledger records.
- No first-class financial account registry for bank/cash/clearing balances.
- No bank reconciliation wizard at account/statement level.
- Stripe accounting flows are not integrated into the local finance ledger.
- No period-close write protection in entry routes.

