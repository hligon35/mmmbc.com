# MMMBC Zeffy giving setup

## Implemented behavior

`/give` serves the restored church-branded page with the existing logo, intro, navigation, and an embedded Zeffy donation form. Legacy giving and success-page URLs redirect to `/give`; a return visit never claims a gift was paid. Amount, fund designation, recurring giving, donor information, payment, and receipts belong to Zeffy's campaign. There are no duplicate custom payment fields and no platform fee added by this page.

The modern Zeffy embed dynamically sizes the form. A legacy iframe is available if its script fails, and the direct Zeffy checkout link is always available (including for payment methods offered only on hosted checkout). The page explains that Zeffy's additional contribution is optional and can be $0.

This change does not import transactions into the admin or enable Zeffy API/webhook processing. Existing Stripe history is preserved; Stripe checkout remains gated behind `GIVING_PROVIDER=stripe`. Keep `GIVING_PROVIDER=zeffy`.

## Exactly what is needed from the church's account

1. **The live campaign share link.** In Zeffy, open **Campaigns → Tithes and Offering → ⋯ → Share**. Confirm the existing link belongs to MMMBC and is still open:
   `https://www.zeffy.com/en-US/donation-form/tithes-and-offering-59`.
   If different, set the Worker variable `ZEFFY_DONATION_URL` to the new link.
2. **The generated Campaign embed code.** In the same sharing dialog, select **More ways to share → Embed → Campaign** and copy the generated HTML. Extract the `data-form-url` or iframe URL and set `ZEFFY_EMBED_URL` to its full `https://www.zeffy.com` URL. A relative `data-form-url` should be resolved against that origin. Send the public share link and embed code to the developer; neither is a secret. Do not paste arbitrary embed HTML into Worker variables.
3. **Account readiness confirmation.** The church should complete Zeffy's identity/nonprofit verification and link its own payout bank account in Zeffy. Confirm the campaign is open. Bank details and passwords should remain in Zeffy.
4. **Campaign choices confirmed in Zeffy.** Set the approved fund choices, suggested gift amounts, recurring giving options, and receipt information directly on that campaign. The website reflects those choices automatically; the retired page's six custom fund buttons do not configure the campaign.

No Zeffy API key, Stripe secret, connected-account ID, webhook, or login password is needed for the public giving page.

## Worker configuration

Public variables for Worker `mmmbc`:

| Variable | Value |
| --- | --- |
| `GIVING_PROVIDER` | `zeffy` |
| `ZEFFY_DONATION_URL` | The campaign's public share URL |
| `ZEFFY_EMBED_URL` | The complete embed URL copied from that campaign |

The existing campaign share URL is configured in `wrangler.jsonc`. If `ZEFFY_EMBED_URL` is omitted, the page derives Zeffy's documented `/embed/donation-form/<campaign-slug>` path. This derived URL is provisional until confirmed against the account's generated embed code. An empty/invalid embed override shows the direct checkout link; an invalid share URL disables checkout rather than redirecting to an untrusted site.

For local Wrangler testing, use a gitignored `.dev.vars` file. Values in `.env.example` are documentation and are not automatically production Worker variables. For a durable production change, update the public `vars` in `wrangler.jsonc`; a dashboard-only override may be replaced by a later deploy.

## Release checks

- Run the giving tests: `node --test src/worker-giving-pages.test.mjs`.
- Run `npm run test:giving:browser` with Playwright Chromium installed (`npx playwright install chromium`). It checks the modern embed, blocked-script fallback, and no-JavaScript checkout at desktop and mobile widths using an offline Zeffy fixture.
- Build and deploy through the repo's normal release workflow after merging the reviewed update branch.
- On the actual domain, check desktop/mobile layout, navigation, embedded form, direct link, fund choices, recurring options, and Zeffy's optional-contribution disclosure.
- Follow Zeffy's documented payment-test procedure or coordinate an authorized test with the church; confirm the receipt and payout destination in Zeffy. No live payment was made during implementation.

## Optional future admin integration

Donation synchronization is a separate integration. If requested, an account administrator can generate an API key under **Settings → Integrations**. Store it as a Cloudflare Worker secret, never in the repository or browser. Before implementing webhooks, confirm Zeffy's current verification/signature requirements and payload from its technical documentation. A webhook URL or signing secret is not required by this public-page change.

## Official references

- [Embed setup](https://support.zeffy.com/how-to-embed-your-zeffy-campaign-on-your-website-km0gv)
- [Modern embed example](https://support.zeffy.com/how-to-share-or-embed-a-translated-campaign-in-a-specific-language-9fs93)
- [Optional contributions](https://support.zeffy.com/what-is-the-contribution-made-towards-zeffy-why-was-i-charged-extra-s41ae)
- [API setup](https://support.zeffy.com/get-started-with-the-zeffy-api-yourg)
- [External payment-form limitation](https://support.zeffy.com/integrating-zeffy-as-a-payment-processor-into-an-external-form-6qu1y)
