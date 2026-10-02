CREATE TABLE IF NOT EXISTS email_delivery_jobs (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, submission_type TEXT NOT NULL,
 kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_due ON email_delivery_jobs(status,next_attempt_at);
