# Option B: Cloudflare-only backend (Worker + R2 + D1)

This repo now includes an **Option B scaffold** that runs the site and gallery API on Cloudflare Workers.

## What is already wired

- Worker entrypoint: `src/worker.js`
- Static assets source directory: `cf_site/`
- Build script that (re)builds `cf_site/` safely: `scripts/build_cf_site.ps1`
- D1 schema for gallery metadata: `cf/schema.sql`
- Wrangler config (prod + preview): `wrangler.jsonc`

## Where the gallery images in `gallery/mmmbc.com` came from

That folder is a **download/snapshot of the old live site** page:
- `gallery/mmmbc.com/20260116_221850/text/index.json` references `https://mmmbc.com/photo-gallery/`
- The images are stored in `gallery/mmmbc.com/.../images/` as `*-400x284.jpg`, which looks like a CMS-generated thumbnail size.

Those files were **not produced** by the current admin uploader; they look like they were fetched from the live website by a scraping/downloader tool.

## Import from WordPress (best quality)

The WordPress admin media library URL (`/wp-admin/upload.php`) requires an authenticated browser session, so the efficient, high-quality migration approach is:

- Use WordPress REST API (authenticated using a WordPress **Application Password**) to list all media items
- Download the **largest/original** image for each item
- Upload into the Worker via `POST /api/gallery/upload` (writes to **R2 + D1**)

Scripts + instructions:
- `scripts/import_wp_media_to_worker_gallery.mjs`
- `scripts/IMPORT_WORDPRESS_MEDIA.md`

## Provision Cloudflare resources

### 1) Create D1 databases

Prod:
- `wrangler d1 create mmmbc`

Preview:
- `wrangler d1 create mmmbc-preview`

Then copy the returned `database_id` values into `wrangler.jsonc`:
- `d1_databases[0].database_id`
- `env.preview.d1_databases[0].database_id`

### 2) Apply the schema

Prod:
- `wrangler d1 execute mmmbc --file=cf/schema.sql`

Preview:
- `wrangler d1 execute mmmbc-preview --file=cf/schema.sql --env preview`

### 3) Create R2 buckets

Create these buckets in Cloudflare dashboard (or via wrangler):
- `mmmbc-gallery`
- `mmmbc-gallery-preview`

## Admin auth (Cloudflare-native)

This Worker expects you to protect `/admin/*` and `/api/*` with **Cloudflare Access**.

- Configure an Access policy that allows your admin emails.
- Optionally set `ADMIN_ALLOW_EMAILS` in `wrangler.jsonc` (comma-separated) to add a second layer of allow-listing.

Local dev only:
- Set `DEV_BYPASS_AUTH=true` to skip Access checks.

### Local admin bucket browsing (Node server → Worker)

When using the local Node admin (`admin/server.js`) with the **R2 Bucket Browser**, the Node server proxies requests to the Worker.
Because the Node server is not running behind Cloudflare Access, it cannot rely on Access cookies.

Supported approach:

- Set Worker secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (a Cloudflare Access **Service Token**).
- Set the same values in the local Node admin `.env` so it can send `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.

Commands:

- `wrangler secret put CF_ACCESS_CLIENT_ID`
- `wrangler secret put CF_ACCESS_CLIENT_SECRET`

Then deploy the Worker:

- `wrangler deploy`

## Build + deploy

### 1) Build the assets folder

Run:
- `powershell -ExecutionPolicy Bypass -File .\scripts\build_cf_site.ps1`

### 2) Deploy

Prod:
- `wrangler deploy`

Preview:
- `wrangler deploy --env preview`

## Current scope

Right now Option B includes:
- Serving the static site and admin UI from `cf_site/`
- Gallery endpoints in the Worker:
  - `GET /api/gallery`
  - `POST /api/gallery/upload`
  - `PUT /api/gallery/order`
  - `DELETE /api/gallery/:id`
  - `GET /cdn/gallery/<key>` (R2 objects with long cache headers)

The rest of the admin APIs (events, bulletins, documents, finances, full login flow) can be migrated next.
