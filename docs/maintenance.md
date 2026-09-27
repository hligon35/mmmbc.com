# Monthly maintenance

The GitHub Actions maintenance workflow runs at 09:17 UTC on the first day of every month and can also be started manually. It checks out `master`, updates or creates the `monthlyUpdate` branch without force-resetting it, applies in-range dependency updates for the root app and admin app, and creates or updates one pull request back to `master`.

The root `monthlyReport.md` records the command, exit code, result, redacted evidence, skipped checks, findings, and recommendations for each run. The checks cover:

- root and admin tests, local D1 migrations, static build, integration tests, and production/preview Wrangler dry runs;
- root and admin dependency audits and outdated-package review;
- static HTML, local links, image alt text, titles, meta descriptions, `robots.txt`, and `sitemap.xml`;
- Cloudflare Worker, D1, and R2 binding configuration;
- tracked-file secret patterns, integration/idempotency source evidence, and the CodeQL workflow;
- optional Square sandbox/webhook/idempotency, browser, and Lighthouse checks when their CI command variables are configured.

The workflow uses only the built-in `GITHUB_TOKEN` and does not auto-merge, deploy to production, send email, charge payments, rotate secrets, or apply remote database migrations. Review `monthlyReport.md` and the complete pull-request diff before merging.

The workflow includes a privacy guard because this maintenance process is intended for a private repository. Set the repository visibility to **Private** in GitHub repository Settings before relying on the scheduled workflow; the guard intentionally fails and prevents branch/PR publishing while the repository is public.
