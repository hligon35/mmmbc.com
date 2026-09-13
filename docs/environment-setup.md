# Environment setup

Use the root `.env.example` as the inventory of configuration names. Local values belong in `.dev.vars` or another ignored environment file. Production Worker secrets must be stored with Wrangler, never in Git.

```sh
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put TURNSTILE_SECRET_KEY --env production
npx wrangler secret put STRIPE_SECRET_KEY --env production
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

`TURNSTILE_SITE_KEY` is public. Access team domain, audience, canonical host, allowed administrators, and sender identity are Worker variables. Confirm the values in `wrangler.jsonc` before deployment.
