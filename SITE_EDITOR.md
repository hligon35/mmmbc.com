# Site Editor — Visual Website Editing System

This document describes the in-context visual editor used to edit the public
website's page content from the admin dashboard ("Edit Website Pages" tab).
It replaces the previous form-heavy, split-screen editor that read/wrote
`profiles.json`.

## 1. Architecture Overview

```
Admin dashboard (admin/public/index.html)
  └─ "Edit Website Pages" tab → launcher grid (one card per page)
       └─ window.SiteEditor.open(pageKey)   [admin/public/site-editor.js]
            └─ Full-screen overlay
                 ├─ Header: page tabs | centered "Edit {Page}" title | status + Save/Update/Exit
                 └─ <iframe> loads the REAL public page (e.g. /, /Pages/ministries.html)
                      with ?cms_edit=1, which activates the page's own
                      site-content-loader.js in "editor mode"

Public page (any of the 7 editable pages)
  └─ site-content-loader.js (root, shared by all pages)
       ├─ Normal visitors: fetches GET /api/site-content/:page (published only)
       │    and hydrates data-cms-field elements — no editor UI, no admin code loaded.
       └─ When ?cms_edit=1 and embedded in the admin's iframe: switches to
            "editor mode" — listens for postMessage from the parent, highlights
            data-cms-field elements on click, and reports clicks back to the parent.
```

The two sides communicate exclusively through a validated `postMessage`
protocol (see §4) — the admin overlay never reaches into the iframe's DOM
directly (different security context, and keeps the two sides decoupled).

## 2. Data Model (D1)

Table `site_page_content` (migration `migrations/0003_*.sql`), one row per
page, holding both a draft and a published copy plus optimistic-concurrency
version counters:

| column | notes |
|---|---|
| `page` | primary key, one of the 7 `PAGE_KEYS` |
| `draft_fields` | JSON blob of field values (working copy) |
| `draft_version` | integer, incremented on every successful draft save |
| `draft_updated_at` / `draft_updated_by` | audit |
| `published_fields` | JSON blob of field values (live copy) |
| `published_version` | integer, incremented on every publish |
| `published_updated_at` / `published_updated_by` | audit |

**Draft vs. Published vs. Exit**:
- **Save** → `PUT /api/admin/site-pages/:page/draft` — persists the working
  copy. Does **not** affect the live site.
- **Update** (publish) → `POST /api/admin/site-pages/:page/publish` — copies
  the current draft to `published_*` and bumps `published_version`. This is
  what visitors see. If there are unsaved edits, Update saves the draft first.
- **Exit** → if there are unsaved changes, a custom `<dialog>` (not
  `confirm()`/`alert()`) offers **Save Draft & Exit**, **Discard Changes**, or
  **Cancel**.
- **Autosave** — edits are saved as a draft 1.5s after the last change
  (debounced), plus a 2-minute safety-net interval check. Autosave never
  publishes.

## 3. API Reference (`src/worker-site-editor.js`, wired in `src/worker.js`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/site-content/:page` | public | Published fields only, used by the live site's loader. |
| `GET /api/admin/site-pages` | admin | List all pages with their current versions. |
| `GET /api/admin/site-pages/:page` | admin | Field schema + draft + published for one page. |
| `PUT /api/admin/site-pages/:page/draft` | admin | Body `{ baseVersion, fields }`. Saves draft. 409 `STALE_DRAFT` if `baseVersion` is behind the server's current draft version. |
| `POST /api/admin/site-pages/:page/publish` | admin | Body `{ baseVersion }`. Publishes the current draft. 409 `STALE_DRAFT` on conflict, 400 with `{ error, details }` on validation failure. |
| `POST /api/admin/site-pages/:page/media` | admin | Multipart `image` file field. Uploads to R2 (`GALLERY_BUCKET`, key prefix `site-content/{page}/...`), returns `{ url }` (served from `/cdn/gallery/*`). 8MB limit, JPEG/PNG/WEBP/GIF only. |

All admin routes are gated by `requireAdmin(request, env)` (Google Sign-In
checked against `ADMIN_ALLOW_EMAILS`).

**Optimistic concurrency**: every draft save and publish call must send the
`baseVersion` it last saw. If the server's version has moved on (e.g. edited
in another tab), it responds `409 { error, code: 'STALE_DRAFT', currentVersion }`.
The client (`reloadAfterConflict()` in `site-editor.js`) re-fetches the latest
draft/published state and updates the status indicator rather than silently
overwriting newer data.

## 4. Field Schema & Types (`src/site-editor-schema.js`)

`PAGE_SCHEMAS` defines, per page, the exact set of editable fields and their
types. Supported `FIELD_TYPES`:

`weekday`, `time`, `text`, `textarea`, `email`, `telephone`, `url`, `image`,
`boolean`, `select`, `rich_text`, `collection`.

Pages and their fields:

| page | fields |
|---|---|
| `home` | `hero.cta.text`, `hero.cta.url`, `worship.primary.day`, `worship.primary.time`, `worship.primary.label` |
| `ministries` | `page.intro` (rich_text), `profiles` (collection, up to 40 items: name/title/bio/image) |
| `leadership` | `profiles` (collection, up to 60 items, grouped by `staff`/`deacons`/`deaconesses`/`official_team`) |
| `church_history` | `hero_image` |
| `facility_rental` | `contact.email`, `contact.phone`, `availability` (select: open/limited/closed) |
| `live_praise` | `currently_live` (boolean), `stream.url` |
| `contact` | `contact.address`, `contact.phone`, `contact.email`, `contact.fax` |

