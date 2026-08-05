# CODEBASE_CLEANUP_AUDIT

Date: 2026-08-04
Branch: refactor/codebase-cleanup
Scope: Evidence-first cleanup planning with safe, no-contract-change modular extraction. No visual or behavior changes intended.

## 1) Protected Baseline

### Commands run

- Root install: `npm ci` (pass)
- Root tests: `npm test` (pass, 43/43 after added characterization suites)
- Admin install: `cd admin && npm ci` (pass; warnings and known vulnerabilities reported)
- Admin tests: `cd admin && npm test` (fail baseline; assertion failure in `admin-ui.test.js`)
- Static build: `npm run build:cf` (pass)
- Integration script: `npm run verify:integrations` (fail baseline; local endpoint `127.0.0.1:8787` not running)
- Cloudflare preview dry run: `npx wrangler deploy --env preview --dry-run` (pass)

### Baseline findings

- Root test suite is healthy.
- Admin test suite is currently failing before any cleanup refactor due to assertion in `admin/admin-ui.test.js` around expected text content (`viewBtn.textContent = 'View';` not found).
- Integration verification currently depends on a local service and fails when that runtime is not active.
- Build and Worker dry-run are healthy.

## 2) Route Manifest (Initial)

This manifest is captured from source scans and is locked by characterization tests:

- New test: `src/route-manifest.characterization.test.mjs`
- New test: `src/route-contract.characterization.test.mjs`
- Included in root test script in `package.json`

### Public critical routes (Worker)

- `/api/public/announcements` (GET)
- `/api/public/events` (GET)
- `/api/public/bulletins` (GET)
- `/api/public/gallery` (GET)
- `/api/public/youtube` (GET)
- `/api/public/site-settings` (GET)
- `/api/public/livestream` (GET)
- `/api/public/newsletter/subscribe` (POST)
- `/api/public/contact-message` (POST)
- `/api/public/facility-rental-request` (POST)
- `/api/site-content/:page` (GET)
- `/cdn/gallery/:key` (GET)

### Protected/admin critical routes (Worker)

- `/api/admin/integration-health` (GET)
- `/api/support/message` (POST)
- `/api/users/invite` (POST)
- `/api/newsletter/send` (POST)
- `/api/directory/*`
- `/api/gallery/*`
- `/api/finances/*` (via finance reconciliation handler)

### Auth boundary checks (Worker wrapper)

- Public auth helper endpoints present: `/api/auth/providers`, `/api/csrf`, `/api/auth/google`, `/api/auth/logout`, `/api/me`
- Wrapper gate on `/api/*` and `/admin*` paths is present in `src/worker-auth-wrapper.js`

## 3) Asset-Reference Manifest (Initial)

- Source of truth for public assets: repository root files and folders (not `cf_site/`).
- Generated deployment mirror: `cf_site/` built by `scripts/build_cf_site.mjs`.
- Build flow confirms `cf_site/` is recreated and admin assets are mirrored with targeted injection handling.

## 4) D1, R2, Stripe, Email, Cron Inventory (Initial)

### D1

Migrations present and retained:

- `migrations/0001_add_admin_tables.sql`
- `migrations/0002_add_communications_tables.sql`
- `migrations/0003_add_site_page_content.sql`
- `migrations/0004_add_directory_tables.sql`
- `migrations/0005_add_envelope_collection_reconciliation.sql`
- `migrations/0006_add_account_numbers_and_scan_codes.sql`

Disposition: retain all migrations.

### R2

Operational routes found under `/api/gallery/*` and `/cdn/gallery/*` with bucket bindings in `wrangler.jsonc`.

Disposition: retain all related route handlers and storage utilities pending modularization.

### Stripe

Giving and webhook paths present in Worker giving handlers (`/api/giving/checkout`, webhook route in Worker).

Disposition: retain unchanged during cleanup unless covered by explicit characterization tests.

### Email

Support, invites, and newsletters wired through Worker communications and bindings/secrets.

Disposition: retain unchanged in early cleanup phases.

### Scheduled jobs

Cron trigger is configured (`*/5 * * * *`) and Worker `scheduled` handler delegates newsletter processing.

Disposition: retain unchanged.

## 5) Cleanup Target Inventory (Evidence-Based)

Legend:

- Classification: Confirmed active | Generated artifact | Duplicate implementation | Legacy but referenced | Dead code with evidence | Orphaned asset with evidence | Dev-only artifact | Unknown—retain pending investigation
- Risk: Low | Medium | High | Critical

