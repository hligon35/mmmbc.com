# MMMBC Zeffy giving setup

## Implemented behavior

`/give` serves the restored church-branded page with the existing logo, intro, navigation, and an embedded Zeffy donation form. Legacy giving and success-page URLs redirect to `/give`; a return visit never claims a gift was paid. Amount, fund designation, recurring giving, donor information, payment, and receipts belong to Zeffy's campaign. There are no duplicate custom payment fields and no platform fee added by this page.

The modern Zeffy embed dynamically sizes the form. A legacy iframe is available if its script fails, and the direct Zeffy checkout link is always available (including for payment methods offered only on hosted checkout). The page explains that Zeffy's additional contribution is optional and can be $0.

The public giving page uses Zeffy's embed. Admin donation syncing uses Zeffy's server-side API and is documented below. Existing Stripe history is preserved; Stripe checkout remains gated behind `GIVING_PROVIDER=stripe`. Keep `GIVING_PROVIDER=zeffy`.

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

## Admin donation syncing

Open **Church Finances → Zeffy Donations**. This view imports online payments from explicitly selected donation campaigns. It supports donor/payment search, status filters, pagination, reported amounts, refund details, last-completed sync time, actionable errors, and **Sync Now**. Administrators and Finance Officers have `giving.sync`; Finance Entry users can view imports but cannot run syncs or inspect the campaign list. Website Managers and Support Viewers have no access.

Imports are stored in `zeffy_payments`, separately from manual `finance_entries`. They are not automatically added to the recorder's income, net, giving summaries, receipts, or reports. This avoids counting a gift twice when it was already recorded manually. Reported amounts are not netted against refunds, optional Zeffy contributions, disputes, or bank payouts. Zeffy's own receipts and payout reports remain authoritative. No card/bank details, API keys, or full provider response bodies are stored with imports. No payments or contacts are written back to Zeffy and no donor emails are sent.

### Exactly what is needed from the Zeffy account

1. **One organization API key.** The church's Zeffy administrator generates it in **Settings → Organization → Integrations** (the Help Center also calls this Settings → Integrations). An existing valid API key for this same organization can be reused. Store it directly as the Cloudflare Worker `ZEFFY_API_KEY` secret; do not send it in chat or add it to git. No new Stripe API key is needed.
2. **API campaign IDs for the donation forms to import.** These are not the public page slug `tithes-and-offering-59`. After storing the key and deploying, use **View Campaign IDs** in the admin to match IDs to campaign titles. Select only MMMBC donation campaigns and put their IDs in `ZEFFY_CAMPAIGN_IDS`, comma separated. You can also retrieve them with authenticated `GET https://api.zeffy.com/api/v1/campaigns`.
3. **One redacted payment response and its matching dashboard amount.** Confirm the exact payment fields and whether the donation amount is integer cents or dollars using the current [technical API reference](https://www.zeffy.com/api/docs) or authenticated `GET /api/v1/payments?limit=1&campaign=<ID>&type=online`. Keep the key and donor personal information out of any shared sample. Confirm that the mapped amount represents the gift to MMMBC, excluding optional contributions to Zeffy. Set `ZEFFY_AMOUNT_UNIT=minor` for cents or `major` for dollars only after this comparison. Also verify donor, date, status and refund field paths. The publicly readable help guide confirms the endpoint/filter/pagination contract but does not expose the full payment field schema; the defaults below are provisional. Until verified, the admin labels amounts as **API units** and excludes them from bookkeeping totals.

Optional field paths can be changed without code using a JSON string in `ZEFFY_PAYMENT_MAPPING`:

```json
{"amount":"amount","currency":"currency","created":"created","status":"status","donorName":"buyer.name","donorEmail":"buyer.email","refunds":"refunds"}
```

Paths must be dot-separated object fields. The payment ID is always `id`. A campaign, if returned, must be a string ID or object with `id` matching the requested campaign. `created` accepts Unix seconds or an ISO date string. Refunds accept an array or an object with a `data` array; only each refund's `id`, `amount`, `status` and `currency` are retained. Missing optional fields display as unavailable. Invalid IDs/status/list/pagination responses fail the sync visibly instead of silently losing records. Missing amounts never become zero.

### Enable on Cloudflare

From the repository root, targeting the configured Worker `mmmbc`:

```sh
npx wrangler secret put ZEFFY_API_KEY
npx wrangler d1 migrations apply mmdb --remote
```

Set durable nonsecret variables in `wrangler.jsonc` `vars`:

```json
"ZEFFY_CAMPAIGN_IDS": "<donation-campaign-api-id>",
"ZEFFY_AMOUNT_UNIT": "minor"
```

The `minor` value above is an example, not a confirmed account setting. Leave it unset until the account comparison is complete. Add `ZEFFY_PAYMENT_MAPPING` if the verified field paths differ. Then deploy through the existing release workflow. Existing five-minute cron triggers continue partial imports and retries. Complete reconciliations normally run hourly; Sync Now can start or continue one sooner. Set `ZEFFY_SYNC_ENABLED=false` to pause both scheduled and manual imports without deleting history.

The sync uses the documented Bearer API, `type=online`, campaign filters, `limit=100`, `has_more` and `next_cursor`/`starting_after`. Each invocation imports up to five pages; a persisted cursor resumes on later cron ticks. A fixed creation-time upper bound keeps newly arriving payments for the next scan. All statuses are fetched, so pending/failed payments and later refunds are refreshed. Upserts by payment ID prevent duplicate imports. Only a fully completed scan marks previously imported records as removed/missing from the provider; interrupted scans leave old records intact. A D1 lease prevents overlapping syncs, and 429 responses set a persisted cooldown instead of blocking the Worker. Manual and scheduled successful reconciliations are recorded in `workspace_audit` without donor details.

This implementation uses polling, so **no webhook signing secret, webhook setup, Zapier key, Stripe key, or additional Cloudflare API key is needed for syncing**. Your normal deployment credentials remain necessary to apply the migration/secret and deploy. If instant webhook delivery is added later, it will need a separate Zeffy webhook signing secret and signature verification; a webhook secret is not another API key.

### Verify after activation

- Run `node --test src/worker-zeffy-sync.test.mjs` and `node scripts/test_zeffy_browser.mjs` (Chromium installed, or `GIVING_CHROMIUM_PATH` set).
- Compare imported gifts, statuses and refund records against the church's Zeffy dashboard. Confirm cents/dollars and contribution exclusion before enabling amount formatting.
- Run Sync Now twice; verify one row per payment ID. Reload the admin to confirm D1 persistence.
- Confirm Finance Entry cannot sync and Website Manager cannot access the donation endpoint. Confirm manual totals are unchanged.
- Verify a complete reconciliation and subsequent scheduled run on the deployed Worker. Large accounts can require several five-minute ticks to finish a full scan.

Provider tests use fixtures. No live API access or payment processing was performed during implementation.

## Official references

- [Embed setup](https://support.zeffy.com/how-to-embed-your-zeffy-campaign-on-your-website-km0gv)
- [Modern embed example](https://support.zeffy.com/how-to-share-or-embed-a-translated-campaign-in-a-specific-language-9fs93)
- [Optional contributions](https://support.zeffy.com/what-is-the-contribution-made-towards-zeffy-why-was-i-charged-extra-s41ae)
- [API setup](https://support.zeffy.com/get-started-with-the-zeffy-api-yourg)
- [External payment-form limitation](https://support.zeffy.com/integrating-zeffy-as-a-payment-processor-into-an-external-form-6qu1y)