All incoming field values are validated server-side in
`src/site-editor-validate.js` before being persisted: unknown keys are
rejected, text/rich_text is sanitized against a small tag allowlist
(`b/strong/i/em/br/p/a`, `href` protocol-checked), email/phone are
regex-validated, URLs are protocol-allowlisted, images must be
`{url, alt}` objects, and collection items require a stable `id` matching
`^[a-zA-Z0-9_-]{1,64}$` (and a valid `group` when the schema defines one).

### Adding a new editable field to an existing page
1. Add the field to the page's entry in `PAGE_SCHEMAS` (`src/site-editor-schema.js`).
2. If it needs custom validation beyond the built-in type rules, extend
   `src/site-editor-validate.js`.
3. Mark the corresponding element in the public HTML page with
   `data-cms-field="<field.key>"` and `data-cms-type="<type>"` (see the other
   `data-cms-*` attributes already on that page for the exact convention per
   type — e.g. images use `data-cms-field` on an `<img>` tag).
4. No changes are needed in `site-editor.js` unless you're introducing a
   brand-new **field type** (not just a new field of an existing type) — the
   popover control renderer (`renderFieldControl`) already handles all 11
   existing types generically.

### Adding a brand-new page
1. Add a new entry to `PAGE_SCHEMAS`/`PAGE_KEYS` in `src/site-editor-schema.js`.
2. Add the page to `sitePreviewPageMap` in `admin/public/admin.js` (`{label, url}`)
   — this single map drives both the launcher grid and the overlay's page tabs.
3. Mark up the new public HTML page with `data-cms-*` attributes and include
   `<script src="site-content-loader.js" defer data-cms-page="<key>"></script>`.
4. Add the page to `scripts/build_cf_site.ps1`'s explicit root-level `$files`
   list if it's a new top-level file (pages under `Pages/` are already mirrored
   via existing directory copy rules — check the script before assuming).

## 5. postMessage Protocol (`site-content-loader.js`)

All messages are validated for same-origin and `source: 'mmmbc-cms'` shape
before being trusted, on both sides.

```
iframe → parent:
  { source: 'mmmbc-cms', type: 'ready', page }
  { source: 'mmmbc-cms', type: 'fieldClick', page, field, fieldType, rect }
  { source: 'mmmbc-cms', type: 'navigateBlocked', page, href }   // ignored by the editor
  { source: 'mmmbc-cms', type: 'error', page, message }

parent → iframe:
  { source: 'mmmbc-cms', type: 'init', page, fields }     // initial draft values
  { source: 'mmmbc-cms', type: 'refresh', page, fields }  // after a conflict reload
  { source: 'mmmbc-cms', type: 'setField', page, field, value }  // live field edit
```

## 6. Known Limitation: Collection Fields Are Not Click-Editable

Collection fields (`ministries`/`leadership` profile lists) render their items
from a `<template data-cms-item-template>` clone on the public page. Cloned
items carry `data-cms-item-field` attributes, **not** `data-cms-field`, so the
loader's click-to-edit detection (which only looks for `data-cms-field`)
cannot target individual list items.

**Design decision**: rather than changing the public page's DOM/loader
contract (which affects both editor and normal-visitor hydration), the editor
overlay shows a **"Manage {list name}"** button (only when the current page's
schema has a `collection` field) that opens a dedicated list-management
popover — add/remove items, edit each item's fields (including its own image
upload), and pick a group for leadership items. This keeps the public
rendering logic simple while still making these fields editable.

## 7. Accessibility

- Overlay header tabs use the ARIA `tablist`/`tab` pattern with roving
  Left/Right/Home/End arrow-key navigation.
- The popover is a `role="dialog"` with Escape-to-close and focus restored to
  the previously focused element on close.
- On narrow viewports (`max-width: 640px`) the popover becomes a bottom sheet
  instead of a floating box, per the responsive requirement.
- The Exit flow uses a native `<dialog>` (keyboard/focus-trapped by the
  browser) rather than `confirm()`, so screen readers announce it properly.

## 8. Known Limitations / Follow-ups

- `live_praise.stream.url` (site-editor field) and the existing
  `livestream.json`-driven "currently live" auto-detection can both influence
  the live-praise page; editors should treat the site-editor's
  `currently_live` toggle as the manual override and be aware the automatic
  detection may race with it under some conditions.
- A few secondary paths in `site-editor.js` (the dirty-page-switch warning,
  some upload-error surfacing) still use native `window.confirm()`/`alert()`
  rather than the site's custom non-blocking status/hint pattern. This is
  intentional scope-limiting (only the Exit flow was required to use a custom
  dialog) but could be tightened further as a polish pass.

## 9. Manual Test Checklist

1. Open **Edit Website Pages** → click a page card → overlay opens full-screen
   with the real page rendered in the iframe.
2. Click an editable field on the page → popover opens near the field, with
   controls appropriate to its type.
3. Edit a text field → status indicator shows "Unsaved changes", then flips
   to "Saved" ~1.5s after you stop typing (autosave).
4. Click **Save** → status shows "Saved" immediately; reload the overlay
   (switch pages and back) → edited value persists as the draft.
5. Click **Update** → status shows "Published"; open the real public page in
   a normal (non-admin) browser tab → the new value is visible.
6. Edit a field, then click **Exit** → confirmation dialog appears with
   Save Draft & Exit / Discard / Cancel; verify each option's behavior.
7. Upload an image field → verify preview updates and the uploaded file is
   reachable at the returned `/cdn/gallery/...` URL.
8. For `ministries`/`leadership`: click **Manage {list}** → add/edit/remove
   an item, verify it round-trips through Save/Update correctly.
9. Open the same page in two admin tabs, edit + save in one, then try to
   save in the other → verify a 409 conflict reloads the latest state instead
   of overwriting it.
10. Resize the browser below 640px width while a popover is open → verify it
    becomes a bottom sheet.
