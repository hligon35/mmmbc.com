# Deployment

## Production

Online giving: follow [Zeffy setup](zeffy-setup.md) to confirm the campaign and embed URLs before release. The public /give route serves MMMBC's branded page with Zeffy's checkout.

1. Confirm Cloudflare account `e02ea8e0b7fe319f04e2505df1138d4c` (set in `wrangler.jsonc`), the active `mmmbc.com` zone, and the account workers.dev subdomain `hligon`. Worker name `mmmbc` plus this account subdomain gives `mmmbc.hligon.workers.dev`; Wrangler cannot choose a different account subdomain for one Worker.
2. Export D1 database `mmdb` and back up R2 bucket `mmmbc`.
3. Run `npm ci`, `npm --prefix admin ci`, and `npm run check`.
4. Verify Access and Resend.
5. Apply reviewed D1 migrations remotely: `npx wrangler d1 migrations apply mmdb --remote`. This includes `0018_restore_simple_finance_recorder.sql` and `0019_restore_finance_workflow.sql`; together they restore only the lightweight money-recording workflow, void metadata, and category/fund lists. They do not recreate the retired advanced finance dashboard. All migrations live in one ordered sequence under `migrations/`; the `DB` and `SITE_DB` bindings both point at `mmdb`.
6. Run `npm run deploy`.
7. Purge any previously cached gallery media. Verify public pages, security headers, unauthenticated rejection, authenticated reads, forms with test data, and a Resend test recipient.

Never test destructive admin, bulk-email, or real-payment behavior against production.


The only deployment target is Worker `mmmbc` (D1 `mmdb`, R2 `mmmbc`). Production serves `https://mmmbc.com` and `https://mmmbc.hligon.workers.dev`. There are no separate preview environments. The old `mmmbc.alphazonelabs.com` custom domain remains attached during cutover. See launch-readiness-report.md for required secrets and migration prerequisites.

`cf_site/` is generated output and is no longer committed. For Workers Builds, use `npm run build` as the build command and `npm run deploy` as the deploy command. A normal `npm ci` generates assets via `prepare`; if installing with `--ignore-scripts`, explicitly build before deploying.

Configure exactly one Workers Builds Git connection (repository `hligon35/mmmbc.com`, production branch `master`, build command `npm run build`, deploy command `npm run deploy`) with non-production branch builds disabled so a push cannot start duplicate builds.

## Domain cutover

- Ensure `mmmbc.com` is an active zone in the configured account. Back up current DNS before cutover. A conflicting apex CNAME must be removed before attaching the Worker custom domain; preserve mail/MX/TXT records. The custom domain makes this Worker the origin and Cloudflare manages its DNS/certificate.
- Confirm Workers & Pages shows account subdomain `hligon`. Do not rename an account-wide subdomain blindly: that changes the URLs of other Workers.
- Update the existing Cloudflare Access application to cover `mmmbc.com/admin`, `mmmbc.com/admin/*`, and the protected administrative APIs. Retain its approved Google identity provider and D1 permissions. Keep its audience unchanged if extending the existing application; if replacing it, set the new `CF_ACCESS_AUD` before deployment. Public pages, feeds, giving, forms, and signed/webhook endpoints must remain reachable.
- Add `mmmbc.com` and `mmmbc.hligon.workers.dev` to the existing Turnstile widget's allowed hostnames. The repo's `TURNSTILE_ALLOWED_HOSTNAMES` list validates tokens for these explicit hosts and retains the old host during transition; this variable does not update the Cloudflare widget.
- Run `npm run deploy` with Cloudflare credentials authorized for this account and zone. This enables workers.dev and attaches `mmmbc.com` through the checked-in custom-domain route. Existing D1 and R2 bindings, Worker secrets, and cron triggers continue on Worker `mmmbc`.
- Verify public navigation, same-origin public API responses, giving, and a form submission on both origins. Admin navigation from workers.dev redirects to `mmmbc.com` before authentication or asset delivery; private APIs still validate Access JWTs.
- Verify a Google admin login, newsletter/invite links, live video, and the admin build fingerprint on `mmmbc.com`. Generated public links and canonicals use `https://mmmbc.com`.
- The current config does not attach `www.mmmbc.com`. If that hostname is used, configure a proxied DNS record and a Cloudflare redirect to the apex before release.
- Once the new origin is verified, remove the old custom-domain route in a separate reviewed change. Rollback uses the prior Worker deployment and DNS backup.

Repository setup alone does not perform Cloudflare DNS, Access, Turnstile, or deployment changes.

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
