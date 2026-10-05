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
