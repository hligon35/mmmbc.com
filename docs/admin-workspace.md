# Mount Moriah admin workspace

The authenticated `/admin` application opens the Mailbox. Modules and deep links
are registered in `admin/public/workspace/modules.mjs`. Existing church editors
and scoped finance controllers run inside the same shell. The retired standalone
finance dashboard and scanner remain retired.

## Deployment

Apply the new admin and site migrations before deploying this branch:

```sh
npx wrangler d1 migrations apply admin --env production --remote
npx wrangler d1 migrations apply site --env production --remote
npm run deploy
```

Preview uses the same migration under `--env preview`. No new Worker, database,
R2 bucket, queue, or secret is required. Keep existing Cloudflare Access coverage
on `/admin/*` and admin APIs. The Worker verifies Access identity and active D1
roles for shell routes and every workspace API. Resend requires the existing
`RESEND_API_KEY` secret, verified `RESEND_FROM_EMAIL`, and sender name.
Production domain cutover remains a separate manual step.

## Data and authorization

`migrations/site/0005_admin_workspace.sql` adds mailbox state, private drafts,
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

Reports use date-bounded stored data and role checks. An auditor can read finance
reports but cannot export finance data. CSV export escapes spreadsheet formulas.
Finance tools retain their backend role restrictions. Admin migration 0011 adds
fund profiles, transfer reservations and independent approvals, housing records,
and stored board report packages alongside the existing ledger. These APIs now
run on D1 rather than depending on the legacy local Express server. The Site Editor uses the
existing draft/version/publish/media APIs and preserves unsaved page fields in the
current administrator's browser session.

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
npm run migrate:local:admin
npm run migrate:local:site
npm run test:all
npx playwright install chromium
npm run test:workspace:browser
npm run worker:dry-run
```

API tests use in-memory SQLite stores and mocked email providers. Browser tests
exercise the actual Worker handlers against those local stores. They never send
live email or change Cloudflare resources. CI installs Chromium and runs the
browser checks along with the repository's existing launch validation.
