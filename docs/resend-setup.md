# Resend setup

1. Add and verify `mmmbc.com` in the client Resend account.
2. Publish the SPF and DKIM records supplied by Resend in Cloudflare DNS.
3. Create a restricted production API key.
4. Store it as the Worker secret `RESEND_API_KEY`.
5. Set `RESEND_FROM_EMAIL` to a verified-domain mailbox such as `no-reply@mmmbc.com`.
6. Run only test-recipient sends before enabling scheduled campaigns.

The Worker uses `src/email-resend.js` for transactional and batch email. Browser code never receives the API key.
