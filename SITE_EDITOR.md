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
| `POST /api/admin/site-pages/:page/restore-previous` | admin | No body. One-level "undo publish": swaps `published_fields` back to `previous_published_fields` (the version published immediately before the current one). Does not touch the draft. Returns 400 if there is no earlier version to restore. |

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
`boolean`, `select`, `rich_text`, `number`, `collection`.

Pages and their fields (abbreviated — see `PAGE_SCHEMAS` for the exact set):

| page | fields |
|---|---|
| `home` | `hero.cta.text`, `hero.cta.url`, `sections.worship.heading`, `sections.ministries.heading`, `worship.schedule` (collection, up to 30 items: day/time/title/details/sortOrder), `ministries.weeklySchedule` (collection, same item shape) |
| `ministries` | `page.title`, `page.intro` (rich_text), `profiles` (collection, up to 40 items: name/title/bio/image) |
| `leadership` | `page.title`, `sections.staff.heading`, `sections.deacons.heading`, `sections.deacons.intro` (rich_text), `sections.deaconesses.heading`, `sections.official_team.heading`, `profiles` (collection, up to 60 items, grouped by `staff`/`deacons`/`deaconesses`/`official_team`) |
| `church_history` | `page.title`, `hero_image` — the ~80-paragraph narrative body is intentionally **not** editable here; see §8. |
| `facility_rental` | `page.title`, `sections.rental.heading1`, `sections.rental.description` (rich_text), `sections.rental.heading2`, `contact.email`, `contact.phone`, `availability` (select: open/limited/closed) |
| `live_praise` | `page.title`, `page.description` (rich_text), `currently_live` (boolean), `stream.url` |
| `contact` | `page.title`, `page.intro` (rich_text), `sections.form.intro` (rich_text), `contact.address`, `contact.phone`, `contact.email`, `contact.fax` |

Each `worship.schedule` / `ministries.weeklySchedule` item has the shared
`scheduleItemFields` shape: `day` (weekday, required), `time` (time,
required), `title` (text, required, max 120 chars), `details` (textarea, max
400 chars), `sortOrder` (number, 0–999, used to order same-day/same-time
items deterministically).

All incoming field values are validated server-side in
`src/site-editor-validate.js` before being persisted: unknown keys are
rejected, text/rich_text is sanitized against a small tag allowlist
(`b/strong/i/em/br/p/a`, `href` protocol-checked), email/phone are
regex-validated, URLs are protocol-allowlisted, images must be
`{url, alt}` objects, numbers are clamped to `schema.min`/`schema.max`, and
collection items require a stable `id` matching `^[a-zA-Z0-9_-]{1,64}$` (and a
valid `group` when the schema defines one).

**Idempotent seeding + `mergeWithSeed`**: `ensurePageRow()` only INSERTs a D1
row if one doesn't already exist for that page — it never UPDATEs an existing
row. This protects live admin edits from being clobbered by a redeploy, but it
also means a schema field added *after* a page's row already exists would
otherwise read back as `undefined`. Both read paths (`rowToPageState` for the
admin API, and `handlePublicSiteContentGet` for the public API) run every
stored `fields` object through `mergeWithSeed(page, storedFields)`, which
layers `INITIAL_PUBLISHED_CONTENT[page]` defaults **underneath** whatever is
already stored — stored values always win, and only genuinely-missing keys
fall back to the seed default. Whenever you add a new field to `PAGE_SCHEMAS`,
also add its default value to the matching page's entry in
`INITIAL_PUBLISHED_CONTENT` so existing rows pick it up automatically.

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
   popover control renderer (`renderFieldControl`) already handles all 12
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
  { source: 'mmmbc-cms', type: 'collectionItemClick', page, collection, itemId, field, fieldType, rect }
  { source: 'mmmbc-cms', type: 'collectionItemActions', page, collection, itemId, rect }  // the "⋮" handle
  { source: 'mmmbc-cms', type: 'navigateBlocked', page, href }   // ignored by the editor
  { source: 'mmmbc-cms', type: 'error', page, message }

parent → iframe:
  { source: 'mmmbc-cms', type: 'init', page, fields }     // initial draft values
  { source: 'mmmbc-cms', type: 'refresh', page, fields }  // after a conflict reload
  { source: 'mmmbc-cms', type: 'setField', page, field, value }  // live field edit
  { source: 'mmmbc-cms', type: 'setCollectionItemField', page, collection, itemId, field, value }
  { source: 'mmmbc-cms', type: 'setSelection', page, field } | { ..., collection, itemId, field }
  { source: 'mmmbc-cms', type: 'clearSelection', page }
