# CSS & Static Asset Architecture

This document describes the CSS structure for the MMMBC website after the
2026-07 CSS consolidation refactor. It covers ownership, load order, the
public/admin boundary, and the source → `cf_site` sync process.

## 1. File map (source of truth lives at repo root / `Pages/` / `admin/public/`)

| File | Owns | Loaded by |
|---|---|---|
| `public-base.css` | Global reset, top nav (incl. desktop "piano key" tabs), hero section, announcement ticker, `main`/`section` layout, worship & ministry times grid, footer, events section, modal shell. | Every public page (root `index.html` + all of `Pages/*.html`). Always first. |
| `public-components.css` | `.content-section` content pages, rental gallery, contact/rental forms & checklists, contact cards, YouTube/live-praise embeds, leadership & ministry profile cards, service blocks, and the shared 1024px/768px responsive rules that were already in `style.css`. | Every public page, immediately after `public-base.css`. |
| `schedule_app.css` | Schedule-app-specific rules only (`#schedule-display-area`, `.schedule-controls-modal`, `.event-item`, scrollbar theming). | `index.html`, `church_history.html`, `leadership.html`, `live_praise.html`, `ministries.html`, `photo_gallery.html`. |
| `public-responsive.css` | Shared mobile layout rules for public pages (page containers, hero, footer, leadership/ministry card stacking on mobile). Extracted from the tail of the old `schedule_app.css`, where it did not belong. | Same 6 pages as `schedule_app.css`, loaded immediately after it (preserves the original cascade position). |
| `home-layout-updates.css` | Homepage-only refinements (times grid split, footer link colors). | `index.html` only (also guarded-injected once by `bulletins_widget.js` if missing). |
| `theme.css` | Optional admin-managed color overrides (`:root` custom properties). Pulled in via `@import url('theme.css');` at the very end of `public-components.css`. Written by the admin Site Editor "theme" export feature. | Effectively global (via `@import`), generated/overwritten by `admin/server.js`. |
| `Pages/giving.css` | Give page card/grid styling only (`.giving*` scoped classes). | `Pages/giving.html`, `Pages/giving-success.html`. |
| `admin/public/admin.css` | Primary admin app stylesheet (layout, nav, tables, modals, forms, editors). | `admin/public/index.html`. |
| `admin/public/admin-structure-overrides.css` | Small, additive admin layout fixes (gallery grid/pager, page-context panels, finance chip strip). Injected as a `<link>` at runtime by the Cloudflare Worker (`src/worker-admin-api-wrapper.js`) and by `scripts/build_cf_site.ps1` for the static mirror — it is **not** linked directly in the admin source `index.html`. | Cloudflare-deployed admin + `cf_site` mirror. |
| `admin/public/finance_modern.css` | Standalone finance sub-app pages (`finances_*.html`). | Only the finance pages. |

## 2. Public vs. admin boundary

Public pages and the admin app never share a stylesheet. Public CSS files use
page-level classes (`.content-section`, `.leadership-profile`, `.giving*`,
etc.); admin CSS is scoped under admin-only IDs/classes (`#tab-*`,
`.financeHeaderSearch`, `.pageContext__*`, etc.). No changes were made to
merge or cross-load these — this refactor only reorganized rules *within*
each side.

## 3. Load order (must not change)

Public pages:
```
public-base.css
public-components.css
[schedule_app.css]        <- only on: index, church_history, leadership, live_praise, ministries, photo_gallery
[public-responsive.css]   <- only on the same 6 pages, right after schedule_app.css
[home-layout-updates.css] <- index.html only
[Pages/giving.css]        <- giving.html / giving-success.html only
```

Admin:
```
admin.css
(FINAL_GALLERY_STYLE inline <style>, Worker-injected)
admin-structure-overrides.css (Worker/build-script-injected <link>)
admin-structure-overrides.js  (Worker/build-script-injected <script>)
```

## 4. Source → `cf_site` sync

`cf_site/` is a generated deployment mirror for the Cloudflare Worker/Pages
asset bundle. It is rebuilt (not hand-edited) by:

```powershell
npm run build:cf
```

This runs `scripts/build_cf_site.ps1`, which:
1. Deletes and recreates `cf_site/` (deterministic, no stale files).
2. Copies the explicit static file list (HTML, CSS, JS, JSON data) and
   directories (`Pages`, `Icons`, `ConImg`, `bulletins`, `rental`).
3. Copies `admin/public/*` into `cf_site/admin/`, strips `login.html` /
   `login.js` / `login_legacy.html` (served by the Worker instead), and
   injects the `admin-structure-overrides.css`/`.js` tags into
   `cf_site/admin/index.html`.
4. Never copies `admin/server.js`, `admin/data/`, or secrets.

Run this after any source change to `styles/`, HTML, or admin UI files,
before deploying (`npm run deploy` already calls it automatically).

## 5. Adding a new component or page stylesheet

- Reusable rule used across multiple public pages → add to
  `public-components.css` (or `public-base.css` if it's global chrome).
- One page only → add a new `Pages/<page>.css` (see `giving.css` for the
  pattern) and link it after `public-components.css` on that page only.
- Admin-only rule → add to `admin.css`. Only use
  `admin-structure-overrides.css` for small additive fixes that must ship
  via the Worker-injection path (rare — prefer `admin.css`).

## 6. When `!important` is acceptable

Keep `!important` for: print styles (`.noPrint`/`.printOnly`), forced
`[hidden]` utility states, explicit state overrides that must win regardless
of source order (e.g. admin gallery grid overrides), and third-party/embed
content you don't control. Avoid it for ordinary component styling — fix
source order or specificity instead.

## 7. Known pre-existing quirks (left unmodified — do not "fix" silently)

- `public-components.css` contains a pre-existing malformed nested block
  under `.faq-image-collage` (a few small rules — `.contact-form--spaced`,
  `.footer-subscribe-form`, `.btn-contact--spaced`, `.muted` — are nested
  inside `.faq-image-collage { ... }`). This was present in the original
  `style.css`. Because some browsers apply native CSS nesting (implicit
  descendant combinator), "fixing" the indentation could change which
  elements these rules apply to. Left as-is to preserve current rendering;
  flagged here for future cleanup with proper visual regression testing.
- The trailing `@import url('theme.css');` in `public-components.css` is
  not the first rule in the file, so per the CSS spec it is ignored by
  browsers. This was already true in the original `style.css` (the
  `@import` was its last line). Preserved as-is; `theme.css` custom
  properties currently have no visual effect via this import path (the one
  consumer, `.bulletin-frame__open`, has a hard-coded fallback that matches
  the default theme value, so this has been invisible either way).
