-- Reconcile the legacy/public subscriber table with the Directory subscriber model.
-- Both DB and SITE_DB currently bind to the same D1 database in production.

INSERT INTO newsletter_subscribers (
  id,
  contact_id,
  email,
  status,
  consent_source,
  consent_date,
  confirmed_at,
  unsubscribed_at,
  suppression_reason,
  created_at,
  updated_at
)
SELECT
  'legacy-' || lower(hex(randomblob(16))),
  NULL,
  lower(trim(s.email)),
  CASE
    WHEN lower(coalesce(s.status, 'active')) = 'active' THEN 'active'
    WHEN lower(coalesce(s.status, 'active')) = 'unsubscribed' THEN 'unsubscribed'
    ELSE lower(coalesce(s.status, 'pending'))
  END,
  'website_signup',
  substr(s.created_at, 1, 10),
  CASE WHEN lower(coalesce(s.status, 'active')) = 'active' THEN s.created_at ELSE NULL END,
  CASE WHEN lower(coalesce(s.status, 'active')) = 'unsubscribed' THEN s.created_at ELSE NULL END,
  NULL,
  s.created_at,
  s.created_at
FROM subscribers s
WHERE trim(coalesce(s.email, '')) <> ''
ON CONFLICT(email) DO NOTHING;
