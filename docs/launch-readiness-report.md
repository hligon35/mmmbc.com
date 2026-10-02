# Launch readiness implementation

Implemented October 2, 2026. General legacy-file cleanup is paused pending the owner's review.

## Implemented behavior

- Removed the committed Turnstile secret from configuration. Production forms fail closed until the owner supplies the replacement secret and matching public site key.
- Facility rental pages use the member and non-member online forms. Requests are verified with Turnstile, persisted in the site database, and appear in the admin submissions inbox. Email failure does not discard a saved request.
- Removed the scanner application, camera controls, QR issuance and labels. Retired scanner URLs return 410. Manual donor account lookup, collections, allocations, reconciliation, envelope printing, and historical finance data remain.
- Zeffy is the configured giving provider; Stripe APIs are inactive unless explicitly enabled.
- Added security headers, same-origin mutation checks, request limits, and image signature checks. Gallery media checks visibility before serving the object.
- Newsletter sends are queued and processed by cron in chunks. Durable recipient records prevent successful recipients being resent during ordinary retries, and each send rechecks consent. Unsubscribe links are signed, confirmation GETs do not change consent, and one-click POSTs persist suppression before synchronizing both stores.
- Scheduled newsletters interpret the chosen IANA timezone, including Central time, and reject nonexistent or ambiguous daylight-saving times.
- Failed contact/rental notification and confirmation emails have a durable retry queue with stable provider idempotency keys and bounded attempts.
- Added missing fresh-install tables, required build-input validation, canonical/social metadata, church structured data, keyboard focus and skip links. Isolated legacy server tests from public exports so validation cannot replace ministry profiles and other public content with temporary fixtures.
- Updated dependencies and added launch-validation CI. Monthly maintenance runs at 02:00 Indianapolis time, uses the monthly-maintenance branch, preserves a readable report, and can email it when the GitHub secrets are supplied.

## Validation

Worker, admin UI, and development-server guard tests pass. Fresh admin and site migrations are checked against SQLite. The production dependency audit has no advisories; four low/moderate advisories remain in the legacy development server dependency tree. Production dry-run, live deployment, browser testing, and real service delivery are not certified by these checks.

## Owner setup before launch

1. Revoke the exposed Turnstile secret in Cloudflare and set its replacement with `npx wrangler secret put TURNSTILE_SECRET_KEY --env production`. Removing it from current files does not remove it from Git history. Confirm the matching site key and allowed hostname.
2. Set a random `NEWSLETTER_UNSUBSCRIBE_SECRET` of at least 32 characters as a production Worker secret. Keep it stable to preserve previously sent unsubscribe links. Verify Resend sender-domain setup, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `SUPPORT_TO_EMAIL`.
3. Back up both production D1 databases, review/apply admin and site migrations, and deploy the reviewed Worker and rebuilt assets. Runtime compatibility additions for older finance schemas remain; no historical tables or records are removed.
4. Replace isolated preview database placeholders and configure preview storage, secrets, and Access. Confirm production Access identity/policies and that workers.dev and preview URL access are disabled for production.
5. Configure GitHub Actions and the report-email secrets `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `MAINTENANCE_TO_EMAIL`. Run launch validation and verify its result. Require its status check in branch protection through repository settings if desired.
6. Purge previously cached gallery media after deployment; old cached public objects cannot be recalled by a source change. Test hidden media and authorized admin access, public forms/inbox, newsletter consent/scheduling, partial delivery recovery, and mobile layout in preview.
7. The owner performs the final domain switch. Current routes, public URLs, canonical tags, robots and sitemap deliberately use `mmmbc.alphazonelabs.com`. Change those together with Cloudflare routes, Access applications, Turnstile hostnames, redirects, and DNS when ready. Existing profile images referenced from mmmbc.com/wp-content must remain available or be migrated before retiring the WordPress host.

## Cleanup hold

Legacy backend files, old PDFs, unused icons/assets, duplicated generated output, and obsolete documentation are not being removed in this implementation. Scanner-specific retirement is the exception explicitly requested by the owner. Review cleanup candidates before the next pass.
