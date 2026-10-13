# WordPress image migration without new exact duplicates

Deploy the updated Worker from master before running `scripts/import_wp_media_to_worker_gallery.mjs`. The importer uses the authenticated `/api/gallery/import` endpoint and existing R2 + D1 gallery architecture. No new migration or dependency is required; existing gallery schema/migrations must be present.

## What it does

- Lists managed JPG, PNG, GIF, and WebP objects under `gallery/` and `site/`, including hidden images and unindexed R2 objects.
- Computes SHA-256 from the image bytes, rather than trusting filenames or R2 ETags as content hashes.
- Reuses matching objects and their gallery records, registers unindexed matches, and preserves existing hidden states.
- Uses deterministic content-hash keys and IDs for new images, so retries do not create fresh random copies.
- Saves an atomic local manifest with old URLs, source hash, canonical R2 key, gallery ID, new URL, completion status, and errors. Hash-cache entries are reused only when the object's ETag and size still match.
- Rechecks the live inventory on resume. A local manifest is not treated as proof an object still exists.
- Defaults to DRY_RUN=true. A dry run reads/hashes files and writes the local report but does not upload or change D1.
- Does not delete existing duplicate objects, rewrite website/CMS content automatically, or unhide private photos. Review the resulting URL map before updating references.

This prevents exact-byte duplicates. Different edits, crops, formats, and compression remain distinct. WordPress API mode uses original-image metadata and maps its generated-size URLs to that canonical original. A plain uploads-folder backup has no attachment metadata, so it keeps byte-distinct resized files instead of guessing which files are safe to omit. Unsupported formats and originals over 10 MB are reported as failures for separate review; they are not silently discarded or compressed.

## Authentication

Use a current administrator session with photo-management permission. Set its Cloudflare Access authorization token locally as CF_ACCESS_JWT; the script sends it as the Access cookie/assertion and never stores it in the manifest. Do not paste it into source code, commit it, or share it in chat.

A Cloudflare Access service token alone is insufficient for this app's email-identity/D1-role authentication. This replaces the former service-token instructions. Keep production authentication enabled. If the session expires, renew it locally and rerun against the same manifest.

## Source options

The public mmmbc.com address now serves the Worker. It is not the old WordPress origin.

1. API source: obtain the old host's still-working WordPress URL, username, and WordPress Application Password. All media pages are fetched, with original-image metadata used when available.
2. Backup source: extract the old `wp-content/uploads` folder and point WP_UPLOADS_DIR at it. WordPress credentials are not required in backup mode.

Preserve the original backup until every import and page reference is verified. Use a protected source directory, not the public repo, for the backup.

## PowerShell dry run from the repo root

Set authentication locally, then choose one source:

```powershell
$env:TARGET_BASE_URL="https://mmmbc.com"
$env:CF_ACCESS_JWT="YOUR_CURRENT_ACCESS_TOKEN"

# Option A: extracted uploads backup
$env:WP_UPLOADS_DIR="C:\\Migration\\wordpress-uploads"
$env:WP_ORIGINAL_URL="https://mmmbc.com"

# Option B: old WordPress host; omit/unset WP_UPLOADS_DIR when using this option
# $env:WP_BASE_URL="https://OLD_WORDPRESS_HOST/"
# $env:WP_USERNAME="YOUR_WORDPRESS_USERNAME"
# $env:WP_APP_PASSWORD="YOUR_APPLICATION_PASSWORD"

$env:DRY_RUN="true"
$env:MIGRATION_MANIFEST=".migration/wordpress-media.json"
node .\\scripts\\import_wp_media_to_worker_gallery.mjs
```

The manifest and its lock file are ignored by Git. Back up this private manifest separately for resumability. If a process is forcibly killed, remove its .lock file only after confirming no migration process is running.

Review planned/reused/hidden/failed counts and sourceCount. MAX_ITEMS can limit a trial run and the report marks it limited; omit it or set it to 0 for the full migration. Source failures return a nonzero exit code, while successful entries remain resumable. Inventory read failures abort before any upload to avoid an incomplete duplicate comparison.

## Import after reviewing the dry run

```powershell
$env:DRY_RUN="false"
node .\\scripts\\import_wp_media_to_worker_gallery.mjs
```

Rerun the same command after interruptions or failed source downloads. Do not change the target account/bucket midway through a migration.

## Verify and reconnect

Inspect the manifest's `sources` entries. Confirm each complete image exists, opens at its new URL when its visibility permits, and has a D1 gallery record. Hidden matches deliberately remain hidden. Review and apply the oldUrls-to-url mapping to static pages/profile data and published CMS records after the actual destinations have been verified. This is a separate controlled step so a dry run or partial import cannot replace working website references.

No real WordPress source, uploads backup, or Cloudflare credentials were available during implementation. Automated tests used temporary local fixtures and mocked authenticated Worker/R2 storage; they are not a live migration.
