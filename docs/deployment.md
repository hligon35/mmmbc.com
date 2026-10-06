# Deployment

## Production

1. Confirm Cloudflare account `e02ea8e0b7fe319f04e2505df1138d4c` (set in `wrangler.jsonc`), the `alphazonelabs.com` zone, and the `mmmbc.alphazonelabs.com` Worker custom domain.
2. Export D1 database `mmdb` and back up R2 bucket `mmmbc`.
3. Run `npm ci`, `npm --prefix admin ci`, and `npm run check`.
4. Verify Access and Resend.
5. Apply reviewed D1 migrations remotely: `npx wrangler d1 migrations apply mmdb --remote`. This includes `0018_restore_simple_finance_recorder.sql` and `0019_restore_finance_workflow.sql`; together they restore only the lightweight money-recording workflow, void metadata, and category/fund lists. They do not recreate the retired advanced finance dashboard. All migrations live in one ordered sequence under `migrations/`; the `DB` and `SITE_DB` bindings both point at `mmdb`.
6. Run `npm run deploy`.
7. Purge any previously cached gallery media. Verify public pages, security headers, unauthenticated rejection, authenticated reads, forms with test data, and a Resend test recipient.

Never test destructive admin, bulk-email, or real-payment behavior against production.


The only deployment target is Worker `mmmbc` (D1 `mmdb`, R2 `mmmbc`). There are no preview or legacy environments. The owner performs any later mmmbc.com domain switch after validation. See launch-readiness-report.md for required secrets and migration prerequisites.

`cf_site/` is generated output and is no longer committed. For Workers Builds, use `npm run build` as the build command and `npm run deploy` as the deploy command. A normal `npm ci` generates assets via `prepare`; if installing with `--ignore-scripts`, explicitly build before deploying.

Configure exactly one Workers Builds Git connection (repository `hligon35/mmmbc.com`, production branch `master`, build command `npm run build`, deploy command `npm run deploy`) with non-production branch builds disabled so a push cannot start duplicate builds.

## Admin delivery safeguards

The current entry is the **mailbox workspace shell**, selected by `admin/public/index.html`.
The older tabbed admin remains mounted only as module work areas for sections such as
Announcements, Photos, Directory, Newsletter, Access, and Support. Do not disable or
strip the workspace shell during deployment. The static build now preserves the source script order, fingerprints all
admin entry scripts and styles from their contents, and writes
`cf_site/admin/build-info.json`. `npm run deploy` rebuilds and verifies that the
HTML and each referenced asset match the current source before invoking Wrangler.
Missing workspace assets, a reverted tabbed-only entry, stale HTML, or mixed assets fail validation.

Run `npm run test:admin:browser` for the current mailbox workspace. The
`test:workspace:browser` command remains a compatibility alias for the same current shell. Worker/API permission tests
remain in place.

After a build, compare `cf_site/admin/build-info.json` with the `adminBuild`
fingerprint returned by `/api/build-info` on the live domain. The Worker marker alone
is not proof that current admin assets were deployed. An absent fingerprint means
the live assets are older or incomplete. Confirm the successful Cloudflare build
uses the intended master commit; disable any other branch/repository connection
that can overwrite Worker `mmmbc`. Dashboard settings and live deployment must be
verified in Cloudflare; a repository commit alone does not establish either.

## Release status checks

- GitHub Actions: every run since 2026-09-28 (including scheduled runs of all three workflows) ends in `startup_failure` with zero jobs and zero check runs, while the workflow files parse without errors. The pattern points to an account or repository setting (Actions billing/spending limit or policy) rather than workflow content or application tests. The run page's Annotations banner carries the exact message; the API does not expose it.
- Workers Builds: the check run `Workers Builds: mmmbc` completed successfully for commit `39a4d05` on `master` (Script `mmmbc`), and there is exactly one such check. D1 `mmdb` and R2 `mmmbc` bindings match `wrangler.jsonc`.
- The live admin is behind Cloudflare Access, so `/api/build-info` cannot be read without an authenticated session. Run `npm run verify:admin-delivery` locally, then compare the signed-in `/api/build-info` `adminBuild.fingerprint` with the `mmmbc-admin-build` meta tag after deploy.