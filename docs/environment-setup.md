# Environment setup

Use the root `.env.example` as the inventory of configuration names. Local values belong in `.dev.vars` or another ignored environment file. Production Worker secrets must be stored with Wrangler, never in Git.

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put NEWSLETTER_UNSUBSCRIBE_SECRET
```

Create a Turnstile widget in Cloudflare for `mmmbc.alphazonelabs.com`. Its **site key** is public: set `TURNSTILE_SITE_KEY` under `vars` in `wrangler.jsonc`. Store its matching **secret key** with the `wrangler secret put TURNSTILE_SECRET_KEY` command above. Both values are required: the contact and rental forms display an unavailable message until both are configured. Redeploy the production Worker after setting the site key, then check `/api/public/site-settings` for `formVerificationUnavailable: false` and a `turnstileSiteKey`. Never put the secret in Git.

Contact, facility rental, and newsletter forms all need a fresh Turnstile token. For a site key managed outside the repo, you can set it as a production Worker secret with `npx wrangler secret put TURNSTILE_SITE_KEY`; keep the matching secret key in `TURNSTILE_SECRET_KEY`. The site settings response must show `verificationRequired: true`, `formVerificationUnavailable: false`, and a site key. Check the Cloudflare widget's allowed hostname before testing from a browser.

Apply the site database migrations to the production D1 database before accepting form submissions:

```sh
npx wrangler d1 migrations apply mmdb --remote
```

The form endpoints accept an older schema temporarily and return a JSON error if saving fails, but the newer migrations provide structured contact fields, inbox read/archive actions, and reply status tracking.

Access team domain, audience, canonical host, allowed administrators, and sender identity are Worker variables. Confirm the values in `wrangler.jsonc` before deployment.


NEWSLETTER_UNSUBSCRIBE_SECRET must be random and at least 32 characters long. NEWSLETTER_TIMEZONE defaults to America/Chicago. GIVING_PROVIDER defaults to zeffy; Stripe credentials are only relevant if that provider is explicitly enabled.
