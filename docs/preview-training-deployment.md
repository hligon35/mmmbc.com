# Preview training deployment

The preview branch is intended for review at https://mmmbc.hligon.workers.dev/admin.
Its Worker must be named mmmbc. Production moves to mmmbc-production at mmmbc.com.
Both preview database bindings use mmmbc-preview and its gallery uses R2 mmmbc-preview.
The alternate alphazonelabs.com custom domain is removed from production configuration.

## Complete the one time Cloudflare cutover first

Do not enable preview deployment while the mmmbc Worker still serves production custom domains.

1. Back up production mmdb and R2 mmmbc. Record the current mmmbc deployment for rollback.
2. Create Worker mmmbc-production in the same account. Copy the required production secrets directly in Cloudflare, including Resend, Turnstile, newsletter signing, and any enabled integrations. Keep the existing production DB and R2 bindings. Do not copy secrets into git.
3. Deploy the reviewed production configuration in wrangler.jsonc to mmmbc-production. Transfer the mmmbc.com custom domain from mmmbc to mmmbc-production in Cloudflare. A domain conflict may require detaching before attaching; perform this as a coordinated cutover, not an unattended preview deploy. Verify public pages, authenticated administration, forms and integrations before proceeding.
4. Remove mmmbc.alphazonelabs.com and www.mmmbc.alphazonelabs.com from Worker custom domains and any separate routes/redirects that still attach them. Only the non-www entry existed in the checked-in config; the dashboard can have additional entries. Preserve unrelated DNS and mail records.
5. Disable or reconfigure the old Workers Builds connection that deploys master to Worker mmmbc. Production builds must target mmmbc-production from master. Deploy command: npm run deploy:production. Never connect both automatic build systems to the same Worker.
6. Confirm D1 mmmbc-preview and R2 mmmbc-preview exist in the configured account. Find the preview database UUID in Cloudflare. The deployment script rejects the production UUID and does not create or guess a database ID.
7. Configure Access on the training admin and protected APIs. Set MMMBC_PREVIEW_ACCESS_AUD to the training application's audience. Keep the production application on mmmbc.com. Confirm the desired sign-in identity provider and allowed users.
8. Provide a training Turnstile widget/site key and secret for the preview hostname. Public forms fail closed without verification. Set TURNSTILE_SITE_KEY in the preview configuration generator if the production widget does not include this hostname, and set the mmmbc Worker TURNSTILE_SECRET_KEY secret. The preview Worker retains any previous mmmbc secrets; application guards block outbound email, scheduled processing and payments even if credentials remain. Remove unnecessary production secrets after the cutover. Preserve authentication and set a separate training newsletter signing secret if testing signed preference links.
9. Activate appropriate approved users in the preview database. Migrations seed pending users; applying migrations alone does not make a usable training administrator. Follow the approved roster activation process, then verify each user's role. Use fictional records rather than copying member or payment data.

## Connect GitHub preview deployment

The workflow .github/workflows/preview-deployment.yml deploys pushes to preview and supports manual dispatch on that branch.
It stays disabled until repository variable MMMBC_PREVIEW_READY is true, so creating the branch cannot overwrite the old production Worker.

Set these GitHub repository settings after successful cutover:

- Secret CLOUDFLARE_API_TOKEN: token permitted to deploy the preview Worker, read/apply its D1 migrations and upload its static assets. Restrict account/resource access where supported.
- Variable MMMBC_PREVIEW_DATABASE_ID: actual UUID for D1 mmmbc-preview.
- Variable MMMBC_PREVIEW_ACCESS_AUD: configured Access audience for training.
- Variable MMMBC_PREVIEW_READY: true, only after mmmbc no longer owns any production custom domain and the conflicting old build connection is removed.

Use the GitHub workflow as the preview build connection. Do not add a second Workers Builds connection for preview. Each deploy serializes with other preview deploys, builds and verifies admin assets, applies only preview migrations and deploys the mmmbc Worker with no custom domains or cron triggers.

For a local preview deployment from branch preview, set MMMBC_PREVIEW_DATABASE_ID and MMMBC_PREVIEW_ACCESS_AUD, and set MMMBC_PREVIEW_CUTOVER_CONFIRMED=yes only after the cutover. Run npm run deploy:preview. The generated config is ignored by git. Never deploy preview with plain npm run deploy, which targets the production configuration.

## Review and release

Commit work to preview, wait for its deployment, and review the training URL with each required role. Outbound email and payment actions are blocked in training, and Zeffy sync and scheduled jobs are disabled. The public training response has no-index headers. Preview requires real Access authentication and verified public forms.

After acceptance, open a PR from preview to master. Merge reviewed changes to release production through its configured production build. A preview push never deploys mmmbc-production. Revert a faulty preview commit normally; restore production from its recorded deployment only through the coordinated rollback plan.

Repository configuration does not itself transfer Cloudflare domains, set credentials, activate users, or enable the GitHub repository variable. Confirm these actions in Cloudflare and GitHub before calling training live.
