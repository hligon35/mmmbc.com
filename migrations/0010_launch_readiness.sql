CREATE TABLE IF NOT EXISTS gallery_items (
 id TEXT PRIMARY KEY, album TEXT NOT NULL, label TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
 file_key TEXT NOT NULL, thumb_key TEXT, original_name TEXT, created_at TEXT NOT NULL, position INTEGER,
 is_hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gallery_album ON gallery_items(album);
CREATE TABLE IF NOT EXISTS newsletter_suppressions (email TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS newsletter_deliveries (
 campaign_id TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, status TEXT NOT NULL DEFAULT 'pending',
 provider_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
 PRIMARY KEY(campaign_id,email)
);
