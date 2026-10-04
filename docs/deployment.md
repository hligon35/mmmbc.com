# Deployment

## Preview

Provision `admin-preview`, `site-preview`, and `mmmbc-preview`. Replace the intentional placeholder UUIDs in `wrangler.jsonc`, store preview secrets, apply migrations, and deploy with `--env preview`.

## Production

1. Confirm the Cloudflare account and current `alphazonelabs.com` zone and `mmmbc.alphazonelabs.com` routes.
2. Export both production D1 databases.
3. Run `npm ci`, `npm --prefix admin ci`, and `npm run check`.
4. Verify Access and Resend.
5. Apply reviewed D1 migrations remotely to their matching database.
6. Run `npm run deploy`.
7. Purge any previously cached gallery media. Verify public pages, security headers, unauthenticated rejection, authenticated reads, forms with test data, and a Resend test recipient.

Never test destructive admin, bulk-email, or real-payment behavior against production.


The owner performs the final mmmbc.com domain switch after validation. See launch-readiness-report.md for required secrets and migration prerequisites.

`cf_site/` is generated output and is no longer committed. For Workers Builds, use `npm run build` as the build command and `npm run deploy` as the deploy command. A normal `npm ci` generates assets via `prepare`; if installing with `--ignore-scripts`, explicitly build before deploying.
