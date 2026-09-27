# Cloudflare Access Setup

Repository code validates Access JWTs but cannot create the dashboard policy. Complete these steps before deployment.

## Enable email one-time PIN

1. Open **Cloudflare Dashboard > Zero Trust > Integrations > Identity providers**.
2. Select **Add new identity provider > One-time PIN**, then save.
3. If mail filtering is used, allow `noreply@notify.cloudflare.com` and `notify.cloudflare.com`.

## Protect admin paths

1. Open **Zero Trust > Access controls > Applications > Add an application > Self-hosted**.
2. Create protected applications for `mmmbc.com/admin/*`, `mmmbc.com/scan*`, and the protected administrative API routes.
3. On each, add an **Allow** policy containing only approved administrator email addresses and select One-time PIN as the login method.
4. Create more-specific self-hosted applications for `mmmbc.com/api/public/*`, `/api/site-content/*`, and `/api/giving/*`. Give each a **Bypass** policy with **Include > Everyone**. Leave public media and normal site assets outside the protected API application.
5. Confirm the more-specific public application paths take precedence over `/api/*`.

## Configure Worker variables

1. For each protected application, open **Configure > Additional settings** and copy its **Application Audience (AUD) Tag**.
2. Set `CF_ACCESS_TEAM_DOMAIN` to `https://<team-name>.cloudflareaccess.com` in every deployed Worker environment.
3. Set `CF_ACCESS_AUD` to the accepted AUD. If the admin and API applications differ, use both tags as a comma-separated value.
4. Keep `ADMIN_ALLOW_EMAILS` only as emergency first-user bootstrap. Once D1 has an active Administrator, manage users in **Settings > Users & Roles**.

These are configuration variables, not browser secrets. Never configure a Cloudflare API token in frontend code or D1.

## Verify

1. Apply migration `0007` before enabling enforcement.
2. Sign in with one approved address and confirm `/api/me` returns its D1 role, status, and permissions.
3. Sign out at `/cdn-cgi/access/logout`.
4. Try one unlisted address and confirm Access denies it.
5. Confirm `/api/public/announcements`, `/api/site-content/home`, and public giving work without an Access session.
6. Confirm a pending, suspended, or revoked D1 administrator receives `403` after successful Access authentication.

Dashboard configuration has not been performed by repository changes alone.
