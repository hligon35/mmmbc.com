# Demo data seeder

`scripts/seed_demo_data.mjs` creates synthetic records for the admin dashboard,
CMS page fields, public static fallbacks, and site submissions. It is safe to
re-run: generated records use the `demo-` prefix and `example.com` addresses.

Demo data is for local Workers only. Start a local Worker with a demo environment and pass its URL:

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
