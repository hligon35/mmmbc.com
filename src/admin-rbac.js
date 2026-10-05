export const PERMISSIONS = Object.freeze({
  ANNOUNCEMENTS_VIEW: 'announcements.view',
  ANNOUNCEMENTS_MANAGE: 'announcements.manage',
  EVENTS_VIEW: 'events.view',
  EVENTS_MANAGE: 'events.manage',
  PHOTOS_VIEW: 'photos.view',
  PHOTOS_MANAGE: 'photos.manage',
  NEWSLETTER_VIEW: 'newsletter.view',
  NEWSLETTER_MANAGE: 'newsletter.manage',
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

const DIRECTORY_ASSISTANT_PERMISSIONS = [
  PERMISSIONS.DIRECTORY_VIEW,
  PERMISSIONS.DIRECTORY_MANAGE,
  PERMISSIONS.SUPPORT_SEND
];

const TREASURER_PERMISSIONS = [
  PERMISSIONS.DIRECTORY_VIEW,
  PERMISSIONS.DIRECTORY_MANAGE,
  PERMISSIONS.SUPPORT_SEND
];

const AUDITOR_PERMISSIONS = [
  PERMISSIONS.SUPPORT_SEND
];

export const ROLES = Object.freeze({
  administrator: Object.freeze({
    key: 'administrator',
    label: 'Administrator',
    description: 'Full access to website, directory, settings, and administrator management.',
    permissions: Object.freeze(Object.values(PERMISSIONS))
  }),
  website_editor: Object.freeze({
    key: 'website_editor',
    label: 'Website Manager',
    description: 'Manages website operations, communications, directory records, and general settings. No administrator management.',
    permissions: Object.freeze(WEBSITE_PERMISSIONS)
  }),
  finance_entry: Object.freeze({
    key: 'finance_entry',
    label: 'Directory Assistant',
    description: 'Maintains directory contacts and uses support.',
    permissions: Object.freeze(DIRECTORY_ASSISTANT_PERMISSIONS)
  }),
  treasurer: Object.freeze({
    key: 'treasurer',
    label: 'Directory Manager',
    description: 'Manages directory contacts and uses support. No website or administrator management.',
    permissions: Object.freeze(TREASURER_PERMISSIONS)
  }),
  auditor: Object.freeze({
    key: 'auditor',
    label: 'Support Viewer',
    description: 'Help and Support access only.',
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
