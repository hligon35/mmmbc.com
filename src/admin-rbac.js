export const PERMISSIONS = Object.freeze({
  ANNOUNCEMENTS_VIEW: 'announcements.view',
  ANNOUNCEMENTS_MANAGE: 'announcements.manage',
  EVENTS_VIEW: 'events.view',
  EVENTS_MANAGE: 'events.manage',
  PHOTOS_VIEW: 'photos.view',
  PHOTOS_MANAGE: 'photos.manage',
  NEWSLETTER_VIEW: 'newsletter.view',
  NEWSLETTER_MANAGE: 'newsletter.manage',
  FINANCE_VIEW: 'finance.view',
  FINANCE_RECORD: 'finance.record',
  FINANCE_EDIT_VOID: 'finance.edit_void',
  FINANCE_REPORTS_RECEIPTS: 'finance.reports_receipts',
  FINANCE_FUNDS_CATEGORIES: 'finance.funds_categories',
  FINANCE_EXPORT: 'finance.export',
  FINANCE_STATEMENTS_CONTROLS: 'finance.statements_controls',
  DIRECTORY_VIEW: 'directory.view',
  DIRECTORY_MANAGE: 'directory.manage',
  SUPPORT_SEND: 'support.send',
  SUBMISSIONS_VIEW: 'submissions.view',
  SUBMISSIONS_MANAGE: 'submissions.manage',
  USERS_MANAGE: 'users.manage',
  SETTINGS_MANAGE: 'settings.manage'
});

const WEBSITE_PERMISSIONS = [
  PERMISSIONS.ANNOUNCEMENTS_VIEW,
  PERMISSIONS.ANNOUNCEMENTS_MANAGE,
  PERMISSIONS.EVENTS_VIEW,
  PERMISSIONS.EVENTS_MANAGE,
  PERMISSIONS.PHOTOS_VIEW,
  PERMISSIONS.PHOTOS_MANAGE,
  PERMISSIONS.NEWSLETTER_VIEW,
  PERMISSIONS.NEWSLETTER_MANAGE,
  PERMISSIONS.DIRECTORY_VIEW,
  PERMISSIONS.DIRECTORY_MANAGE,
  PERMISSIONS.SUPPORT_SEND,
  PERMISSIONS.SUBMISSIONS_VIEW,
  PERMISSIONS.SUBMISSIONS_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE
];

const FINANCE_ENTRY_PERMISSIONS = [
  PERMISSIONS.FINANCE_VIEW,
  PERMISSIONS.FINANCE_RECORD,
  PERMISSIONS.DIRECTORY_VIEW,
  PERMISSIONS.DIRECTORY_MANAGE,
  PERMISSIONS.SUPPORT_SEND
];

const TREASURER_PERMISSIONS = [
  PERMISSIONS.FINANCE_VIEW,
  PERMISSIONS.FINANCE_RECORD,
  PERMISSIONS.FINANCE_EDIT_VOID,
  PERMISSIONS.FINANCE_REPORTS_RECEIPTS,
  PERMISSIONS.FINANCE_FUNDS_CATEGORIES,
  PERMISSIONS.FINANCE_EXPORT,
  PERMISSIONS.FINANCE_STATEMENTS_CONTROLS,
  PERMISSIONS.DIRECTORY_VIEW,
  PERMISSIONS.DIRECTORY_MANAGE,
  PERMISSIONS.SUPPORT_SEND
];

const AUDITOR_PERMISSIONS = [
  PERMISSIONS.FINANCE_VIEW,
  PERMISSIONS.FINANCE_REPORTS_RECEIPTS,
  PERMISSIONS.SUPPORT_SEND
];

export const ROLES = Object.freeze({
  administrator: Object.freeze({
    key: 'administrator',
    label: 'Administrator',
    description: 'Full access to website, finance, directory, settings, and administrator management.',
    permissions: Object.freeze(Object.values(PERMISSIONS))
  }),
  website_editor: Object.freeze({
    key: 'website_editor',
    label: 'Site Editor',
    description: 'Manages website content, communications, directory records, and general settings. No finance or administrator management.',
    permissions: Object.freeze(WEBSITE_PERMISSIONS)
  }),
  finance_entry: Object.freeze({
    key: 'finance_entry',
    label: 'Finance Entry',
    description: 'Views finance, records transactions, maintains donor and contact information, and uses support.',
    permissions: Object.freeze(FINANCE_ENTRY_PERMISSIONS)
  }),
  treasurer: Object.freeze({
    key: 'treasurer',
    label: 'Finance Officer',
    description: 'Broad finance, fund, donor, statement, report, export, and control access. No website or administrator management.',
    permissions: Object.freeze(TREASURER_PERMISSIONS)
  }),
  auditor: Object.freeze({
    key: 'auditor',
    label: 'Auditor',
    description: 'Read-only finance and report access, plus Help & Support. No create, edit, void, export, approval, or administrator management.',
    permissions: Object.freeze(AUDITOR_PERMISSIONS)
  })
});

export const ROLE_KEYS = Object.freeze(Object.keys(ROLES));

export function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (role === 'master' || role === 'master_admin' || role === 'master_administrator' || role === 'admin') return 'administrator';
  if (role === 'site_editor' || role === 'editor' || role === 'website_manager') return 'website_editor';
  if (role === 'finance_officer' || role === 'finance') return 'treasurer';
  return Object.hasOwn(ROLES, role) ? role : '';
}

export function permissionsForRole(value) {
  const role = normalizeRole(value);
  return role ? [...ROLES[role].permissions] : [];
}

export function roleHasPermission(role, permission) {
  return permissionsForRole(role).includes(String(permission || ''));
}

export function publicRoleDefinitions() {
  return ROLE_KEYS.map((key) => ({
    key,
    label: ROLES[key].label,
    description: ROLES[key].description,
    permissions: [...ROLES[key].permissions]
  }));
}
