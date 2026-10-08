# Cloudflare Access

Create a self-hosted Access application in the client Cloudflare account covering:

- `mmmbc.com/admin`
- `mmmbc.com/admin/*`
- protected administrative APIs

Allow only approved administrator identities. Add explicit bypass policies for APIs intentionally designed as public, including published content, public feeds, the Zeffy giving redirect and signed newsletter preference endpoint, and protected public-form endpoints.

The public workers.dev origin remains available. Admin navigation on `mmmbc.hligon.workers.dev` redirects to the primary domain before the workspace handles authentication. Extend the existing Access application so its audience remains valid, or update `CF_ACCESS_AUD` when creating a replacement. Keep the old domain protected while it remains attached.

Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` after creation. The Worker validates the Access JWT and then applies D1 role permissions. Keep `DEV_BYPASS_AUTH=false` and `ALLOW_SERVICE_TOKEN_ADMIN=false` in production.

