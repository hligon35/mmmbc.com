INSERT INTO admin_users (
  id, email, full_name, role, status, invited_by, invited_at,
  activated_at, last_login_at, created_at, updated_at
)
VALUES
  ('roster-steve-harvey', 'sfhcrown@yahoo.com', 'Rev. Steve Harvey', 'administrator', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-marsha-roundtree', 'mrstree1961@gmail.com', 'Marsha Roundtree', 'administrator', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-weldon-stokes', 'stokes9119@bellsouth.net', 'Weldon Stokes', 'treasurer', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-elbert-spears', 'lifeisgood35@msn.com', 'Elbert Spears', 'website_editor', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-john-burnett', 'johnburnett313@icloud.com', 'John Burnett', 'administrator', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-sherona-waldon', 'sheronacrim@yahoo.com', 'Sherona Waldon', 'website_editor', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-calvin-cole-jr', 'calvin.cole@att.net', 'Calvin Cole, Jr.', 'website_editor', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-derek-strong', 'ddstrong40@bellsouth.net', 'Derek Strong', 'website_editor', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('roster-harold-ligon', 'hligon@getsparqd.com', 'Harold Ligon', 'administrator', 'pending', 'roster-import', strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(email) DO UPDATE SET
  full_name = excluded.full_name,
  role = excluded.role,
  status = CASE WHEN admin_users.status = 'active' THEN 'active' ELSE excluded.status END,
  invited_by = CASE WHEN admin_users.invited_by = '' OR admin_users.invited_by IS NULL THEN excluded.invited_by ELSE admin_users.invited_by END,
  invited_at = COALESCE(admin_users.invited_at, excluded.invited_at),
  activated_at = CASE WHEN admin_users.status = 'active' THEN COALESCE(admin_users.activated_at, excluded.updated_at) ELSE admin_users.activated_at END,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO admin_audit_log (
  id, actor_user_id, actor_email, action, target_user_id, target_email,
  previous_value_json, new_value_json, created_at
)
SELECT
  'audit-roster-' || lower(replace(replace(email, '@', '-at-'), '.', '-')),
  NULL,
  'roster-import',
  'user.roster_imported',
  id,
  email,
  NULL,
  json_object('email', email, 'fullName', full_name, 'role', role, 'status', status),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM admin_users
WHERE lower(email) IN (
  'sfhcrown@yahoo.com',
  'mrstree1961@gmail.com',
  'stokes9119@bellsouth.net',
  'lifeisgood35@msn.com',
  'johnburnett313@icloud.com',
  'sheronacrim@yahoo.com',
  'calvin.cole@att.net',
  'ddstrong40@bellsouth.net',
  'hligon@getsparqd.com'
);