```

`setSelection`/`clearSelection` drive a visible `.cms-editable--selected`
outline on whichever element the currently-open popover is editing — this is
purely a visual aid injected by `injectEditorStyles()` in editor mode only,
never loaded for normal site visitors.

## 6. Collection Fields: Two Editing Paths

Collection fields render their items differently depending on the schema:

- **Schedule collections** (`home`'s `worship.schedule` /
  `ministries.weeklySchedule`): rendered by a dedicated
  `renderScheduleCollection()` in `site-content-loader.js` that groups items
  by day/time to reproduce the exact existing worship-times visual layout
  (shared day labels, grouped time slots, etc. — see the CSS classes in
  `public-components.css` around `.sunday-schedule`/`.thursday-schedule`).
  Every rendered subfield (`day`, `time`, `title`, `details`) carries
  `data-cms-item-field` + `data-cms-item-id`, so it's **directly
  click-editable** on the page itself — clicking a title opens a popover for
  just that subfield. Each item also gets a small "⋮" handle
  (`addItemActionsHandle()`, editor-mode only) that opens a whole-item actions
  popover: edit every subfield at once, **Add item below**, **Move up/down**,
  or **Remove**.
  - *Shared label caveat*: when two activities share one visual day/time
    label (e.g. two Sunday services under one "Sunday" heading), that shared
    label's `data-cms-item-id` always points at the **first** item in the
    visual group — clicking it edits that one item's `day`/`time`. Every
    other co-located activity remains individually editable via its own
    title/details fields and its own "⋮" actions popover.
- **Profile collections** (`ministries`/`leadership`'s `profiles`): still
  rendered from a `<template data-cms-item-template>` clone with
  `data-cms-item-field` attributes, and are also now directly click-editable
  per item/subfield via the same `collectionItemClick`/`collectionItemActions`
  mechanism. In addition, the overlay's **"Manage {list name}"** button (one
  per collection field on the page — Home now has two) opens a full
  list-management popover for bulk add/remove/reorder and group assignment,
  as an alternate, higher-throughput entry point.

## 7. Accessibility

- Overlay header tabs use the ARIA `tablist`/`tab` pattern with roving
  Left/Right/Home/End arrow-key navigation.
- The popover is a `role="dialog"` with Escape-to-close and focus restored to
  the previously focused element on close.
- On narrow viewports (`max-width: 640px`) the popover becomes a bottom sheet
  instead of a floating box, per the responsive requirement.
- The Exit flow, page-switch warning, publish review, and every
  confirmation/error message use native `<dialog>` elements (keyboard/focus-
  trapped by the browser) rather than `confirm()`/`alert()`, so screen
  readers announce them properly and they don't block the whole tab.
- Every click-editable element (plain fields, collection item subfields, and
  item action handles) is keyboard-reachable via `tabindex="0"` with a
  `role="button"`/`aria-label`, and activates on Enter or Space, not just
  mouse click.

## 8. Known Limitations / Follow-ups

- **`church_history`'s narrative body is not editable.** The page has ~80
  paragraphs of historical text interleaved with two images (`img` and a
  `figure`/`figcaption` block) that use tags outside the rich_text
  sanitizer's allowlist. Converting it was deliberately deferred: the risk of
  silently corrupting meaningful church history text via a manual
  transcription/DOM-splitting error was judged worse than leaving it
  non-editable for now. Only `page.title` and `hero_image` are editable on
  this page.
- **No Simple/Advanced permission modes.** The codebase has no existing
  role/permission model to build on; every admin with dashboard access sees
  the full editor with no field-level restrictions. Adding one would require
  a new authorization layer beyond this feature's scope.
- **Undo is single-slot, not a full history stack.** The "Undo" button in the
  overlay header reverts only the single most recent field or collection-item
  change, and is cleared on page switch. There is no multi-step undo/redo.
- **"Restore previous version" is single-level, not full revision history.**
  `POST /api/admin/site-pages/:page/restore-previous` can only swap back to
  the one published version immediately prior to the current one (stored in
  `previous_published_*`). There is no browsable list of every past publish.
- **Conflict handling reloads rather than merges.** On a 409 `STALE_DRAFT`,
  `reloadAfterConflict()` discards the local in-memory draft and re-fetches
  the server's latest state; it does not attempt a field-level merge. This is
  safe (no silent overwrite of someone else's newer save) but can lose the
  local editor's very recent unsaved keystrokes, which is why autosave is
  debounced at only 1.5s.
- `live_praise.stream.url` (site-editor field) and the existing
  `livestream.json`-driven "currently live" auto-detection can both influence
  the live-praise page; editors should treat the site-editor's
  `currently_live` toggle as the manual override and be aware the automatic
  detection may race with it under some conditions.

## 9. Manual Test Checklist

1. Open **Edit Website Pages** → click a page card → overlay opens full-screen
   with the real page rendered in the iframe.
2. Click an editable field on the page → popover opens near the field, with
   controls appropriate to its type, and the field gets a visible selected
   outline on the page behind the popover.
3. Edit a text field → status indicator shows "Unsaved changes", then flips
   to "Saved" ~1.5s after you stop typing (autosave). Click **Undo** →
   verify the change reverts and the button disables again.
4. Click **Save** → status shows "Saved" immediately; reload the overlay
   (switch pages and back) → edited value persists as the draft.
5. Click **Update** → a review dialog lists what changed; confirm → status
   shows "Published"; open the real public page in a normal (non-admin)
   browser tab → the new value is visible.
6. Click **Restore previous version** → confirm → verify the live public
   page reverts to the prior published content (draft is untouched).
7. Edit a field, then click **Exit** → confirmation dialog appears with
   Save Draft & Exit / Discard / Cancel; verify each option's behavior.
8. Upload an image field → verify preview updates and the uploaded file is
   reachable at the returned `/cdn/gallery/...` URL.
9. On the **Home** page: click directly on a worship-times activity's title,
   time, or details on the rendered page → verify a popover opens scoped to
   just that item/field. Click the "⋮" handle on an activity → verify Edit /
   Add below / Move up / Move down / Remove all work and the page preview
   updates live.
10. For `ministries`/`leadership`: click **Manage {list}** → add/edit/remove
    an item, verify it round-trips through Save/Update correctly.
11. Open the same page in two admin tabs, edit + save in one, then try to
    save in the other → verify a 409 conflict reloads the latest state instead
    of overwriting it.
12. Resize the browser below 640px width while a popover is open → verify it
    becomes a bottom sheet.
13. Tab through a page with only the keyboard (no mouse) → verify every
    editable field and item action is reachable via Tab and activates with
    Enter/Space.
