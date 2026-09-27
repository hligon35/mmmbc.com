# Launch readiness

## Implemented

- Cloudflare Worker and curated static-asset build
- Separate administrative and public-form D1 bindings
- R2 media storage
- Cloudflare Access JWT authentication and D1 RBAC
- Church content, communications, directory, finance, giving, envelopes, and reconciliation modules
- Turnstile/rate-limited public forms
- Resend transactional and batch transport
- Automated tests and monthly maintenance workflow

## Blocking production actions

- Authenticate Wrangler to the client Cloudflare account.
- Provision isolated preview D1 databases and R2 bucket, then replace preview placeholder IDs.
- Configure Cloudflare Access and set its team domain and audience.
- Verify `mmmbc.com` in Resend and store `RESEND_API_KEY`.
- Confirm all payment and Turnstile secrets.
- Authenticate GitHub administration, make the repository private, and confirm Cloudflare retains repository access.
- Run preview smoke tests before production deployment.

Production deployment is blocked until these checks pass.

## Verified locally

- Root Worker tests: passed
- Admin UI and legacy development-server guards: passed
- Production Worker dry run: passed
- Preview Worker dry run: passed
- Admin and site migrations against local D1: passed
- Root dependency audit: no known vulnerabilities
- Live local integration runner: blocked in the current managed runtime by Wrangler's `uv_interface_addresses` platform error; rerun in GitHub Actions or the authenticated development workstation

The legacy local Node admin server is not part of the production deployment. Its isolated development dependency tree still contains advisories and should not be exposed as a service.

## Remaining implementation gaps

- Public forms need browser-side Turnstile rendering and token submission before production fail-closed verification can work.
- Newsletter unsubscribe links, suppression across both subscriber stores, timezone handling, and durable per-recipient delivery records remain unfinished.
- Preview IDs are placeholders; dry runs do not verify remote resources or Access policies.
- XLSX export was removed during dependency cleanup; CSV remains. Restore XLSX with a supported library before claiming feature parity.
- The legacy account configuration was removed from this branch; reconcile the existing client instruction to preserve that deployment before merging.
- Monthly scheduling begins only once the workflow is merged into the default branch.
