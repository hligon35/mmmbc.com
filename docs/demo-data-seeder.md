# Demo data seeder

`scripts/seed_demo_data.mjs` creates synthetic records for the admin dashboard,
CMS page fields, public static fallbacks, and site submissions. It is safe to
re-run: generated records use the `demo-` prefix and `example.com` addresses.

For the preview Worker, after the preview D1 databases and R2 bucket exist:

```bash
npx wrangler login
node scripts/seed_demo_data.mjs \
  --target preview \
  --apply \
  --replace-page-content \
  --submit-forms \
  --write-static \
  --upload-r2
npm run build:cf
npx wrangler deploy --env preview
```

`--submit-forms` makes ten newsletter, ten contact, and ten facility-rental
POSTs through the same public endpoints used by the site. The preview Worker
has `DEMO_MODE=true`, so those records are stored for the demo while Turnstile,
rate limiting, and outbound email are skipped only in preview. Production keeps
`DEMO_MODE=false`.

For a local Worker, start it with a local/demo environment and pass its URL:

```bash
node scripts/seed_demo_data.mjs \
  --target local \
  --apply \
  --replace-page-content \
  --submit-forms \
  --base-url http://127.0.0.1:8787
```

Use `--preserve-page-content` when existing CMS rows must not be replaced. Use
`--clean --apply` to remove the generated database records. Production seeding
is blocked unless `MMBC_ALLOW_REMOTE_DEMO_SEED=1` is explicitly set, and public
form submission is always blocked for the production target.


R2 demo bulletin uploads use `scripts/fixtures/demo-bulletin.pdf`, a synthetic sample. Retired rental agreements are no longer required for demo setup.
