# System analysis

MMMBC uses static public pages and a Cloudflare Worker application layer. The authoritative website source is the root, Pages, approved asset directories, and admin/public. The build generates cf_site for deployment.

Public/admin assets use Worker Static Assets; APIs and scheduled delivery use Workers; administrative records use D1 DB; anonymous submissions use D1 SITE_DB; media uses R2 GALLERY_BUCKET. Administrator identity uses Cloudflare Access JWT validation and D1 roles. Public forms use Turnstile and rate limits; email uses Resend; giving redirects to Zeffy by default.

Finance supports manual entries, donors, account lookup, envelopes, allocations and reconciliation. Scanning and QR issuance are retired. Historical finance tables are retained.

Newsletter consent is checked across both subscriber stores and durable suppression records. Campaign delivery state is recorded per recipient. Contact and rental email failures enter a separate durable retry queue; submission records remain available in the admin inbox.

Production still targets mmmbc.alphazonelabs.com. The owner will perform the final mmmbc.com domain transition. See launch-readiness-report.md for remaining account setup, migration, deployment, and live validation steps. General cleanup is paused.
