# Route Manifest

Date: 2026-08-04
Source: static scan of Worker and admin server route declarations.
Purpose: protect route coverage during refactor without changing contracts.

## Worker Public Endpoints

- GET /api/public/announcements
- GET /api/public/events
- GET /api/public/bulletins
- GET /api/public/gallery
- GET /api/public/youtube
- GET /api/public/site-settings
- GET /api/public/livestream
- POST /api/public/newsletter/subscribe
- POST /api/public/contact-message
- POST /api/public/facility-rental-request
- GET /api/site-content/:page
- GET /cdn/gallery/:key

## Worker Protected Endpoints

- GET /api/me
- GET /api/access/status
- GET /api/admin/health
- GET /api/admin/integration-health
- POST /api/support/message
- GET /api/users
- POST /api/users/invite
- DELETE /api/users/:id
- GET /api/subscribers
- PUT /api/subscribers
- GET /api/newsletter/records
- POST /api/newsletter/records
- POST /api/newsletter/test
- POST /api/newsletter/send

## Worker Domain Groups

### Directory

- /api/directory/overview (GET)
- /api/directory/contacts (GET, POST)
- /api/directory/contacts/:id (GET, PUT, DELETE alias behavior)
- /api/directory/contacts/:id/archive (POST)
- /api/directory/contacts/duplicate-check (POST)
- /api/directory/contacts/check-duplicates (POST alias)
- /api/directory/subscribers (GET, POST)
- /api/directory/subscribers/:id (GET, PUT)
- /api/directory/subscribers/:id/unsubscribe (POST)
- /api/directory/groups (GET, POST)
- /api/directory/groups/:id (PUT)
- /api/directory/lists (GET, POST)
- /api/directory/lists/:id (PUT)

### Gallery and R2

- /api/gallery (GET)
- /api/gallery/settings (GET, PUT)
- /api/gallery/upload (POST)
- /api/gallery/order (PUT)
- /api/gallery/:id (PUT, DELETE)
- /api/gallery/r2list (GET)
- /api/gallery/r2tree (GET)
- /api/gallery/r2object (DELETE)
- /api/gallery/sync (POST)
- /api/gallery/r2migrate (GET)

### Content

- /api/announcements (GET, POST)
- /api/announcements/:id (PUT, DELETE)
- /api/events (GET, POST)
- /api/events/:id (PUT, DELETE)
- /api/bulletins (GET)
- /api/bulletins/:id (PUT, DELETE)

### Giving and Finance Reconciliation

- /api/giving/checkout (POST)
- /api/stripe/webhook (POST)
- /api/giving/session (GET)
- /api/finances/donors* (multiple)
- /api/finances/collections* (multiple)
- /api/finances/scans* (multiple)
- /api/finances/scan-codes* (multiple)

## Worker Fallback Contracts

- Unknown directory endpoint returns JSON 404 with Directory endpoint not found.
- Unknown /api/* endpoint returns JSON 404 with API endpoint not found.
- Method-not-allowed responses exist in selected mutator handlers with JSON 405.

## Admin Local Server Endpoints

Primary route domains exposed by admin/server.js:

- /api/auth/*
- /api/me
- /api/users*
- /api/invites/*
- /api/gallery*
- /api/announcements*
- /api/events*
- /api/bulletins*
- /api/documents*
- /api/livestream*
- /api/settings
- /api/subscribers
- /api/newsletter/*
- /api/finances/*
- /api/directory/* (proxied to Worker)

Notes:

- Admin route authorization is permission-gated per endpoint group.
- Local server and Worker both expose overlapping API surface by design for local parity.
