# Cloudflare Access

Create a self-hosted Access application in the client Cloudflare account covering:

- `mmmbc.com/admin/*`
- protected administrative APIs
- `mmmbc.com/scan*`

Allow only approved administrator identities. Add explicit bypass policies for APIs intentionally designed as public, including published content, public feeds, giving initiation/webhooks, and protected public-form endpoints.

Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` after creation. The Worker validates the Access JWT and then applies D1 role permissions. Keep `DEV_BYPASS_AUTH=false` and `ALLOW_SERVICE_TOKEN_ADMIN=false` in production.
