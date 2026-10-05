-- Supports bounded dashboard/list queries; verified with EXPLAIN QUERY PLAN.
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events(event_date, event_time);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at);
CREATE INDEX IF NOT EXISTS idx_newsletter_records_status_schedule ON newsletter_records(status, schedule_at);
