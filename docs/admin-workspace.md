# Mount Moriah admin workspace

> Current delivery (2026-10-05): the refined tabbed admin is the deployed entry.
> `window.MMWorkspaceEnabled` is false and the mailbox shell is not loaded.
> The mailbox architecture and historical browser script described below remain
> reference material, not the current layout contract. Use `npm run test:admin:browser`
> and the deployment fingerprint checks in `deployment.md` for current delivery.

The authenticated `/admin` application opens the Mailbox. Modules and deep links
are registered in `admin/public/workspace/modules.mjs`. Mailbox, rentals, calendar,
directory, ministry and leadership profiles, newsletter, operational reports, Site
Editor, access management, and support run inside the same shell. The entire
financial dashboard and its tooling are removed.

## Deployment

Apply the pending migrations to `mmdb` before deploying:

```sh
npx wrangler d1 migrations apply mmdb --remote
npm run deploy
```

No new Worker, database,
R2 bucket, queue, or secret is required. Keep existing Cloudflare Access coverage
on `/admin/*` and admin APIs. The Worker verifies Access identity and active D1
roles for shell routes and every workspace API. Resend requires the existing
`RESEND_API_KEY` secret, verified `RESEND_FROM_EMAIL`, and sender name.
Production domain cutover remains a separate manual step.

## Data and authorization

`migrations/0016_admin_workspace.sql` adds mailbox state, private drafts,
outbound history, rental decisions, and an audit trail in SITE_DB. It migrates
existing read/archive metadata without copying or changing source submissions.
Deleted conversations remain restorable. Public forms and Turnstile are unchanged.
Rental approval uses optimistic versions and an atomic conflict check against
approved requests for overlapping times and facilities. The calendar reads source
events and rental records directly. Rental dates and times use church-local time
in Paducah (America/Chicago).

Drafts are private to the authenticated administrator and survive refresh. Sends
are persisted before Resend is called, use one provider idempotency key, and claim
the outgoing row before dispatch. Replies stay linked to the source conversation.
Accepted means accepted by the provider, not confirmed delivered. Failed and
uncertain sends remain visible with Retry. Ambiguous sends outside the provider
idempotency window require checking Resend before composing a new message.

Reports use date-bounded submissions, rental, outbound-message, and newsletter
records with role checks. CSV export escapes spreadsheet formulas. Finance
entries, funds and transfers, reconciliation, controls, clergy housing, envelopes,
contribution statements, board reports, and their API routes are removed. Removed
URLs have no shell registrations or backend handlers and return 404.

The directory keeps its own account numbers and newsletter synchronization; it
never reads or writes finance donor records. Event printing has its own header and
print body. Ministry Profiles and Leadership & Staff retain their dedicated draft/publish/media workflow. The standalone visual Site Editor has been removed.

`/give` remains the independent Zeffy redirect. The existing optional Stripe
checkout, subscription/webhook records, and signature validation remain isolated
in `worker-giving.js`, disabled unless `GIVING_PROVIDER=stripe`. Giving does not
require ledger, donor, fund, collection, or reconciliation tables. The former
admin Giving / Donors screen is removed because it depended on those tables.

No `finance.*` permissions are advertised or granted. Stored `finance_entry` and
`treasurer` role keys remain compatible with existing D1 users but now grant only
their existing directory and support permissions, labeled Directory Assistant and
Directory Manager. `auditor` retains support access only, labeled Support Viewer.
No existing user receives broader website, mailbox, or administrator access.
Administrators still manage users and roles through Access Management.

Fresh schemas and migrations create no finance tables. Historical slots 0005 and
0011 are no-ops; 0006 retains only directory account-number setup. Filenames remain
stable for existing migration journals. Already-applied finance tables and real
historical records are left untouched and unused; this change does not run DROP or
DELETE against production data. Site migration 0005 remains required for mailbox
and rental state. Apply the remaining migrations through the normal process.

## App support

The manifest includes logo-based regular and maskable icons. The service worker
does not cache admin HTML, API responses, drafts, or other private records. Badge
counts use unread inbox records. Push and notification-click hooks exist but no
subscription or permission request is advertised as working. Push requires a
future authenticated subscription store, VAPID keys, and an event publisher.
Cloudflare Access remains the authentication authority; passkeys depend on its
identity-provider configuration.

## Verification

```sh
npm ci
npm --prefix admin ci
npm run build:cf
npm run migrate:local
npm run test:all
npx playwright install chromium
npm run test:workspace:browser
npm run worker:dry-run
```

API tests use in-memory SQLite stores and mocked email providers. Browser tests
exercise the actual Worker handlers against those local stores. They never send
live email or change Cloudflare resources. CI installs Chromium and runs the
browser checks along with the repository's existing launch validation.

## Navigation, routing, and data loading

- One route table in `admin/public/admin.js` (`ADMIN_ROUTES`) maps hashes and historical paths to sections. `#events`, `/admin/calendar` and the legacy site-editor links open Announcements & Events; `/admin/mail` and `/admin/inbox` open Messages; `/admin/rentals` opens Messages filtered to rentals; `/admin/reports` opens Home; `/admin/access` and `/admin/users` open Settings.
- Session start-up (`initializeSession`) runs once. Navigation never repeats authentication, CSRF, or diagnostics requests; each section loads lazily on first visit and refreshes after 30 seconds at most.
- `GET /api/submissions` accepts `q`, `type`, `limit` (default 25, max 100) and `offset`, returns bodyless rows with true totals/counts, and `GET /api/submissions/:id?type=` returns one full message.
- `GET /api/gallery?limit&offset&sort&album&tag&arrangeAlbum` filters, sorts, and pages on the server (default 48, max 200) and returns `total` and `albums`. Without `limit` the legacy full list is still returned for the public site.
- `GET /api/dashboard/overview` uses SQL aggregates, returns only metrics the caller may view, and reports `null` plus an `unavailable` list when a query fails.
- `/api/livestream`, `/api/settings`, `/api/theme/*` and `/api/export` were non-persisting compatibility stubs with no UI; they now return `410`.
- Migration `0017_dashboard_query_indexes.sql` adds indexes confirmed with `EXPLAIN QUERY PLAN`; apply it with the normal D1 migration process.

### Measured baseline (isolated data: 354 messages, 1,200 photos, local server, uncompressed)

`node scripts/measure_admin_performance.mjs <repo>` produced:

| Step | Before (39a4d05) | After |
| --- | --- | --- |
| Cold boot to usable dashboard | 2,080 ms, 49 requests (22 API), 1,134 KB | 1,185 ms, 12 requests (3 API), 579 KB |
| Warm reload | 957 ms, 20 requests, 862 KB | 1,026 ms, 12 requests, 579 KB |
| Messages | 530 ms, 216 KB | 543 ms, 5 KB |
| Photos | 973 ms, 10 API, 271 KB | 977 ms, 2 API, 8 KB |
| Announcements & Events | 1,277 ms, 17 API, 539 KB | 637 ms, 3 API, 0 KB |
| Back to Home | 777 ms, 12 API | 384 ms, 0 API |

The static bundle (about 560 KB uncompressed) is unchanged; Cloudflare compresses it in transit. Decide on bundle splitting from these numbers before changing it.