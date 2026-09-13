# System analysis

MMMBC is a static-first church website with a Cloudflare Worker application layer and a tailored administrative console. Existing modules cover site content, announcements, events, bulletins, gallery media, livestream settings, contact and facility-rental submissions, newsletters, directory records, giving, donors, envelope scanning, reconciliation, reports, and role-based administration.

The authoritative public source remains the repository root plus `Pages/` and approved asset directories. `scripts/build_cf_site.mjs` deterministically produces `cf_site/`; generated files are not a second source of truth.

## Final architecture

- Public/admin assets: Worker Static Assets
- APIs and scheduled work: Cloudflare Workers
- Administrative data: D1 binding `DB`
- Anonymous form data: separate D1 binding `SITE_DB`
- Media: R2 binding `GALLERY_BUCKET`
- Administrator identity: Cloudflare Access JWT plus D1 RBAC
- Anonymous-form protection: Turnstile and D1 rate limiting
- Application email: Resend
- Giving: existing Stripe integration, with verified webhooks and integer-cent storage

## Risks resolved

- Application email is consolidated on Resend.
- Preview configuration no longer points to production storage.
- Production canonical URLs use `mmmbc.com`.
- The deployment build publishes only curated assets.
- The monthly workflow never deploys, merges, or migrates remote databases.

## External blockers

Cloudflare authentication, isolated preview resource IDs, Access values, Resend verification/secrets, and GitHub administrative authentication must be supplied by an authorized account owner.
