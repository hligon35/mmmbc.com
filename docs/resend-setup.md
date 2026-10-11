# Resend setup

1. Add and verify `mmmbc.com` in the client Resend account.
2. Publish the SPF and DKIM records supplied by Resend in Cloudflare DNS.
3. Create a restricted production API key.
4. Store it as the Worker secret `RESEND_API_KEY`.
5. Set `RESEND_FROM_EMAIL` to a verified-domain mailbox such as `no-reply@mmmbc.com`.
6. Run only test-recipient sends before enabling scheduled campaigns.

The Worker uses `src/email-resend.js` for transactional and batch email. Browser code never receives the API key.


## Branded website confirmations

The production Worker sends church-branded HTML plus a plain-text version after saving each public website submission:

- Contact: personalized receipt and reference number, without echoing potentially sensitive message content.
- Member and non-member facility rentals: personalized receipt with requested event, date, times, facilities, and reference. The email explicitly says this is not a reservation approval.
- Newsletter: a welcome after a new signup is stored; repeated active signups and preview demo submissions do not send. A signed unsubscribe link is included when NEWSLETTER_UNSUBSCRIBE_SECRET is configured.

All confirmations share the public church logo, colors, address, phone, and website from `src/website-email-templates.js`. `PUBLIC_SITE_URL` supplies logo and website URLs; `RESEND_FROM_NAME` supplies the church display name. Replies use `WEBSITE_REPLY_TO_EMAIL` (currently the church's published inbox `mtmoriahmbc1201@gmail.com`), with `RESEND_REPLY_TO_EMAIL` as a fallback. Keep the verified Resend sender at `no-reply@mmmbc.com`; staff/developer notification destinations do not become visitor reply-to addresses.

Apply the existing `0015_site_email_delivery_jobs.sql` migration through the normal migration command before deployment. Failed confirmations and staff notifications enter separate durable retry jobs with stable Resend idempotency keys. The five-minute cron retries due jobs up to five attempts. Contact/rental confirmations show `retrying`, `sent`, or `failed` in their existing auto-reply fields. Newsletter retry state is stored in `email_delivery_jobs`; a queued welcome is cancelled if the subscriber has opted out. If the queue table is missing, the saved submission is retained and delivery is reported as failed instead of falsely promising a retry.

A Resend success means the provider accepted the email, not proof it reached the inbox. After merging/deploying, use an authorized test recipient for a contact, both rental forms, and a newsletter signup, then inspect Resend delivery logs and reply-to behavior. This change does not send live test emails or alter scheduled newsletter campaigns. The public logo URL must be reachable without Access.
