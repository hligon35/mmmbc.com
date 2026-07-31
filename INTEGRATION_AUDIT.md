# MMMBC Public/Admin Integration Audit

Generated for Cloudflare Worker stack (`src/worker-admin-api-wrapper.js` -> `src/worker-auth-wrapper.js` -> `src/worker.js`) with static assets from `cf_site/`.

## Connection Inventory Matrix (19 feature domains)

| # | Feature domain | Public read/write path | Admin read/write path | Auth boundary | Storage of truth | Build/Deploy path | Status |
|---|---|---|---|---|---|---|---|
| 1 | Announcements | `GET /api/public/announcements` (fallback `announcements.json`) | `GET/POST /api/announcements`, `PUT/DELETE /api/announcements/:id` | Public read, admin write | D1 `announcements` | Source JS in root + worker route; `build:cf` mirrors public assets | Connected |
| 2 | Events schedule | `GET /api/public/events` (fallback `schedule.json`) | `GET/POST /api/events`, `PUT/DELETE /api/events/:id` | Public read, admin write | D1 `events` | `schedule_app.js` + worker routes | Connected |
| 3 | Bulletins | `GET /api/public/bulletins` (fallback `bulletins.json`) | `GET /api/bulletins`, `PUT/DELETE /api/bulletins/:id`, upload route | Public read, admin write | D1 `bulletins`, R2 object keys | `bulletins_widget.js` + worker routes | Connected |
| 4 | Photo gallery feed | `GET /api/public/gallery` (fallback `/public/gallery.json`) | `GET /api/gallery`, plus CRUD/reorder/upload and R2 sync/tree endpoints | Public read, admin write | D1 `gallery_items`, D1 `gallery_preferences`, R2 bucket | `Pages/photo_gallery.js` + worker routes | Connected |
| 5 | YouTube live/recent feed | `GET /api/public/youtube` (fallback `/public/youtube.json`) | Admin controls separate (currently `/api/livestream` in UI, not worker-backed) | Public read | Live fetched from YouTube feed | `Pages/live_praise.html` + worker live-feed route | Connected (public) |
| 6 | Livestream profile payload | `GET /api/public/livestream` | (No production worker write route yet) | Public read | Static asset fallback `livestream.json` | Public page scripts | Read-only bridge |
| 7 | Public site settings | `GET /api/public/site-settings` (fallback static `site-settings.json`) | Admin settings UI currently expects `/api/settings` (not worker-backed) | Public read | Static asset fallback `site-settings.json` | `script.js` | Read-only bridge |
| 8 | Contact form submission | `POST /api/public/contact-message` | N/A | Public write (validated) | Email delivery via `SUPPORT_EMAIL` binding | `Pages/contact.html` + `script.js` | Connected |
| 9 | Newsletter signup (public) | `POST /api/public/newsletter/subscribe` | `GET/PUT /api/subscribers` | Public write + admin read/write | D1 `subscribers` | `script.js` + worker communications routes | Connected |
| 10 | Facility rental request (member) | `POST /api/public/facility-rental-request` (mailto fallback) | N/A | Public write | Email delivery via `SUPPORT_EMAIL` binding | `facility_rental_form.js` | Connected |
| 11 | Facility rental request (non-member) | `POST /api/public/facility-rental-request` (mailto fallback) | N/A | Public write | Email delivery via `SUPPORT_EMAIL` binding | `facility_rental_nonmembers_form.js` | Connected |
| 12 | Giving checkout | `POST /api/giving/checkout` from public giving page | Admin reporting paths separate | Public write | Stripe + D1 giving tables | `Pages/giving.js`, `src/worker-giving.js` | Connected |
| 13 | Public page CMS hydration | `GET /api/site-content/:page` | Admin editor APIs under `/api/admin/site-pages*` | Public read / admin write | D1 `site_page_content` | `site-content-loader.js`, `src/worker-site-editor.js` | Connected |
| 14 | Directory contacts | N/A | `/api/directory/contacts*` + duplicate-check/archive aliases | Admin-only | D1 directory tables | `admin/public/admin-directory.js`, `src/worker-directory.js` | Connected |
| 15 | Directory subscribers/lists/groups | N/A | `/api/directory/subscribers*`, `/api/directory/lists*`, `/api/directory/groups*` | Admin-only | D1 directory tables | admin directory module + worker routes | Connected |
| 16 | Admin users/invites | N/A | `/api/users`, `/api/users/invite`, `/api/users/:id` | Admin-only | D1 `admin_invites` + static allowlist var | admin UI + `worker-communications.js` | Connected |
| 17 | Newsletter campaign records/send | N/A | `/api/newsletter/records`, `/api/newsletter/send`, `/api/newsletter/test` | Admin-only | D1 `newsletter_records`, D1 `subscribers`, SendGrid secret | admin UI + worker communications routes | Connected |
| 18 | Admin support messaging | N/A | `POST /api/support/message` | Admin-only | Email delivery via `SUPPORT_EMAIL` binding | admin UI + worker support route | Connected |
| 19 | Integration diagnostics and API boundary | `GET /api/public/*`, unknown API -> JSON 404 | `GET /api/admin/integration-health` | Split public/admin | Runtime route checks + lightweight DB/asset diagnostics | worker route + script `scripts/verify_integrations.mjs` | Connected |

## Key architecture notes

- Public pages now prefer normalized `GET /api/public/*` data feeds, with static JSON fallbacks retained for resilience during rollout.
- Public-facing submissions that previously only opened email clients now post to Worker APIs first, with `mailto:` fallback if the API path is unavailable.
- Unknown `/api/*` routes return JSON 404s and no longer fall through to static asset responses.
- Admin integration diagnostics are available at `GET /api/admin/integration-health` (admin auth required).

## Remaining known gaps

- Admin UI calls to `/api/livestream`, `/api/settings`, `/api/theme/preview*`, and `/api/export` are still not implemented in production Worker routes.
- Wrapper interception of `/api/finances` and `/api/profiles` remains a compatibility bridge and not full source-of-truth parity with the local `admin/server.js` implementation.
- Full role/permission model parity between local `admin/server.js` and production Worker is still incomplete in finance and several advanced admin modules.
