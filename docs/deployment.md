# Deployment

## Production

1. Confirm Cloudflare account `e02ea8e0b7fe319f04e2505df1138d4c` (set in `wrangler.jsonc`), the `alphazonelabs.com` zone, and the `mmmbc.alphazonelabs.com` Worker custom domain.
2. Export D1 database `mmdb` and back up R2 bucket `mmmbc`.
3. Run `npm ci`, `npm --prefix admin ci`, and `npm run check`.
4. Verify Access and Resend.
5. Apply reviewed D1 migrations remotely: `npx wrangler d1 migrations apply mmdb --remote`. All migrations live in one ordered sequence under `migrations/`; the `DB` and `SITE_DB` bindings both point at `mmdb`.
6. Run `npm run deploy`.
7. Purge any previously cached gallery media. Verify public pages, security headers, unauthenticated rejection, authenticated reads, forms with test data, and a Resend test recipient.

Never test destructive admin, bulk-email, or real-payment behavior against production.


The only deployment target is Worker `mmmbc` (D1 `mmdb`, R2 `mmmbc`). There are no preview or legacy environments. The owner performs any later mmmbc.com domain switch after validation. See launch-readiness-report.md for required secrets and migration prerequisites.

`cf_site/` is generated output and is no longer committed. For Workers Builds, use `npm run build` as the build command and `npm run deploy` as the deploy command. A normal `npm ci` generates assets via `prepare`; if installing with `--ignore-scripts`, explicitly build before deploying.

Configure exactly one Workers Builds Git connection (repository `hligon35/mmmbc.com`, production branch `master`, build command `npm run build`, deploy command `npm run deploy`) with non-production branch builds disabled so a push cannot start duplicate builds.

## Admin delivery safeguards

The current entry is the refined **tabbed admin**, selected by `admin/public/index.html`.
The mailbox shell is not loaded. Do not change that selection through a deployment
override. The static build now preserves the source script order, fingerprints all
admin entry scripts and styles from their contents, and writes
`cf_site/admin/build-info.json`. `npm run deploy` rebuilds and verifies that the
HTML and each referenced asset match the current source before invoking Wrangler.
Missing assets, a revived mailbox entry, stale HTML, or mixed assets fail validation.

Run `npm run test:admin:browser` for the current admin. The older
`test:workspace:browser` command is a compatibility alias; CI no longer tests a
mailbox layout that the entry intentionally disables. Worker/API permission tests
remain in place.

After a build, compare `cf_site/admin/build-info.json` with the `adminBuild`
fingerprint returned by `/api/build-info` on the live domain. The Worker marker alone
is not proof that current admin assets were deployed. An absent fingerprint means
the live assets are older or incomplete. Confirm the successful Cloudflare build
uses the intended master commit; disable any other branch/repository connection
that can overwrite Worker `mmmbc`. Dashboard settings and live deployment must be
verified in Cloudflare; a repository commit alone does not establish either.
