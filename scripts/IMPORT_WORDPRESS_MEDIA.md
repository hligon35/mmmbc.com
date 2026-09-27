# Import WordPress Media into the Cloudflare Worker Gallery

You shared a WordPress admin URL (`/wp-admin/upload.php?...`). That page requires an authenticated browser session, so the reliable/automatable way to migrate media is:

- **List media via the WordPress REST API** (authenticated using an **Application Password**)
- **Download original / largest images**
- **Upload them into the MMMBC Worker** via `POST /api/gallery/upload` (which writes to **R2 + D1**)

This repo includes a script that does exactly that:
- `scripts/import_wp_media_to_worker_gallery.mjs`

## 1) Create a WordPress Application Password

In WordPress:
- Users → Profile (or Users → Your Profile)
- Application Passwords → Add New
- Copy the generated password (you’ll only see it once)

## 2) Create a Cloudflare Access Service Token (recommended)

If you protect `/api*` with Cloudflare Access (recommended), a CLI script needs a non-interactive way to authenticate.

In Cloudflare Zero Trust:
- Access → **Service Auth** → **Create Service Token**
- Add the token to the **Allow policy** for your Access app(s) that protect:
  - `/api*` on preview and/or prod

You’ll get:
- `Client ID`
- `Client Secret`

## 3) Run the importer

Preview example:

```powershell
$env:WP_BASE_URL="https://mmmbc.com"
$env:WP_USERNAME="YOUR_WP_USERNAME"
$env:WP_APP_PASSWORD="YOUR_WP_APPLICATION_PASSWORD"
$env:TARGET_BASE_URL="https://mmmbc-preview.hligon.workers.dev"

# If /api* is protected by Access:
$env:CF_ACCESS_CLIENT_ID="YOUR_ACCESS_SERVICE_TOKEN_CLIENT_ID"
$env:CF_ACCESS_CLIENT_SECRET="YOUR_ACCESS_SERVICE_TOKEN_CLIENT_SECRET"

# Optional tuning:
$env:ALBUM_MODE="year-month"   # year-month | year | wordpress-month
$env:MAX_ITEMS="0"             # 0 = import everything
$env:DRY_RUN="false"

node .\scripts\import_wp_media_to_worker_gallery.mjs
```

## Notes / expectations

- This imports **images only** (`mime_type` starts with `image/`).
- WordPress doesn’t inherently have “albums”; by default we group into albums by date (ex: `2025-10`). You can rename/reorganize later in the admin.
- The script tries to pick the **largest** available image URL (full/original when available).

If you want albums based on WordPress categories/taxonomies (like the `mlo-category` UI), we can extend the script once we confirm how that plugin stores categories (taxonomy name/REST fields).
