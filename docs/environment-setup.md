# Environment setup

Use the root `.env.example` as the inventory of configuration names. Local values belong in `.dev.vars` or another ignored environment file. Production Worker secrets must be stored with Wrangler, never in Git.

```sh
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put TURNSTILE_SECRET_KEY --env production
npx wrangler secret put STRIPE_SECRET_KEY --env production
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

Create a Turnstile widget in Cloudflare for `mmmbc.alphazonelabs.com`. Its **site key** is public: set `TURNSTILE_SITE_KEY` under `env.production.vars` in `wrangler.jsonc`. Store its matching **secret key** with the `wrangler secret put TURNSTILE_SECRET_KEY --env production` command above. Both values are required: the contact and rental forms display an unavailable message until both are configured. Redeploy the production Worker after setting the site key, then check `/api/public/site-settings` for `formVerificationUnavailable: false` and a `turnstileSiteKey`. Never put the secret in Git.

Contact, facility rental, and newsletter forms all need a fresh Turnstile token. For a site key managed outside the repo, you can set it as a production Worker secret with `npx wrangler secret put TURNSTILE_SITE_KEY --env production`; keep the matching secret key in `TURNSTILE_SECRET_KEY`. The site settings response must show `verificationRequired: true`, `formVerificationUnavailable: false`, and a site key. Check the Cloudflare widget's allowed hostname before testing from a browser.

Access team domain, audience, canonical host, allowed administrators, and sender identity are Worker variables. Confirm the values in `wrangler.jsonc` before deployment.
