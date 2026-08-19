-- MMMBC admin test data (synthetic records only)
--
-- Purpose:
--   Populate the admin with realistic directory, visitor, newsletter, event,
--   announcement, finance, giving, envelope, and collection records.
--
-- Safety:
--   * No admin_invites or login accounts are created.
--   * All records use the "test-" ID prefix and example.com email addresses.
--   * Re-running this file updates/replaces only these synthetic records.
--   * The cleanup block at the end is intentionally commented out.
--
-- Cloudflare D1 commands for this repository's configured "mmdb" database:
--   Local:  npx wrangler d1 execute mmdb --local  --file=./scripts/seed_admin_test_data.sql
--   Remote: npx wrangler d1 execute mmdb --remote --file=./scripts/seed_admin_test_data.sql

PRAGMA foreign_keys = ON;

CREATE TEMP TABLE IF NOT EXISTS seed_guard_directory_ready (
  ready_directory INTEGER NOT NULL CHECK (ready_directory = 1)
);
DELETE FROM seed_guard_directory_ready;
INSERT INTO seed_guard_directory_ready (ready_directory)
VALUES (
  CASE
    WHEN EXISTS (SELECT 1 FROM pragma_table_info('directory_contacts') WHERE name = 'id') THEN 1
    ELSE 0
  END
);

