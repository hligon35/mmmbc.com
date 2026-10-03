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


## Source and generated output

Public pages, approved asset folders, and `admin/public/` are canonical. `cf_site/` is generated and ignored by Git. `npm ci` runs the asset build through `prepare`; `npm run build` explicitly rebuilds it. Wrangler CLI also has a custom build command. In Cloudflare Workers Builds, configure **Build command: `npm run build`**, **Deploy command: `npm run deploy`**, and repository root as the working directory. Do not deploy an unbuilt checkout with lifecycle scripts disabled.

See [cleanup notes](docs/repository-cleanup.md) for removed files and uncertain candidates retained.
