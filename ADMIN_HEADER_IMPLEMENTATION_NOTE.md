# Admin Header Implementation Note (Pre-Change)

## Current Header Markup (admin/public/index.html)
- Authenticated header root: `#adminHeader.header`.
- Current children:
  - `.header__left` containing `.header__logo` image.
  - `.header__center` containing:
    - `#salutation.headerGreeting.salutation.salutation--header`
    - `#authStatus.headerSignedIn.status`
    - `.headerActions` with:
      - `#navDrawerToggle.btn.btn--drawerToggle`
      - `#logoutBtn.btn`
  - `.header__right` containing:
    - `#inviteAdminBtn.iconBtn.headerInviteBtn.noPrint` (invite icon button)
  - `#adminSectionExtension.adminSectionExtension.noPrint`.
- Primary nav tabs are NOT in header markup. They are currently in `#adminSideNav.sideNav.adminDrawer` inside `#dashboardCard .adminLayout`.

## Current Header/Nav CSS (admin/public/admin.css)
- Header base styles at top of file and multiple later override blocks using `.header`, `.header__left`, `.header__center`, `.header__right`, `.headerGreeting`, `.headerSignedIn`, `.headerActions`.
- Desktop fixed-stack rule block (`@media (min-width:901px)`) currently treats:
  - `#adminHeader.header` as fixed top bar.
  - `#adminSideNav.adminDrawer.sideNav` as a separate fixed horizontal nav strip under header.
  - `#app.app` top padding computed as header height + nav height.
- Mobile/drawer behavior uses:
  - `#navDrawerToggle` button,
  - `.adminDrawer` open/closed transforms,
  - `#adminDrawerBackdrop`.

## Current Header/Auth Rendering Logic (admin/public/admin.js)
- Header visibility:
  - `setAuthenticatedHeaderVisible(isAuthenticated)` toggles `#adminHeader.hidden`.
- Header metric variables:
  - `updateHeaderBumper()` writes `--admin-header-height`.
  - `updateLayoutMetrics()` writes `--admin-section-extension-height`.
- Auth state/UI:
  - `refreshAuthUI()` loads `/api/me` and updates:
    - `#logoutBtn.hidden`
    - `#inviteAdminBtn.hidden` using `USERS_MANAGE_PERMISSION`
    - `#authStatus` text (`Signed in as ...`)
    - `#salutation` text (currently greeting + user name)
- Logout behavior:
  - `logout()` posts to `/api/auth/logout`.
  - Click handler on `#logoutBtn` calls `logout()` then `refreshAuthUI()`.

## Breadcrumb Rendering Logic
- Main page breadcrumbs are in each panel under `.pageContext__crumb` (in index.html).
- Additional normalization is done in `admin/public/admin-structure-overrides.js`:
  - `fixBreadcrumbs()` rewrites each `.pageContext__crumb` from `.pageContext__title`.
- No dedicated authenticated header breadcrumb container currently exists.

## Greeting / User / Role Values
- Greeting currently comes from `refreshAuthUI()` in admin.js:
  - Time-based `Good morning/afternoon/evening`.
  - Uses user display name/email for `#salutation`.
- User status currently uses `#authStatus` with `Signed in as {nameOrEmail}`.
- Role is available from `/api/me` user object (`me.user.role`) but not currently used in header greeting text.

## Invite Admin Permission Logic
- In `refreshAuthUI()`:
  - `canManageUsers = me.permissions.includes('users.manage')`
  - `#inviteAdminBtn.hidden = !canManageUsers || inInviteFlow`

## Main Navigation Tab Behavior
- Tab activation logic in `setTab()`, `activateMainSection()`, hash routing (`applyHashNavigation()`), and click bindings for `#tabBtn-*`.
- Active states, `aria-selected`, and panel visibility are managed in JS and must stay unchanged.

## Mobile Navigation Behavior
- Drawer state in admin.js: `setAdminDrawerOpen`, keyboard trap, backdrop and Escape handling.
- Trigger/button IDs and classes used by behavior:
  - `#navDrawerToggle`, `#adminDrawerBackdrop`, `#adminSideNav.adminDrawer`.

## Build Mirror to cf_site
- `scripts/build_cf_site.ps1` copies `admin/public/*` to `cf_site/admin`.
- It also injects `admin-structure-overrides.css/js` tags into copied `cf_site/admin/index.html`.
- Therefore header edits in `admin/public/index.html`, `admin/public/admin.css`, `admin/public/admin.js` automatically mirror into `cf_site/admin` after `npm run build:cf`.