| Target | Classification | Evidence | Risk | Proposed action | Final disposition |
|---|---|---|---|---|---|
| `cf_site/**` | Generated artifact | Built from `scripts/build_cf_site.mjs`; deploy assets use this directory | High | Keep generated; never hand-edit as source | Retain |
| `migrations/*.sql` | Confirmed active | D1 schema history and runtime assumptions | Critical | Keep all migration files | Retain |
| `admin/server.js` vs `src/worker*.js` duplicated route domains | Duplicate implementation | Both implement overlapping admin/public APIs for different runtimes | High | Document boundaries; extract shared pure helpers only where safe | Retain pending modular refactor |
| `admin/public/admin-header-canonical.css` + `admin/public/admin.css` header overlap | Duplicate implementation | Header/nav/drawer selectors in both files | Medium | Normalize source-of-truth layering and remove conflicting rules only after visual verification | Retain pending investigation |
| `schedule.json.bak` | Unknown—retain pending investigation | Backup file present; unclear operational dependency | Medium | Verify no build/runtime/docs references before deletion | Retain pending investigation |
| `r2-test.txt`, `r2-test-download.txt` | Dev-only artifact (suspected) | Naming suggests test artifacts | Low | Verify no references then remove in dedicated deletion commit | Retain pending investigation |
| `livestream.json.1768536992911.tmp` | Dev-only artifact (suspected) | Timestamped temporary filename pattern | Low | Verify no references then remove in dedicated deletion commit | Retain pending investigation |
| Screenshots (`Screenshot *.png`) | Unknown—retain pending investigation | Could be documentation evidence | Low | Verify docs references before archive/delete | Retain pending investigation |
| `INTEGRATION_AUDIT.md`, implementation notes | Legacy but referenced | Operational documentation may be used by maintainers | Medium | Keep unless superseded and linked replacement exists | Retain |
| `profiles.json` | Legacy but referenced | Worker/admin endpoints include `/api/profiles` compatibility handling | High | Keep until compatibility route retirement is planned/tested | Retain |

## 6) Size Metrics

Primary files line counts:

- Before:
   - `src/worker.js`: 2293
   - `src/worker-admin-api-wrapper.js`: 1434
   - `admin/server.js`: 6905
   - `admin/public/admin.js`: 7972
- Current:
   - `src/worker.js`: 2226
   - `src/worker-admin-api-wrapper.js`: 1380
- `admin/server.js`: 6905
- `admin/public/admin.js`: 7972

## 7) Immediate Regression Guards Added

- Added `src/route-manifest.characterization.test.mjs` to lock critical Worker route/auth patterns.
- Added `src/route-contract.characterization.test.mjs` to lock fallback 404/405 contract markers.
- Updated root `package.json` test script to include this characterization suite.

## 8) Safe Refactors Completed

- Extracted duplicated Worker helper logic into `src/worker-shared.js`:
   - `readAssetJson(...)`
   - `sendSupportEmailMessage(...)`
- Updated both `src/worker.js` and `src/worker-admin-api-wrapper.js` to import these shared helpers.
- Removed duplicated in-file helper implementations from both files.
- Extracted additional pure utilities from `src/worker-admin-api-wrapper.js` into
   `src/worker-admin-api-utils.js`:
   - public feed normalizers
   - date/string normalization helpers
   - finance-compatible text/date/amount helpers
   - finance fallback helpers
   - dashboard date helper utilities
- Updated `src/worker-admin-api-wrapper.js` to import and use these extracted helpers.
- Extracted admin YouTube helper cluster from `admin/server.js` into
   `admin/lib/youtube.js` and imported it back into `admin/server.js`:
   - live video detection helper
   - feed parsing helper
   - redirect-follow HTTP helper
   - entity-decoding helper used by feed parsing
- Extracted admin email template helper cluster from `admin/server.js` into
   `admin/lib/email-templates.js` and imported it back into `admin/server.js`:
   - support message template builder
   - newsletter template builder
   - admin invite template builder
- Verified root tests pass and `npm run build:cf` succeeds after the extraction.

## 9) Risks and Constraints

- Do not treat admin test baseline failure as a refactor regression unless it changes from this known failing state to a different failure set.
- Do not remove `cf_site/` while current Cloudflare deployment still depends on static asset upload from that folder.
- Do not modify migrations or data files for organizational cleanup only.
- Do not alter API contracts, route visibility, or auth boundaries without explicit characterization coverage.

## 10) Next Cleanup Steps (Planned)

1. Add deeper characterization tests for:
   - 404/405 API behavior
   - Auth-gated route categories
   - Public route response shape sentinels
2. Produce a machine-readable route manifest snapshot for Worker and admin server.
3. Continue safe modular extraction in Worker with no behavior changes:
   - response helpers (partially complete)
   - request/body parsing helpers
   - route grouping dispatch map
4. Begin modular decomposition plan for `admin/server.js` in cohesive chunks, preserving middleware order and Stripe raw-body handling.
5. Re-run full baseline set after each chunk.

## 11) Current Verification Snapshot

- Root tests: pass (43/43)
- Root build (`npm run build:cf`): pass
- Cloudflare preview dry run: pass
- Integration verifier: fail when local base URL `127.0.0.1:8787` is not running (unchanged baseline condition)

## 12) Current Size Delta (Key Files)

- `src/worker.js`: 2293 -> 2226 (delta -67)
- `src/worker-admin-api-wrapper.js`: 1434 -> 1303 (delta -131)
- `admin/server.js`: 6905 -> 6694 (delta -211)
- `admin/public/admin.js`: 7972 -> 7972 (delta 0)