-- Tables initialized at runtime by the current finance API.
CREATE TABLE IF NOT EXISTS finance_funds (
  id TEXT PRIMARY KEY,
  fund_name TEXT NOT NULL UNIQUE,
  fund_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS giving_donations (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  stripe_subscription_id TEXT,
  stripe_connected_account_id TEXT,
  donor_name TEXT,
  donor_email TEXT,
  fund_code TEXT NOT NULL,
  frequency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  payment_status TEXT NOT NULL,
  payment_method_type TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_giving_paid_at ON giving_donations(paid_at);
CREATE INDEX IF NOT EXISTS idx_giving_fund ON giving_donations(fund_code);
CREATE INDEX IF NOT EXISTS idx_giving_email ON giving_donations(donor_email);

-- Five active non-admin church members and six visitors. Six visitors are used
-- so every requested previous-visit count from 0 through 5 is represented.
INSERT OR REPLACE INTO directory_contacts (
  id, first_name, middle_name, last_name, preferred_name, suffix,
  contact_type, membership_status, status, primary_email, secondary_email,
  mobile_phone, home_phone, preferred_contact_method,
  address_line_1, address_line_2, city, state, postal_code,
  birth_month, birth_day, anniversary_month, anniversary_day, member_since,
  notes, created_by, updated_by, created_at, updated_at, archived_at,
  account_number, normalized_primary_phone, normalized_home_phone
) VALUES
  ('test-contact-member-01', 'Jordan', 'A.', 'Brooks', 'Jordan', NULL, 'member', 'active', 'active', 'jordan.brooks@example.com', NULL, '(270) 555-0101', NULL, 'email', '101 Testimony Lane', NULL, 'Paducah', 'KY', '42001', 2, 14, 6, 18, '2018-04-08', 'Synthetic test member. Usher Ministry volunteer.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-730 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'MM-TEST0001', '2705550101', NULL),
  ('test-contact-member-02', 'Avery', NULL, 'Coleman', 'Avery', NULL, 'member', 'active', 'active', 'avery.coleman@example.com', NULL, '(270) 555-0102', '(270) 555-1102', 'phone', '202 Faith Avenue', 'Apt 2', 'Paducah', 'KY', '42003', 5, 23, NULL, NULL, '2021-09-12', 'Synthetic test member. Interested in discipleship classes.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-600 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), NULL, 'MM-TEST0002', '2705550102', '2705551102'),
  ('test-contact-member-03', 'Morgan', 'Lee', 'Davis', 'Mo', NULL, 'member', 'active', 'active', 'morgan.davis@example.com', NULL, '(270) 555-0103', NULL, 'text', '303 Grace Court', NULL, 'Paducah', 'KY', '42001', 8, 9, 10, 2, '2015-01-11', 'Synthetic test member. Choir section leader.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-900 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), NULL, 'MM-TEST0003', '2705550103', NULL),
  ('test-contact-member-04', 'Taylor', NULL, 'Ellis', 'Taylor', 'Jr.', 'member', 'active', 'active', 'taylor.ellis@example.com', NULL, '(270) 555-0104', NULL, 'email', '404 Hope Street', NULL, 'Paducah', 'KY', '42001', 11, 30, 3, 16, '2023-05-07', 'Synthetic test member. New member orientation completed.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), NULL, 'MM-TEST0004', '2705550104', NULL),
  ('test-contact-member-05', 'Casey', 'R.', 'Franklin', 'Casey', NULL, 'member', 'active', 'active', 'casey.franklin@example.com', 'casey.alt@example.com', '(270) 555-0105', NULL, 'email', '505 Mercy Drive', NULL, 'Paducah', 'KY', '42003', 1, 7, 7, 21, '2010-08-15', 'Synthetic test member. Finance statement delivery by email.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1200 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'), NULL, 'MM-TEST0005', '2705550105', NULL),
  ('test-contact-visitor-00', 'Riley', NULL, 'Green', 'Riley', NULL, 'visitor', 'prospect', 'active', 'riley.green@example.com', NULL, '(270) 555-0200', NULL, 'text', '600 Welcome Way', NULL, 'Paducah', 'KY', '42001', 4, 12, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 0. First-time guest; no check-in history yet.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'MM-VISIT0000', '2705550200', NULL),
  ('test-contact-visitor-01', 'Cameron', NULL, 'Harris', 'Cam', NULL, 'visitor', 'prospect', 'active', 'cameron.harris@example.com', NULL, '(270) 555-0201', NULL, 'email', '601 Welcome Way', NULL, 'Paducah', 'KY', '42001', 6, 5, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 1. Requested information about Sunday School.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, 'MM-VISIT0001', '2705550201', NULL),
  ('test-contact-visitor-02', 'Quinn', NULL, 'Irving', 'Quinn', NULL, 'visitor', 'prospect', 'active', 'quinn.irving@example.com', NULL, '(270) 555-0202', NULL, 'text', '602 Welcome Way', NULL, 'Paducah', 'KY', '42003', 7, 17, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 2. Interested in youth programs.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, 'MM-VISIT0002', '2705550202', NULL),
  ('test-contact-visitor-03', 'Parker', NULL, 'Johnson', 'Parker', NULL, 'visitor', 'prospect', 'active', 'parker.johnson@example.com', NULL, '(270) 555-0203', NULL, 'phone', '603 Welcome Way', NULL, 'Paducah', 'KY', '42003', 9, 3, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 3. Follow-up call requested.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, 'MM-VISIT0003', '2705550203', NULL),
  ('test-contact-visitor-04', 'Reese', NULL, 'King', 'Reese', NULL, 'visitor', 'prospect', 'active', 'reese.king@example.com', NULL, '(270) 555-0204', NULL, 'email', '604 Welcome Way', NULL, 'Paducah', 'KY', '42001', 10, 26, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 4. Attended worship and Bible study.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-38 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, 'MM-VISIT0004', '2705550204', NULL),
  ('test-contact-visitor-05', 'Skyler', NULL, 'Lewis', 'Sky', NULL, 'visitor', 'prospect', 'active', 'skyler.lewis@example.com', NULL, '(270) 555-0205', NULL, 'text', '605 Welcome Way', NULL, 'Paducah', 'KY', '42001', 12, 8, NULL, NULL, NULL, 'Synthetic visitor test record. Previous visits: 5. Candidate for membership follow-up.', 'test-seed', 'test-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, 'MM-VISIT0005', '2705550205', NULL);

-- Visitor check-ins. The current application has no visit-count column, so the
-- activity log is the native, visible source of truth for prior visits.
DELETE FROM directory_activity_log WHERE id LIKE 'test-visit-%';
INSERT INTO directory_activity_log
  (id, actor_email, event_type, entity_type, entity_id, summary, metadata_json, created_at)
VALUES
  ('test-visit-01-01', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-01', 'Visitor check-in: Sunday Worship', '{"visitNumber":1,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-visit-02-01', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-02', 'Visitor check-in: Sunday Worship', '{"visitNumber":1,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-21 days')),
  ('test-visit-02-02', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-02', 'Visitor check-in: Sunday Worship', '{"visitNumber":2,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-visit-03-01', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-03', 'Visitor check-in: Sunday Worship', '{"visitNumber":1,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-28 days')),
  ('test-visit-03-02', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-03', 'Visitor check-in: Bible Study', '{"visitNumber":2,"service":"Bible Study","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')),
  ('test-visit-03-03', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-03', 'Visitor check-in: Sunday Worship', '{"visitNumber":3,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-visit-04-01', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-04', 'Visitor check-in: Sunday Worship', '{"visitNumber":1,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-35 days')),
  ('test-visit-04-02', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-04', 'Visitor check-in: Bible Study', '{"visitNumber":2,"service":"Bible Study","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-28 days')),
  ('test-visit-04-03', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-04', 'Visitor check-in: Sunday Worship', '{"visitNumber":3,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')),
  ('test-visit-04-04', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-04', 'Visitor check-in: Sunday Worship', '{"visitNumber":4,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-visit-05-01', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-05', 'Visitor check-in: Sunday Worship', '{"visitNumber":1,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-42 days')),
  ('test-visit-05-02', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-05', 'Visitor check-in: Bible Study', '{"visitNumber":2,"service":"Bible Study","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-35 days')),
  ('test-visit-05-03', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-05', 'Visitor check-in: Sunday Worship', '{"visitNumber":3,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-28 days')),
  ('test-visit-05-04', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-05', 'Visitor check-in: Bible Study', '{"visitNumber":4,"service":"Bible Study","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')),
  ('test-visit-05-05', 'test-seed@mmmbc.example', 'visitor_check_in', 'contact', 'test-contact-visitor-05', 'Visitor check-in: Sunday Worship', '{"visitNumber":5,"service":"Sunday Worship","synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

-- Ministry groups and assignments.
INSERT OR REPLACE INTO directory_groups
  (id, name, category, description, status, created_at, updated_at)
VALUES
  ('test-group-ushers', 'Test Ushers Ministry', 'ministry', 'Synthetic group for directory testing.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-group-choir', 'Test Choir', 'ministry', 'Synthetic group for directory testing.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-300 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-group-welcome', 'Test Welcome Team', 'ministry', 'Synthetic visitor follow-up group.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO directory_group_members
  (id, group_id, contact_id, role, joined_at, ended_at, notes)
VALUES
  ('test-gm-01', 'test-group-ushers', 'test-contact-member-01', 'Volunteer', '2022-01-09', NULL, 'Synthetic assignment'),
  ('test-gm-02', 'test-group-choir', 'test-contact-member-03', 'Section Leader', '2019-03-10', NULL, 'Synthetic assignment'),
  ('test-gm-03', 'test-group-welcome', 'test-contact-member-04', 'Follow-up Volunteer', '2025-02-02', NULL, 'Synthetic assignment'),
  ('test-gm-04', 'test-group-welcome', 'test-contact-visitor-05', 'Prospective Volunteer', date('now','-14 days'), NULL, 'Synthetic visitor assignment');

-- Directory newsletter relationships and statuses.
INSERT OR REPLACE INTO newsletter_subscribers
  (id, contact_id, email, status, consent_source, consent_date, confirmed_at,
   unsubscribed_at, suppression_reason, last_emailed_at, created_at, updated_at)
VALUES
  ('test-ns-01', 'test-contact-member-01', 'jordan.brooks@example.com', 'active', 'admin_test_seed', date('now','-120 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 days'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-ns-02', 'test-contact-member-02', 'avery.coleman@example.com', 'active', 'admin_test_seed', date('now','-90 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-ns-03', 'test-contact-member-03', 'morgan.davis@example.com', 'unsubscribed', 'admin_test_seed', date('now','-180 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-180 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'), 'user_request', strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-180 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')),
  ('test-ns-04', 'test-contact-member-04', 'taylor.ellis@example.com', 'pending', 'admin_test_seed', date('now','-2 days'), NULL, NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')),
  ('test-ns-05', 'test-contact-member-05', 'casey.franklin@example.com', 'active', 'admin_test_seed', date('now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-ns-06', 'test-contact-visitor-03', 'parker.johnson@example.com', 'active', 'visitor_card', date('now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO newsletter_lists
  (id, name, description, status, created_at, updated_at)
VALUES
  ('test-list-weekly', 'Test Weekly Updates', 'Synthetic newsletter list.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-list-visitors', 'Test Visitor Follow-up', 'Synthetic visitor list.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO newsletter_list_members
  (id, list_id, subscriber_id, added_at, removed_at)
VALUES
  ('test-nlm-01', 'test-list-weekly', 'test-ns-01', strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 days'), NULL),
  ('test-nlm-02', 'test-list-weekly', 'test-ns-02', strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'), NULL),
  ('test-nlm-03', 'test-list-weekly', 'test-ns-05', strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'), NULL),
  ('test-nlm-04', 'test-list-visitors', 'test-ns-06', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), NULL);

-- Legacy subscriber table drives the overview dashboard subscriber count.
INSERT OR REPLACE INTO subscribers (id, email, name, status, created_at) VALUES
  ('test-subscriber-01', 'jordan.brooks@example.com', 'Jordan Brooks', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-120 days')),
  ('test-subscriber-02', 'avery.coleman@example.com', 'Avery Coleman', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')),
  ('test-subscriber-03', 'casey.franklin@example.com', 'Casey Franklin', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days')),
  ('test-subscriber-04', 'parker.johnson@example.com', 'Parker Johnson', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

-- Dashboard content with relative dates so records remain useful whenever seeded.
INSERT OR REPLACE INTO announcements (id, title, body, created_at, expires_at) VALUES
  ('test-announcement-01', 'Test: Community Food Drive', 'Synthetic announcement for testing create, edit, preview, expiration, and dashboard displays.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+21 days')),
  ('test-announcement-02', 'Test: Volunteer Orientation', 'Synthetic announcement for testing admin workflows.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 days')),
  ('test-announcement-expired', 'Test: Expired Announcement', 'Synthetic expired record for filtering tests.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 days'));

INSERT OR REPLACE INTO events (id, title, event_date, event_time, created_at, updated_at) VALUES
  ('test-event-today', 'Test: Evening Prayer', date('now'), '18:00', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-event-03', 'Test: Bible Study', date('now','+3 days'), '18:30', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-event-07', 'Test: Youth Fellowship', date('now','+7 days'), '14:00', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-event-12', 'Test: Community Outreach', date('now','+12 days'), '09:00', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-event-past', 'Test: Past Leadership Meeting', date('now','-14 days'), '17:30', strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days'));

INSERT OR REPLACE INTO newsletter_records
  (id, subject, message, emails, status, sent_count, schedule_at,
   schedule_date, schedule_time, schedule_timezone, retry_count, error,
   created_at, updated_at, sent_at)
VALUES
  ('test-newsletter-draft', 'Test: Weekly Church Update', 'Synthetic draft newsletter body.', '["jordan.brooks@example.com","avery.coleman@example.com"]', 'draft', 0, NULL, NULL, NULL, 'America/Chicago', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('test-newsletter-scheduled', 'Test: Upcoming Events', 'Synthetic scheduled newsletter body.', '["jordan.brooks@example.com","casey.franklin@example.com"]', 'scheduled', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 days'), date('now','+2 days'), '09:00', 'America/Chicago', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('test-newsletter-sent', 'Test: Prior Weekly Update', 'Synthetic sent newsletter body.', '["jordan.brooks@example.com","avery.coleman@example.com","casey.franklin@example.com"]', 'sent', 3, NULL, NULL, NULL, 'America/Chicago', 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-newsletter-failed', 'Test: Failed Delivery', 'Synthetic failed newsletter body.', '["invalid-test@example.com"]', 'failed', 0, NULL, NULL, NULL, 'America/Chicago', 1, 'Synthetic delivery failure for error-state testing.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'), NULL);

-- Finance ledger records used by the main admin Finance section.
CREATE TEMP TABLE IF NOT EXISTS seed_guard_finance_core_ready (
  ready_finance_core INTEGER NOT NULL CHECK (ready_finance_core = 1)
);
DELETE FROM seed_guard_finance_core_ready;
INSERT INTO seed_guard_finance_core_ready (ready_finance_core)
VALUES (
  CASE
    WHEN EXISTS (SELECT 1 FROM pragma_table_info('finance_entries') WHERE name = 'entry_date')
      AND EXISTS (SELECT 1 FROM pragma_table_info('finance_funds') WHERE name = 'fund_name')
      AND EXISTS (SELECT 1 FROM pragma_table_info('finance_meta') WHERE name = 'value_json')
    THEN 1
    ELSE 0
  END
);

INSERT OR REPLACE INTO finance_funds
  (id, fund_name, fund_code, active, created_at, updated_at)
VALUES
  ('test-fund-general', 'Test General Fund', 'GENERAL', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-fund-building', 'Test Building Fund', 'BUILDING', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-fund-missions', 'Test Missions Fund', 'MISSIONS', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO finance_meta (key, value_json, updated_at)
VALUES ('test-seed', '{"categories":["Offering","Utilities","Outreach","Supplies"],"funds":["Test General Fund","Test Building Fund","Test Missions Fund"]}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO finance_entries
  (id, entry_date, type, category, fund, method, party, memo,
   amount_cents, created_at, updated_at)
VALUES
  ('test-finance-01', date('now','-5 days'), 'income', 'Offering', 'Test General Fund', 'Online', 'Jordan Brooks', 'Synthetic giving entry', 12500, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days')),
  ('test-finance-02', date('now','-12 days'), 'income', 'Offering', 'Test Building Fund', 'Online', 'Avery Coleman', 'Synthetic building fund entry', 5000, strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days')),
  ('test-finance-03', date('now','-8 days'), 'expense', 'Utilities', 'Test General Fund', 'Check', 'Test Utility Company', 'Synthetic utility expense', 7250, strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days')),
  ('test-finance-04', date('now','-3 days'), 'expense', 'Outreach', 'Test Missions Fund', 'Card', 'Test Community Partner', 'Synthetic outreach supplies', 1800, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'));

-- Linked donor records (members receive active envelope codes; visitors are
-- one-time donors without member envelopes).
INSERT OR REPLACE INTO finance_donors (
  id, first_name, middle_name, last_name, preferred_name, household_id,
  mailing_address, email, phone, statement_delivery, active, statement_eligible,
  directory_contact_id, account_number, donor_kind, merged_into_donor_id,
  envelope_number, envelope_code, envelope_code_status,
  envelope_code_issued_at, envelope_code_updated_at, created_at, updated_at
) VALUES
  ('test-donor-01', 'Jordan', 'A.', 'Brooks', 'Jordan', NULL, '101 Testimony Lane, Paducah, KY 42001', 'jordan.brooks@example.com', '(270) 555-0101', 'email', 1, 1, 'test-contact-member-01', 'MM-TEST0001', 'member', NULL, 'T001', 'MM-ENV-T001', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-donor-02', 'Avery', NULL, 'Coleman', 'Avery', NULL, '202 Faith Avenue Apt 2, Paducah, KY 42003', 'avery.coleman@example.com', '(270) 555-0102', 'email', 1, 1, 'test-contact-member-02', 'MM-TEST0002', 'member', NULL, 'T002', 'MM-ENV-T002', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-donor-03', 'Morgan', 'Lee', 'Davis', 'Mo', NULL, '303 Grace Court, Paducah, KY 42001', 'morgan.davis@example.com', '(270) 555-0103', 'mail', 1, 1, 'test-contact-member-03', 'MM-TEST0003', 'member', NULL, 'T003', 'MM-ENV-T003', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-donor-04', 'Taylor', NULL, 'Ellis', 'Taylor', NULL, '404 Hope Street, Paducah, KY 42001', 'taylor.ellis@example.com', '(270) 555-0104', 'email', 1, 1, 'test-contact-member-04', 'MM-TEST0004', 'member', NULL, 'T004', 'MM-ENV-T004', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-donor-05', 'Casey', 'R.', 'Franklin', 'Casey', NULL, '505 Mercy Drive, Paducah, KY 42003', 'casey.franklin@example.com', '(270) 555-0105', 'email', 1, 1, 'test-contact-member-05', 'MM-TEST0005', 'member', NULL, 'T005', 'MM-ENV-T005', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('test-donor-visitor', 'Parker', NULL, 'Johnson', 'Parker', NULL, '603 Welcome Way, Paducah, KY 42003', 'parker.johnson@example.com', '(270) 555-0203', 'email', 1, 0, 'test-contact-visitor-03', 'MM-VISIT0003', 'one_time', NULL, NULL, '', 'inactive', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR REPLACE INTO finance_donor_envelope_codes
  (id, donor_id, envelope_code, envelope_number_snapshot, status, issued_at,
   updated_at, replaced_by_code, note)
VALUES
  ('test-envelope-code-01', 'test-donor-01', 'MM-ENV-T001', 'T001', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code'),
  ('test-envelope-code-02', 'test-donor-02', 'MM-ENV-T002', 'T002', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code'),
  ('test-envelope-code-03', 'test-donor-03', 'MM-ENV-T003', 'T003', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code'),
  ('test-envelope-code-04', 'test-donor-04', 'MM-ENV-T004', 'T004', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code'),
  ('test-envelope-code-05', 'test-donor-05', 'MM-ENV-T005', 'T005', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code');

INSERT OR REPLACE INTO finance_scan_codes
  (id, code_value, code_family, donor_id, status, issued_at, updated_at,
   replaced_by_code_value, note, created_by)
VALUES
  ('test-scan-01', 'MM-ENV-T001', 'member_envelope', 'test-donor-01', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code', 'test-seed'),
  ('test-scan-02', 'MM-ENV-T002', 'member_envelope', 'test-donor-02', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code', 'test-seed'),
  ('test-scan-03', 'MM-ENV-T003', 'member_envelope', 'test-donor-03', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code', 'test-seed'),
  ('test-scan-04', 'MM-ENV-T004', 'member_envelope', 'test-donor-04', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code', 'test-seed'),
  ('test-scan-05', 'MM-ENV-T005', 'member_envelope', 'test-donor-05', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-365 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, 'Synthetic test code', 'test-seed');

-- Online giving records provide successful, pending, and failed states.
INSERT OR REPLACE INTO giving_donations
  (id, stripe_event_id, stripe_checkout_session_id, stripe_payment_intent_id,
   stripe_subscription_id, stripe_connected_account_id, donor_name, donor_email,
   fund_code, frequency, amount_cents, platform_fee_cents, currency,
   payment_status, payment_method_type, note, created_at, paid_at, updated_at)
VALUES
  ('test-giving-01', NULL, 'test-session-01', 'test-pi-01', NULL, NULL, 'Jordan Brooks', 'jordan.brooks@example.com', 'GENERAL', 'one_time', 12500, 313, 'usd', 'paid', 'card', 'Synthetic online gift', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days')),
  ('test-giving-02', NULL, 'test-session-02', 'test-pi-02', NULL, NULL, 'Avery Coleman', 'avery.coleman@example.com', 'BUILDING', 'one_time', 5000, 125, 'usd', 'paid', 'card', 'Synthetic building fund gift', strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-12 days')),
  ('test-giving-03', NULL, 'test-session-03', 'test-pi-03', NULL, NULL, 'Parker Johnson', 'parker.johnson@example.com', 'GENERAL', 'one_time', 2500, 63, 'usd', 'pending', 'card', 'Synthetic pending visitor gift', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
  ('test-giving-04', NULL, 'test-session-04', 'test-pi-04', NULL, NULL, 'Casey Franklin', 'casey.franklin@example.com', 'MISSIONS', 'one_time', 4000, 100, 'usd', 'failed', 'card', 'Synthetic failed gift', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days'), NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days'));

-- Sunday collection batch with cash, check, allocations, counter approval,
-- loose giving, and audit history for reconciliation testing.
CREATE TEMP TABLE IF NOT EXISTS seed_guard_finance_reconciliation_ready (
  ready_finance_reconciliation INTEGER NOT NULL CHECK (ready_finance_reconciliation = 1)
);
DELETE FROM seed_guard_finance_reconciliation_ready;
INSERT INTO seed_guard_finance_reconciliation_ready (ready_finance_reconciliation)
VALUES (
  CASE
    WHEN EXISTS (SELECT 1 FROM pragma_table_info('finance_collection_batches') WHERE name = 'id')
      AND EXISTS (SELECT 1 FROM pragma_table_info('finance_collection_envelopes') WHERE name = 'id')
      AND EXISTS (SELECT 1 FROM pragma_table_info('finance_scan_codes') WHERE name = 'code_value')
    THEN 1
    ELSE 0
  END
);

INSERT OR REPLACE INTO finance_collection_batches (
  id, service_date, service_name, status,
  declared_physical_cash_cents, declared_check_cents,
  calculated_envelope_total_cents, calculated_loose_cash_total_cents,
  calculated_batch_total_cents, discrepancy_cents, discrepancy_explanation,
  count_sheet_attachment_ref, created_by, created_at, updated_at, finalized_at,
  voided_at, voided_by, void_reason, deposit_date, deposit_reference,
  deposited_amount_cents, deposit_confirmed_at, deposit_verified_by,
  deposit_internal_control_exception, approval_version
) VALUES
  ('test-batch-01', date('now','-7 days'), 'Test Sunday Morning Worship', 'finalized',
   16500, 10000, 25000, 1500, 26500, 0, NULL, NULL,
   'test-seed@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'),
   NULL, NULL, NULL, date('now','-6 days'), 'TEST-DEP-001', 26500,
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), 'test-verifier@mmmbc.example', NULL, 1);

INSERT OR REPLACE INTO finance_collection_counters
  (id, batch_id, counter_email, assigned_by, assigned_at)
VALUES
  ('test-counter-01', 'test-batch-01', 'test-counter1@mmmbc.example', 'test-seed@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-counter-02', 'test-batch-01', 'test-counter2@mmmbc.example', 'test-seed@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

INSERT OR REPLACE INTO finance_collection_counter_approvals
  (id, batch_id, counter_email, approved_by, approved_at, batch_version)
VALUES
  ('test-approval-01', 'test-batch-01', 'test-counter1@mmmbc.example', 'test-counter1@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), 1),
  ('test-approval-02', 'test-batch-01', 'test-counter2@mmmbc.example', 'test-counter2@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), 1);

INSERT OR REPLACE INTO finance_collection_envelopes
  (id, batch_id, donor_id, envelope_code_snapshot, envelope_number_snapshot,
   transaction_kind, payment_method, check_number, envelope_total_cents,
   entry_status, created_by, updated_by, created_at, updated_at)
VALUES
  ('test-collection-envelope-01', 'test-batch-01', 'test-donor-01', 'MM-ENV-T001', 'T001', 'cash_envelope', 'cash', NULL, 10000, 'active', 'test-counter1@mmmbc.example', 'test-counter1@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-collection-envelope-02', 'test-batch-01', 'test-donor-02', 'MM-ENV-T002', 'T002', 'check_envelope', 'check', 'TEST-1002', 10000, 'active', 'test-counter1@mmmbc.example', 'test-counter1@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-collection-envelope-03', 'test-batch-01', 'test-donor-03', 'MM-ENV-T003', 'T003', 'cash_envelope', 'cash', NULL, 5000, 'active', 'test-counter2@mmmbc.example', 'test-counter2@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

INSERT OR REPLACE INTO finance_collection_allocations
  (id, envelope_entry_id, fund_id, fund_code, amount_cents, note, created_at, updated_at)
VALUES
  ('test-allocation-01', 'test-collection-envelope-01', 'test-fund-general', 'GENERAL', 7500, 'Synthetic tithe allocation', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-allocation-02', 'test-collection-envelope-01', 'test-fund-building', 'BUILDING', 2500, 'Synthetic building allocation', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-allocation-03', 'test-collection-envelope-02', 'test-fund-general', 'GENERAL', 10000, 'Synthetic check allocation', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-allocation-04', 'test-collection-envelope-03', 'test-fund-missions', 'MISSIONS', 5000, 'Synthetic missions allocation', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

INSERT OR REPLACE INTO finance_collection_loose_giving
  (id, batch_id, fund_id, fund_code, payment_method, amount_cents, note,
   created_by, created_at, updated_at)
VALUES
  ('test-loose-01', 'test-batch-01', 'test-fund-general', 'GENERAL', 'cash', 1500, 'Synthetic loose offering', 'test-counter2@mmmbc.example', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

INSERT OR REPLACE INTO finance_collection_audit_events
  (id, batch_id, donor_id, envelope_entry_id, event_type, event_action,
   actor_email, reason, metadata_json, created_at)
VALUES
  ('test-audit-01', 'test-batch-01', NULL, NULL, 'batch', 'created', 'test-seed@mmmbc.example', 'Synthetic test batch', '{"synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-audit-02', 'test-batch-01', 'test-donor-01', 'test-collection-envelope-01', 'envelope', 'created', 'test-counter1@mmmbc.example', 'Synthetic envelope entry', '{"synthetic":true}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-audit-03', 'test-batch-01', NULL, NULL, 'batch', 'finalized', 'test-counter2@mmmbc.example', 'Synthetic batch finalization', '{"synthetic":true,"approvalVersion":1}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')),
  ('test-audit-04', 'test-batch-01', NULL, NULL, 'deposit', 'confirmed', 'test-verifier@mmmbc.example', 'Synthetic deposit confirmation', '{"synthetic":true,"reference":"TEST-DEP-001"}', strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'));

-- Optional cleanup (run selected statements manually when needed):
-- DELETE FROM finance_collection_audit_events WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_counter_approvals WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_counters WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_allocations WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_loose_giving WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_envelopes WHERE id LIKE 'test-%';
-- DELETE FROM finance_collection_batches WHERE id LIKE 'test-%';
-- DELETE FROM finance_scan_codes WHERE id LIKE 'test-%';
-- DELETE FROM finance_donor_envelope_codes WHERE id LIKE 'test-%';
-- DELETE FROM giving_donations WHERE id LIKE 'test-%';
-- DELETE FROM finance_entries WHERE id LIKE 'test-%';
-- DELETE FROM finance_meta WHERE key = 'test-seed';
-- DELETE FROM finance_funds WHERE id LIKE 'test-%';
-- DELETE FROM finance_donors WHERE id LIKE 'test-%';
-- DELETE FROM newsletter_list_members WHERE id LIKE 'test-%';
-- DELETE FROM newsletter_lists WHERE id LIKE 'test-%';
-- DELETE FROM newsletter_subscribers WHERE id LIKE 'test-%';
-- DELETE FROM subscribers WHERE id LIKE 'test-%';
-- DELETE FROM directory_group_members WHERE id LIKE 'test-%';
-- DELETE FROM directory_groups WHERE id LIKE 'test-%';
-- DELETE FROM directory_activity_log WHERE id LIKE 'test-%';
-- DELETE FROM newsletter_records WHERE id LIKE 'test-%';
-- DELETE FROM events WHERE id LIKE 'test-%';
-- DELETE FROM announcements WHERE id LIKE 'test-%';
-- DELETE FROM directory_contacts WHERE id LIKE 'test-%';
