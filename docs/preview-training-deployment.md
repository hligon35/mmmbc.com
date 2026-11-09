# Preview training deployment

Training site: https://mmmbc-preview.hligon.workers.dev/admin.
Individual training guides should use this address for independent preparation before the scheduled session.

| Target | Branch | Worker | D1 | R2 |
| --- | --- | --- | --- | --- |
| Production: mmmbc.com | master | mmmbc | mmdb | mmmbc |
| Training: mmmbc-preview.hligon.workers.dev | preview | mmmbc-preview | mmmbc-preview | mmmbc-preview |

Production stays on its current Worker, domain, database, storage, secrets, and build connection. There is no production cutover, no domain transfer, and no need to disable production builds. The old alphazonelabs.com domains are absent from the checked-in routes; remove any remaining dashboard custom domains/routes/redirects separately, preserving unrelated DNS and mail records.

## First deployment (Windows PowerShell)

Run from the repository root:

```powershell
git fetch origin
git switch preview
git pull --ff-only origin preview
npm ci
npx wrangler login
npx wrangler d1 list
npx wrangler r2 bucket list
```

If the preview resources do not already exist, create them once:

```powershell
npx wrangler d1 create mmmbc-preview
npx wrangler r2 bucket create mmmbc-preview
```

Copy the actual mmmbc-preview database UUID. Configure a separate Cloudflare Access application for the training hostname, protecting administration and its private APIs, with the approved sign-in identities. Use the getsparqd-server team configured in the repository; a different team requires updating CF_ACCESS_TEAM_DOMAIN in the preview generator. Copy the training application's Application Audience (AUD). Do not disable authentication or reuse an arbitrary audience.

```powershell
$env:MMMBC_PREVIEW_DATABASE_ID = "<preview database UUID>"
$env:MMMBC_PREVIEW_ACCESS_AUD = "<training Access AUD>"
npm run deploy:preview
```

The script requires branch preview, rejects the production database UUID, generates wrangler.preview.generated.json, builds/verifies assets, applies preview migrations and deploys only Worker mmmbc-preview. No cutover confirmation variable is needed. The generated config is ignored by git.

Do not run plain npm run deploy for training: it targets production.

## Authentication and forms

- Preview migrations seed pending users. Activate the approved initial administrator in preview D1 using the roster activation process, then verify each approved trainee's role and status. Never run preview account setup against mmdb. The training-material exclusions remain hligon@getsparqd.com, Elbert Spears, and Calvin Cole Jr; the maintainer can still administer the environment.
- Add mmmbc-preview.hligon.workers.dev to the existing Turnstile widget matching the public TURNSTILE_SITE_KEY. Set its matching secret on the new Worker after the first deployment:

```powershell
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.preview.generated.json
```

- For a separate Turnstile widget, change TURNSTILE_SITE_KEY in scripts/preview-config.mjs to its public key and use the matching secret. Public forms fail closed without verification.
- The new Worker has no inherited production secrets. Do not copy Resend/payment/integration credentials. If testing signed newsletter preference links, set a separate NEWSLETTER_UNSUBSCRIBE_SECRET using the same preview config.
- Use fictional training records. Do not copy the production member database or real payment records.

## Automatic deployment from GitHub

The workflow .github/workflows/preview-deployment.yml deploys pushes to preview and supports manual dispatch on that branch. It remains gated until repository variable MMMBC_PREVIEW_READY is true.

In GitHub Settings > Secrets and variables > Actions, configure:

| Type | Name | Value |
| --- | --- | --- |
| Secret | CLOUDFLARE_API_TOKEN | Token authorized for Worker deployment, asset uploads and preview D1 migrations in this account |
| Variable | MMMBC_PREVIEW_DATABASE_ID | Actual preview D1 UUID |
| Variable | MMMBC_PREVIEW_ACCESS_AUD | Training application's Access audience |
| Variable | MMMBC_PREVIEW_READY | true, once the preview settings are ready |

Use GitHub Actions as the single preview deployment connection; do not add a second Cloudflare Workers Builds connection for preview. Keep the production Workers Builds connection on master with non-production builds disabled. Each preview deployment is serialized, has no custom domains or cron triggers, and uses separate storage.

After setup, push another commit to preview or dispatch the workflow on preview. If a run fails before any jobs start, inspect GitHub Actions policy/billing settings; a pushed commit alone does not prove deployment succeeded.

## Review and release

Open the training URL and verify real Access login, approved roles, and the admin build fingerprint. Confirm sample data persists only in preview and gallery uploads go to preview R2. Outbound email, payments, Zeffy synchronization and scheduled processing are disabled; a successful real email-delivery exercise is not available here. Training responses have no-index headers.

Review changes on preview, then open a PR from preview to master for production release. Production continues targeting mmmbc. Repository changes do not create Cloudflare resources, configure Access, activate users, or set GitHub secrets automatically.
