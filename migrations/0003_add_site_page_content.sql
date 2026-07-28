-- Visual website editor: draft/published content per public page.
-- One row per page key (see src/site-editor-schema.js PAGE_SCHEMAS for the allowed keys
-- and the field registry). `*_fields` columns store a JSON object of fieldKey -> value.
-- `previous_published_*` retains the prior published snapshot for a simple one-level
-- rollback (per-page), since D1 has no built-in versioning.
CREATE TABLE IF NOT EXISTS site_page_content (
  page TEXT PRIMARY KEY,
  draft_fields TEXT NOT NULL DEFAULT '{}',
  draft_version INTEGER NOT NULL DEFAULT 0,
  draft_updated_at TEXT,
  draft_updated_by TEXT,
  published_fields TEXT NOT NULL DEFAULT '{}',
  published_version INTEGER NOT NULL DEFAULT 0,
  published_updated_at TEXT,
  published_updated_by TEXT,
  previous_published_fields TEXT,
  previous_published_version INTEGER,
  previous_published_updated_at TEXT,
  created_at TEXT NOT NULL
);
