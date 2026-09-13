# Mount Moriah Missionary Baptist Church

Cloudflare-hosted public website and church administration platform for `mmmbc.com`.

## Platform

- Cloudflare Worker Static Assets serves the public and admin interfaces.
- Workers provide public and protected APIs.
- D1 stores administration, directory, finance, content, and public-form data.
- R2 stores gallery and site-editor media.
- Cloudflare Access protects the admin and finance interfaces.
- Turnstile protects anonymous forms.
- Resend is the only application email provider.

## Local verification

```sh
npm ci
npm --prefix admin ci
npm run check
```

Copy `.env.example` to a local untracked environment file and follow the documents in `docs/`. Never commit credentials.

## Deployment

Production deployments must originate from a reviewed branch and run:

```sh
npm run build:cf
npm run worker:dry-run
npm run deploy
```

The preview configuration intentionally contains non-production placeholder D1 IDs until isolated preview resources are provisioned.
