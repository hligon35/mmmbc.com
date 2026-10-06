let csrfToken = '';
let csrfReady = Promise.resolve();
let sessionWarningVisible = false;

const API_FRIENDLY_STATUS = {
  400: 'Invalid request. Review the information and try again.',
  401: 'Your session has expired. Refresh your session or sign in again.',
  403: 'This action could not be completed because your session, permissions, or security token could not be verified.',
  404: 'The requested item could not be found.',
  409: 'This record was changed somewhere else. Refresh and try again.',
  413: 'The selected file is too large for this upload.',
  422: 'Please correct the highlighted information and try again.',
  429: 'Too many attempts were made. Wait a moment and try again.',
  500: 'The server could not complete this request.',
  503: 'The service is temporarily unavailable. Try again shortly.'
};

class ApiRequestError extends Error {
  constructor(message, { status = 0, requestId = '', retryable = false, sessionExpired = false, csrfFailed = false } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.requestId = requestId;
    this.retryable = retryable;
    this.sessionExpired = sessionExpired;
    this.csrfFailed = csrfFailed;
  }
}

function sanitizeApiMessage(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text
    .replace(/[A-Z]:\\[^\s]+/g, '')
    .replace(/\b(select|insert|update|delete|drop|create|alter)\b[^.]*?/ig, '')
    .replace(/(token|secret|password|key)\s*[:=]\s*[^\s]+/ig, '$1 [redacted]')
    .trim();
}

function buildApiErrorMessage(status, detail, requestId = '') {
  const fallback = API_FRIENDLY_STATUS[status] || 'The request could not be completed.';
  const safeDetail = sanitizeApiMessage(detail);
  const base = safeDetail || fallback;
  return requestId ? `${base} Request ID: ${requestId}` : base;
}

async function parseApiErrorResponse(res) {
  const requestId = String(res.headers.get('x-request-id') || '').trim();
  let bodyText = '';
  let jsonPayload = null;

  try {
    bodyText = await res.text();
  } catch {
    bodyText = '';
  }

  const trimmed = String(bodyText || '').trim();
  if (trimmed) {
    try {
      jsonPayload = JSON.parse(trimmed);
    } catch {
      jsonPayload = null;
    }
  }

  const detail = jsonPayload && typeof jsonPayload === 'object'
    ? String(jsonPayload.error || jsonPayload.message || '')
    : /<\s*(?:!doctype|html|head|body|title)\b/i.test(trimmed) ? '' : trimmed.slice(0, 500);
  const effectiveRequestId = requestId || String(jsonPayload?.requestId || '').trim();
  const message = buildApiErrorMessage(
    res.status,
    detail || res.statusText || '',
    effectiveRequestId
  );
  const lowerDetail = String(detail || '').toLowerCase();

  return new ApiRequestError(message, {
    status: res.status,
    requestId: effectiveRequestId,
    retryable: res.status === 401 || (res.status === 403 && /csrf|session|security token|sign in|unauthoriz/.test(lowerDetail)),
    sessionExpired: res.status === 401 || (res.status === 403 && /session|sign in|unauthoriz/.test(lowerDetail)),
    csrfFailed: res.status === 403 && /csrf|security token/.test(lowerDetail)
  });
}

function ensureSessionWarningUi() {
  if (typeof document === 'undefined') return null;
  let root = $('sessionWarning');
  if (root) return root;

  root = document.createElement('section');
  root.id = 'sessionWarning';
  root.className = 'sessionWarning card';
  root.hidden = true;
  root.setAttribute('role', 'alert');
  root.setAttribute('aria-live', 'assertive');
  root.innerHTML = `
    <div class="sessionWarning__body">
      <h2 class="sessionWarning__title">Session attention required</h2>
      <p class="sessionWarning__message" id="sessionWarningMessage">Your session needs attention.</p>
    </div>
    <div class="sessionWarning__actions">
      <button class="btn actionIconBtn" id="sessionWarningRefreshBtn" type="button" aria-label="Refresh session" title="Refresh session"><span class="material-icons-round" aria-hidden="true">refresh</span></button>
      <button class="btn btn--primary" id="sessionWarningSignInBtn" type="button">Sign in again</button>
    </div>
  `;

  const app = $('app');
  if (app && app.parentNode) app.parentNode.insertBefore(root, app);
  else document.body.insertBefore(root, document.body.firstChild);

  const refreshBtn = $('sessionWarningRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const message = $('sessionWarningMessage');
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      if (message) message.textContent = 'Refreshing your session…';
      try {
        csrfToken = '';
        csrfReady = fetchCsrfToken({ throwOnFailure: true });
        await csrfReady;
        hideSessionWarning();
        await initializeSession();
      } catch (err) {
        if (message) message.textContent = err instanceof Error ? err.message : 'Session refresh failed.';
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }

  const signInBtn = $('sessionWarningSignInBtn');
  if (signInBtn) {
    signInBtn.addEventListener('click', () => {
      window.location.hash = '';
      window.location.reload();
    });
  }

  return root;
}

function showSessionWarning(message) {
  const root = ensureSessionWarningUi();
  if (!root) return;
  const text = $('sessionWarningMessage');
  if (text) text.textContent = message;
  root.hidden = false;
  sessionWarningVisible = true;
}

function hideSessionWarning() {
  const root = $('sessionWarning');
  if (!root) return;
  root.hidden = true;
  sessionWarningVisible = false;
}

function getSessionWarningVisible() {
  return sessionWarningVisible;
}

async function fetchCsrfToken({ throwOnFailure = false } = {}) {
  try {
    const res = await fetch('/api/csrf', { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) {
      const err = await parseApiErrorResponse(res);
      csrfToken = '';
      if (throwOnFailure) throw err;
      return '';
    }
    const data = await res.json();
    csrfToken = String(data?.csrfToken || '');
    if (!csrfToken) {
      const err = new ApiRequestError(buildApiErrorMessage(403, 'A security token could not be created.'), {
        status: 403,
        retryable: true,
        csrfFailed: true
      });
      if (throwOnFailure) throw err;
      return '';
    }
    hideSessionWarning();
    return csrfToken;
  } catch (err) {
    csrfToken = '';
    if (throwOnFailure) throw err;
    return '';
  }
}

async function api(path, options = {}) {
  let url = String(path || '');
  // Ensure we always hit the root API, even when the admin UI is served under /admin/.
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) url = `/${url}`;

  const method = String(options.method || 'GET').toUpperCase();
  const needsCsrf = url.startsWith('/api/')
    && !['GET', 'HEAD', 'OPTIONS'].includes(method)
    ;

  const isFormData = options.body instanceof FormData;
  const createHeaders = () => ({
    ...(options.headers || {}),
    ...(isFormData ? {} : { 'Content-Type': 'application/json' })
  });

  const ensureCsrfToken = async () => {
    await csrfReady;
    if (!csrfToken) {
      csrfReady = fetchCsrfToken({ throwOnFailure: true });
      await csrfReady;
    }
    if (!csrfToken) {
      throw new ApiRequestError(buildApiErrorMessage(403, 'A valid security token is required before saving changes.'), {
        status: 403,
        retryable: true,
        csrfFailed: true
      });
    }
  };

  if (needsCsrf) await ensureCsrfToken();

  const doRequest = async (headers) => {
    const res = await fetch(url, {
      headers,
      credentials: 'same-origin',
      ...options
    });
    if (!res.ok) throw await parseApiErrorResponse(res);
    const bodyText = await res.text();
    if (!bodyText) return null;
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (isJson) {
      try {
        return JSON.parse(bodyText);
      } catch {
        return null;
      }
    }
    return bodyText;
  };

  try {
    const headers = createHeaders();
    if (needsCsrf) headers['X-CSRF-Token'] = csrfToken;
    return await doRequest(headers);
  } catch (err) {
    if (!(err instanceof ApiRequestError)) throw err;
    if (!(needsCsrf && err.retryable)) {
      if (err.sessionExpired || err.csrfFailed) showSessionWarning(err.message);
      throw err;
    }

    csrfToken = '';
    csrfReady = fetchCsrfToken({ throwOnFailure: true });

    try {
      await csrfReady;
      const retryHeaders = createHeaders();
      retryHeaders['X-CSRF-Token'] = csrfToken;
      hideSessionWarning();
      return await doRequest(retryHeaders);
    } catch (retryErr) {
      const finalErr = retryErr instanceof ApiRequestError
        ? retryErr
        : new ApiRequestError('The request could not be completed.', { status: 500 });
      showSessionWarning(finalErr.message);
      throw finalErr;
    }
  }
}

function $(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function validateUploadFiles(fileList, {
  maxFileBytes = 0,
  maxFiles = 0,
  allowedMimes = null,
  label = 'file'
} = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) return `${label[0].toUpperCase()}${label.slice(1)} selection is required.`;
  if (maxFiles > 0 && files.length > maxFiles) {
    return `You can upload up to ${maxFiles} ${label}${maxFiles === 1 ? '' : 's'} at a time.`;
  }

  for (const file of files) {
    const mimeType = String(file?.type || '').toLowerCase();
    if (allowedMimes instanceof Set && allowedMimes.size > 0 && !allowedMimes.has(mimeType)) {
      return `Unsupported ${label} type for ${String(file?.name || 'selected file')}.`;
    }
    const size = Number(file?.size || 0);
    if (maxFileBytes > 0 && size > maxFileBytes) {
      return `${String(file?.name || 'Selected file')} exceeds the ${formatBytes(maxFileBytes)} size limit.`;
    }
  }

  return '';
}

let syncProgressHideTimer = null;
const NAV_DRAWER_OPEN_KEY = 'mmmbc_admin_drawer_open_v1';
const NAV_DRAWER_COLLAPSE_KEY = 'mmmbc_admin_nav_drawer_collapsed_v1';
const APPEARANCE_PREF_KEY = 'mmmbc_admin_appearance_v1';
const USERS_MANAGE_PERMISSION = 'users.manage';
const SECTION_PERMISSIONS = Object.freeze({
  'tab-content': 'announcements.view',
  'tab-ministries': 'settings.manage',
  'tab-events': 'events.view',
  'tab-photos': 'photos.view',
  'tab-newsletter': 'newsletter.view',
  'tab-submissions': 'submissions.view',
  'tab-directory': 'directory.view',
  'tab-support': 'support.send',
  'tab-settings': USERS_MANAGE_PERMISSION
});
// One route table serves hash links, /admin/<module> deep links, and historical
// aliases. Events live inside the combined Announcements & Events section.
const ADMIN_ROUTES = Object.freeze({
  home: { section: 'tab-home' },
  overview: { section: 'tab-home' },
  reports: { section: 'tab-home' },
  photos: { section: 'tab-photos', subTab: 'panel-photos-manage' },
  gallery: { section: 'tab-photos', subTab: 'panel-photos-manage' },
  content: { section: 'tab-content', subTab: 'panel-content-announcements' },
  announcements: { section: 'tab-content', subTab: 'panel-content-announcements' },
  events: { section: 'tab-content', subTab: 'panel-content-announcements' },
  calendar: { section: 'tab-content', subTab: 'panel-content-announcements' },
  schedule: { section: 'tab-content', subTab: 'panel-content-announcements' },
  'site-editor': { section: 'tab-content', subTab: 'panel-content-announcements' },
  bulletins: { section: 'tab-content', subTab: 'panel-content-bulletins' },
  ministries: { section: 'tab-ministries' },
  leadership: { section: 'tab-ministries' },
  profiles: { section: 'tab-ministries' },
  directory: { section: 'tab-directory' },
  contacts: { section: 'tab-directory', subTab: 'panel-directory-contacts' },
  subscribers: { section: 'tab-directory', subTab: 'panel-directory-subscribers' },
  groups: { section: 'tab-directory', subTab: 'panel-directory-groups' },
  submissions: { section: 'tab-submissions' },
  mail: { section: 'tab-submissions' },
  mailbox: { section: 'tab-submissions' },
  inbox: { section: 'tab-submissions' },
  messages: { section: 'tab-submissions' },
  rentals: { section: 'tab-submissions', typeFilter: 'facility_rental' },
  newsletter: { section: 'tab-newsletter' },
  support: { section: 'tab-support' },
  help: { section: 'tab-support' },
  settings: { section: 'tab-settings' },
  access: { section: 'tab-settings' },
  users: { section: 'tab-settings' }
});
const SECTION_ALIASES = Object.freeze({ 'tab-events': 'tab-content' });
const SECTION_DEFAULT_SUBTABS = Object.freeze({
  'tab-photos': 'panel-photos-manage',
  'tab-content': 'panel-content-announcements',
  'tab-directory': 'panel-directory-contacts'
});
const SECTION_REFRESH_MS = 30000;

function resolveAdminRoute(pathname = window.location.pathname, hash = window.location.hash) {
  const hashKey = String(hash || '').replace(/^#/, '').split(/[/?]/)[0].trim().toLowerCase();
  const pathKey = (/^\/admin\/([^/]+)/.exec(String(pathname || '')) || [])[1] || '';
  const key = hashKey || String(pathKey).replace(/\.html$/, '').toLowerCase() || 'home';
  const route = Object.prototype.hasOwnProperty.call(ADMIN_ROUTES, key) ? ADMIN_ROUTES[key] : ADMIN_ROUTES.home;
  return { sectionId: route.section, subTabId: route.subTab || '', typeFilter: route.typeFilter || '' };
}

function canonicalRouteHash(sectionId, subTabId = '', typeFilter = '') {
  if (sectionId === 'tab-content') return subTabId === 'panel-content-bulletins' ? 'bulletins' : 'announcements';
  if (sectionId === 'tab-directory') {
    if (subTabId === 'panel-directory-subscribers') return 'subscribers';
    if (subTabId === 'panel-directory-groups') return 'groups';
    return 'directory';
  }
  if (sectionId === 'tab-submissions' && typeFilter === 'facility_rental') return 'rentals';
  return String(sectionId || 'tab-home').replace(/^tab-/, '');
}

let currentPermissions = new Set();
let submissionsTypeFilter = 'all';
let submissionsSearchTimer = 0;
const UNSAVED_WARNING_TEXT = 'You have unsaved changes. Leave this page without saving them?';
const NEWSLETTER_BODY_TEMPLATE = [
  'Week of date',
  '',
  'Header',
  '',
  'Welcome',
  '',
  'Announcements',
  '',
  'Events',
  '',
  'Ministry updates',
  '',
  'Pastor message',
  '',
  'Contact line',
  '',
  'Footer line'
].join('\n');
const NEWSLETTER_TEMPLATE_SECTIONS = [
  'Week of date',
  'Header',
  'Welcome',
  'Announcements',
  'Events',
  'Ministry updates',
  'Pastor message',
  'Contact line',
  'Footer line'
];
const NEWSLETTER_SECTION_ALIASES = {
  'header and welcome': 'Welcome',
  'announcements and events': 'Announcements',
  'ministry updates and pastor message': 'Ministry updates',
  'giving, contact, and footer': 'Contact line'
};
const NEWSLETTER_SECTION_FIELDS = [
  { heading: 'Week of date', fieldId: 'newsletterWeekOfDate' },
  { heading: 'Header', fieldId: 'newsletterSectionHeader' },
  { heading: 'Welcome', fieldId: 'newsletterSectionWelcome' },
  { heading: 'Announcements', fieldId: 'newsletterSectionAnnouncements' },
  { heading: 'Events', fieldId: 'newsletterSectionEvents' },
  { heading: 'Ministry updates', fieldId: 'newsletterSectionMinistryUpdates' },
  { heading: 'Pastor message', fieldId: 'newsletterSectionPastorMessage' },
  { heading: 'Contact line', fieldId: 'newsletterSectionContactLine' },
  { heading: 'Footer line', fieldId: 'newsletterSectionFooterLine' }
];
const unsavedSnapshots = new Map();
const unsavedDirtyForms = new Set();
const unsavedFileSelections = new Set();
const formUploadsInProgress = new Set();
const programmaticFormUpdates = new Set();
const PHOTO_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const PHOTO_UPLOAD_MAX_FILES = 20;
const BULLETIN_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_UPLOAD_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const BULLETIN_UPLOAD_MIME_TYPES = new Set(['application/pdf', ...IMAGE_UPLOAD_MIME_TYPES]);
let adminDrawerOpen = false;
let adminDrawerRestoreFocus = null;
let adminHeaderNavCollapsed = false;
let adminHeaderNavLayoutFrame = 0;
const dialogFocusRestoreTargets = new WeakMap();

function getHeaderNavRequirements() {
  const header = $('adminHeader');
  const logo = header?.querySelector('.adminHeader__logo');
  const breadcrumbs = $('adminHeaderBreadcrumbs');
  const navButtons = Array.from(document.querySelectorAll('#adminSideNav .tab--nav'));
  if (!header || !logo || !breadcrumbs || !navButtons.length) return 0;

  const logoWidth = Math.ceil(logo.getBoundingClientRect().width || 0);
  const breadcrumbsWidth = Math.ceil(breadcrumbs.scrollWidth || breadcrumbs.getBoundingClientRect().width || 0);

  // Mirror canonical desktop sizing: each nav tab has a 160px minimum plus 10px gaps.
  const navWidth = (navButtons.length * 160) + (Math.max(0, navButtons.length - 1) * 10);

  // Include gutters/account spacing so we collapse before any visual collision.
  return logoWidth + breadcrumbsWidth + navWidth + 120;
}

function renderDrawerToggleButton(btn, isOpen) {
  if (!(btn instanceof HTMLElement)) return;
  const label = isOpen ? 'Close menu' : 'Open menu';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = [
    '<span class="drawerToggleBars" aria-hidden="true"><span></span><span></span><span></span></span>',
    `<span class="srOnly">${escapeHtml(label)}</span>`
  ].join('');
}

function syncHeaderActionOrder(collapsed) {
  const header = $('adminHeader');
  const account = header?.querySelector('.adminHeader__account');
  const actions = header?.querySelector('.headerActions');
  const authStatus = $('authStatus');
  const drawerBtn = $('navDrawerToggle');
  const logoutBtn = $('logoutBtn');
  if (!header || !(actions instanceof HTMLElement) || !(drawerBtn instanceof HTMLElement)) return;

  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
  const compactMobile = collapsed && viewportWidth <= 900;

  header.classList.toggle('adminHeader--navCollapsed', !!collapsed);
  actions.classList.toggle('headerActions--compactNav', !!collapsed);

  if (!collapsed) {
    if (logoutBtn instanceof HTMLElement && logoutBtn.parentElement !== actions) {
      actions.appendChild(logoutBtn);
    }
    return;
  }

  if (compactMobile && logoutBtn instanceof HTMLElement && account instanceof HTMLElement) {
    if (authStatus instanceof HTMLElement && authStatus.parentElement === account) {
      authStatus.insertAdjacentElement('afterend', logoutBtn);
    } else if (logoutBtn.parentElement !== account) {
      account.appendChild(logoutBtn);
    }
  } else if (logoutBtn instanceof HTMLElement) {
    if (logoutBtn.parentElement !== actions) {
      actions.appendChild(logoutBtn);
    }
    actions.appendChild(logoutBtn);
  }

  actions.appendChild(drawerBtn);
}

function syncHeaderNavLayout() {
  const header = $('adminHeader');
  if (!header || header.hidden) return;

  const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
  const desktop = viewportWidth > 900;
  let shouldCollapse = !desktop;

  if (desktop) {
    const required = getHeaderNavRequirements();
    shouldCollapse = required > viewportWidth;
  }

  const changed = adminHeaderNavCollapsed !== shouldCollapse;
  adminHeaderNavCollapsed = shouldCollapse;
  document.body.classList.toggle('adminHeaderNavCollapsed', shouldCollapse);
  syncHeaderActionOrder(shouldCollapse);

  if (changed && !shouldCollapse && adminDrawerOpen) {
    setAdminDrawerOpen(false, { restoreFocus: false });
  }

  if (changed && shouldCollapse && adminDrawerOpen) {
    setAdminDrawerOpen(false, { restoreFocus: false });
  }

  updateLayoutMetrics();
}

function queueHeaderNavLayoutSync() {
  if (adminHeaderNavLayoutFrame) {
    window.cancelAnimationFrame(adminHeaderNavLayoutFrame);
  }
  adminHeaderNavLayoutFrame = window.requestAnimationFrame(() => {
    adminHeaderNavLayoutFrame = 0;
    syncHeaderNavLayout();
  });
}

function updateHeaderBumper() {
  const header = document.querySelector?.('.header');
  if (!header) return;
  try {
    const headerRect = header.getBoundingClientRect();
    const tabs = $('adminHeaderTabs');
    const tabsRect = tabs && !tabs.hidden && getComputedStyle(tabs).display !== 'none'
      ? tabs.getBoundingClientRect()
      : null;
    const stackBottom = Math.max(
      0,
      Math.round(headerRect.bottom || 0),
      Math.round(tabsRect?.bottom || 0)
    );
    const h = stackBottom;
    document.documentElement.style.setProperty('--header-bumper', `${h}px`);
    document.documentElement.style.setProperty('--admin-header-height', `${h}px`);
  } catch {
    // ignore
  }
}

function updateLayoutMetrics() {
  updateHeaderBumper();
  const extension = $('adminSectionExtension');
  const hasVisibleExtension = extension && !extension.hidden;
  const extensionHeight = hasVisibleExtension
    ? Math.max(0, Math.round(extension.getBoundingClientRect().height || 0))
    : 0;
  document.documentElement.style.setProperty('--admin-section-extension-height', `${extensionHeight}px`);
}

function setAuthenticatedHeaderVisible(isAuthenticated) {
  const header = $('adminHeader');
  if (!header) return;
  header.hidden = !isAuthenticated;
  if (!isAuthenticated) {
    setAdminDrawerOpen(false, { restoreFocus: false });
  }
  updateLayoutMetrics();
  if (isAuthenticated) queueHeaderNavLayoutSync();
}

function getStoredDrawerPreference() {
  try {
    const openPref = window.localStorage.getItem(NAV_DRAWER_OPEN_KEY);
    if (openPref === '1') return true;
    if (openPref === '0') return false;

    const legacyCollapsed = window.localStorage.getItem(NAV_DRAWER_COLLAPSE_KEY);
    if (legacyCollapsed === '0') return true;
    if (legacyCollapsed === '1') return false;
  } catch {
    // ignore storage issues
  }
  return false;
}

function setStoredDrawerPreference(isOpen) {
  try {
    window.localStorage.setItem(NAV_DRAWER_OPEN_KEY, isOpen ? '1' : '0');
    // Keep legacy key aligned so old clients and tests behave consistently.
    window.localStorage.setItem(NAV_DRAWER_COLLAPSE_KEY, isOpen ? '0' : '1');
  } catch {
    // ignore storage issues
  }
}

function trapDrawerFocus(ev) {
  if (!adminDrawerOpen || ev.key !== 'Tab') return;
  const drawer = $('adminSideNav');
  if (!drawer) return;
  const nodes = Array.from(drawer.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.hasAttribute('disabled'));
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;

  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

function setAdminDrawerOpen(isOpen, { restoreFocus = true } = {}) {
  const drawer = $('adminSideNav');
  const backdrop = $('adminDrawerBackdrop');
  const btn = $('navDrawerToggle');
  if (!drawer || !backdrop || !btn) return;

  const next = !!isOpen;
  adminDrawerOpen = next;

  if (next) {
    adminDrawerRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  document.body.classList.toggle('adminDrawerOpen', next);
  drawer.classList.toggle('adminDrawer--open', next);
  drawer.setAttribute('aria-hidden', next ? 'false' : 'true');
  drawer.setAttribute('tabindex', next ? '0' : '-1');
  backdrop.hidden = !next;

  btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  renderDrawerToggleButton(btn, next);

  setStoredDrawerPreference(next);

  if (next) {
    const first = drawer.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])');
    if (first instanceof HTMLElement) first.focus();
  } else if (restoreFocus) {
    const focusTarget = adminDrawerRestoreFocus instanceof HTMLElement ? adminDrawerRestoreFocus : btn;
    focusTarget.focus();
  }
}

function openManagedDialog(dialogEl, { initialFocusId = '' } = {}) {
  if (!(dialogEl instanceof HTMLElement)) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active) dialogFocusRestoreTargets.set(dialogEl, active);

  dialogEl.setAttribute('aria-modal', 'true');
  if (dialogEl instanceof HTMLDialogElement && typeof dialogEl.showModal === 'function') {
    try {
      if (!dialogEl.open) dialogEl.showModal();
    } catch {
      dialogEl.setAttribute('open', '');
    }
  } else {
    dialogEl.setAttribute('open', '');
  }

  if (initialFocusId) {
    const focusTarget = $(initialFocusId);
    if (focusTarget instanceof HTMLElement) {
      try { focusTarget.focus(); } catch { /* ignore */ }
    }
  }
}

function closeManagedDialog(dialogEl, { restoreFocus = true } = {}) {
  if (!(dialogEl instanceof HTMLElement)) return;

  try {
    if (dialogEl instanceof HTMLDialogElement && typeof dialogEl.close === 'function') {
      if (dialogEl.open) dialogEl.close();
    } else {
      dialogEl.removeAttribute('open');
    }
  } catch {
    dialogEl.removeAttribute('open');
  }

  if (!restoreFocus) return;
  const previous = dialogFocusRestoreTargets.get(dialogEl);
  if (previous instanceof HTMLElement) {
    try { previous.focus(); } catch { /* ignore */ }
  }
}

function wireDialogDismissBehavior(dialogEl, { onClose = null } = {}) {
  if (!(dialogEl instanceof HTMLElement)) return;
  const closeHandler = typeof onClose === 'function' ? onClose : () => closeManagedDialog(dialogEl);

  dialogEl.addEventListener('click', (e) => {
    if (e.target !== dialogEl) return;
    e.preventDefault();
    closeHandler();
  });

  dialogEl.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeHandler();
  });
}

function closeDrawerAfterNavigation() {
  if (!adminDrawerOpen) return;
  setAdminDrawerOpen(false, { restoreFocus: true });
}

function getAppearancePreference() {
  try {
    const value = String(window.localStorage.getItem(APPEARANCE_PREF_KEY) || '').trim().toLowerCase();
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // ignore storage errors
  }
  return 'light';
}

function applyAppearancePreference(pref) {
  const selected = (pref === 'dark' || pref === 'system') ? pref : 'light';
  document.body.classList.remove('theme-light', 'theme-dark', 'theme-system');
  document.body.classList.add(`theme-${selected}`);

  if (selected === 'system') {
    try {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.body.classList.toggle('theme-effective-dark', !!prefersDark);
      document.body.classList.toggle('theme-effective-light', !prefersDark);
      document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light';
    } catch {
      document.body.classList.remove('theme-effective-dark');
      document.body.classList.add('theme-effective-light');
      document.documentElement.style.colorScheme = 'light';
    }
  } else {
    document.body.classList.toggle('theme-effective-dark', selected === 'dark');
    document.body.classList.toggle('theme-effective-light', selected === 'light');
    document.documentElement.style.colorScheme = selected === 'dark' ? 'dark' : 'light';
  }

  syncAppearanceControls(selected);
}

function syncAppearanceControls(selected) {
  const mode = (selected === 'dark' || selected === 'system') ? selected : 'light';
  const select = $('appearanceSelect');
  if (select) select.value = mode;
  document.querySelectorAll('[data-appearance-mode]').forEach((button) => {
    const buttonMode = String(button.getAttribute('data-appearance-mode') || '').toLowerCase();
    button.setAttribute('aria-pressed', buttonMode === mode ? 'true' : 'false');
  });
}

function fileSignature(file) {
  if (!file) return '';
  return [
    String(file.name || ''),
    Number(file.size) || 0,
    Number(file.lastModified) || 0
  ].join(':');
}

function serializeFormState(form) {
  const fields = [];
  const files = [];
  const elements = Array.from(form.elements || []);
  for (const el of elements) {
    if (!el) continue;
    if (el.disabled) continue;
    const key = String(el.name || el.id || '').trim();
    if (!key) continue;
    if (el.type === 'file') {
      const selectedFiles = Array.from(el.files || []);
      files.push({
        key,
        count: selectedFiles.length,
        files: selectedFiles.map((file) => fileSignature(file))
      });
      continue;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      fields.push(`${key}:${el.checked ? '1' : '0'}`);
      continue;
    }
    fields.push(`${key}:${String(el.value || '')}`);
  }
  return JSON.stringify({ fields, files });
}

function parseSerializedFormState(snapshot) {
  if (!snapshot) return { fields: [], files: [] };
  try {
    const parsed = JSON.parse(snapshot);
    return {
      fields: Array.isArray(parsed?.fields) ? parsed.fields : [],
      files: Array.isArray(parsed?.files) ? parsed.files : []
    };
  } catch {
    return { fields: [String(snapshot)], files: [] };
  }
}

function hasSelectedFiles(snapshot) {
  return Array.isArray(snapshot?.files) && snapshot.files.some((entry) => Number(entry?.count) > 0);
}

function markFormUploadState(formOrId, uploading) {
  const formId = typeof formOrId === 'string'
    ? formOrId
    : String(formOrId?.id || '').trim();
  if (!formId) return;
  if (uploading) formUploadsInProgress.add(formId);
  else formUploadsInProgress.delete(formId);
}

function withProgrammaticFormUpdate(form, applyChanges, { resetBaseline = true } = {}) {
  if (!(form instanceof HTMLFormElement)) {
    applyChanges();
    return;
  }
  programmaticFormUpdates.add(form.id);
  try {
    applyChanges();
  } finally {
    if (resetBaseline) resetUnsavedBaseline(form);
    programmaticFormUpdates.delete(form.id);
  }
}

function resetUnsavedBaseline(form) {
  if (!(form instanceof HTMLFormElement) || !form.id) return;
  unsavedSnapshots.set(form.id, serializeFormState(form));
  unsavedDirtyForms.delete(form.id);
  unsavedFileSelections.delete(form.id);
  formUploadsInProgress.delete(form.id);
}

function updateUnsavedForForm(form) {
  if (!(form instanceof HTMLFormElement) || !form.id) return;
  if (programmaticFormUpdates.has(form.id)) return;
  const baseline = unsavedSnapshots.get(form.id);
  if (baseline === undefined) {
    resetUnsavedBaseline(form);
    return;
  }
  const current = parseSerializedFormState(serializeFormState(form));
  const previous = parseSerializedFormState(baseline);

  if (JSON.stringify(current.fields) !== JSON.stringify(previous.fields)) unsavedDirtyForms.add(form.id);
  else unsavedDirtyForms.delete(form.id);

  if (JSON.stringify(current.files) !== JSON.stringify(previous.files) && hasSelectedFiles(current)) {
    unsavedFileSelections.add(form.id);
  } else {
    unsavedFileSelections.delete(form.id);
  }
}

function hasUnsavedChanges() {
  return unsavedDirtyForms.size > 0 || unsavedFileSelections.size > 0 || formUploadsInProgress.size > 0;
}

function unsavedChangeMessage() {
  if (formUploadsInProgress.size > 0) {
    return 'An upload is still in progress. Leave this page and interrupt the upload?';
  }
  if (unsavedFileSelections.size > 0 && unsavedDirtyForms.size > 0) {
    return 'You have unsaved changes and selected files that have not been uploaded. Leave this page without saving them?';
  }
  if (unsavedFileSelections.size > 0) {
    return 'You selected file changes that have not been uploaded yet. Leave this page without uploading them?';
  }
  return UNSAVED_WARNING_TEXT;
}

function confirmUnsavedChanges() {
  if (!hasUnsavedChanges()) return true;
  return confirmWrite(unsavedChangeMessage());
}

function resetAllUnsavedBaselines() {
  const forms = document.querySelectorAll('form[id]');
  for (const form of Array.from(forms)) {
    if (form instanceof HTMLFormElement) resetUnsavedBaseline(form);
  }
}

function resetTransientUiState() {
  // Covers initial load AND BFCache restores (where DOMContentLoaded may not fire).
  if (syncProgressHideTimer) {
    try { window.clearTimeout(syncProgressHideTimer); } catch { /* ignore */ }
    syncProgressHideTimer = null;
  }
  setSyncProgress({ visible: false, text: '' });

  try { photoSelectedIds.clear(); } catch { /* ignore */ }
  try {
    const checks = Array.from(document.querySelectorAll('.thumb__check'));
    for (const cb of checks) {
      if (cb instanceof HTMLInputElement) cb.checked = false;
    }
    const selected = Array.from(document.querySelectorAll('.thumb--selected'));
    for (const el of selected) {
      try { el.classList.remove('thumb--selected'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  try {
    const bar = $('photoBulkBar');
    if (bar) {
      bar.hidden = true;
      bar.dataset.stickyTopSet = '0';
    }
  } catch { /* ignore */ }
}

function setSyncProgress({ visible, indeterminate, value, max, text } = {}) {
  const wrap = $('syncProgressWrap');
  const meter = $('syncProgressMeter');
  const label = $('syncProgressText');

  if (wrap) wrap.hidden = !visible;
  if (label) label.textContent = String(text || '');
  if (!meter) return;

  if (indeterminate) {
    try { meter.removeAttribute('value'); } catch { /* ignore */ }
    return;
  }

  const m = Number(max);
  const v = Number(value);
  if (Number.isFinite(m) && m > 0) meter.max = m;
  if (Number.isFinite(v) && v >= 0) meter.value = v;
}

function safeResetForm(e) {
  const form = e?.currentTarget || e?.target?.closest?.('form');
  if (form && typeof form.reset === 'function') {
    form.reset();
    window.setTimeout(() => resetUnsavedBaseline(form), 0);
  }
}

const TOAST_DEFAULT_MS = 5000;

function showToast(message, { variant = 'success', timeoutMs = TOAST_DEFAULT_MS } = {}) {
  const text = String(message || '').trim();
  if (!text) return;

  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toastContainer';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast--${variant}`;
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
  const label = document.createElement('span');
  label.className = 'toast__text';
  label.textContent = text;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = '\u00d7';
  toast.append(label, dismiss);
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('toast--show'));

  const remove = () => {
    toast.classList.remove('toast--show');
    setTimeout(() => {
      try { toast.remove(); } catch { /* ignore */ }
      if (container && container.childElementCount === 0) {
        try { container.remove(); } catch { /* ignore */ }
      }
    }, 220);
  };

  let timer = setTimeout(remove, Math.max(500, Number(timeoutMs) || 0));
  // Hovering or focusing a toast keeps it open so it can be read or dismissed.
  const hold = () => clearTimeout(timer);
  const resume = () => { timer = setTimeout(remove, 2000); };
  toast.addEventListener('mouseenter', hold);
  toast.addEventListener('mouseleave', resume);
  toast.addEventListener('focusin', hold);
  toast.addEventListener('focusout', resume);
  dismiss.addEventListener('click', remove);
  toast.addEventListener('click', (event) => { if (event.target === toast || event.target === label) remove(); });
}

function announceLive(message) {
  const live = $('adminLiveRegion');
  if (!live) return;
  live.textContent = '';
  window.setTimeout(() => {
    live.textContent = String(message || '');
  }, 20);
}

function confirmWrite(message) {
  return confirm(message || 'Save changes?');
}

function uniqStringsLower(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (list || [])) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function toTime24(hour12, minute, ampm) {
  const h = Number(hour12);
  const minuteRaw = String(minute || '').trim();
  if (minuteRaw === '') return '';
  const minuteNum = Number(minuteRaw);
  if (!Number.isFinite(minuteNum) || minuteNum < 0 || minuteNum > 59) return '';
  const m = String(Math.floor(minuteNum)).padStart(2, '0');
  const a = String(ampm || '').toUpperCase();
  if (!h || h < 1 || h > 12) return '';
  if (!/^\d{2}$/.test(m)) return '';
  if (a !== 'AM' && a !== 'PM') return '';

  let hour = h % 12;
  if (a === 'PM') hour += 12;
  return `${String(hour).padStart(2, '0')}:${m}`;
}

function fromTime24(value) {
  const t = String(value || '').trim();
  const m = t.match(/^([0-2]\d):([0-5]\d)/);
  if (!m) return null;
  const hour24 = Number(m[1]);
  const minute = m[2];
  if (!Number.isFinite(hour24)) return null;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour12: String(hour12), minute, ampm };
}

function initTimePicker(pickerId, hiddenInputId, { required, defaultValue } = {}) {
  const root = $(pickerId);
  const hidden = $(hiddenInputId);
  if (!root || !hidden) return;

  root.innerHTML = '';

  const makeDatalist = (id, values) => {
    const dl = document.createElement('datalist');
    dl.id = id;
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = String(v);
      dl.appendChild(opt);
    }
    return dl;
  };

  const hour = document.createElement('input');
  hour.className = 'select';
  hour.setAttribute('aria-label', 'H');
  hour.setAttribute('inputmode', 'numeric');
  hour.setAttribute('autocomplete', 'off');
  hour.setAttribute('size', '2');
  hour.placeholder = required ? 'H' : 'Hour';

  const minute = document.createElement('input');
  minute.className = 'select';
  minute.setAttribute('aria-label', 'M');
  minute.setAttribute('inputmode', 'numeric');
  minute.setAttribute('autocomplete', 'off');
  minute.setAttribute('size', '2');
  minute.placeholder = required ? 'M' : 'Min';

  const ampm = document.createElement('input');
  ampm.className = 'select';
  ampm.setAttribute('aria-label', 'A/P');
  ampm.setAttribute('autocomplete', 'off');
  ampm.setAttribute('size', '4');
  ampm.placeholder = required ? 'AM/PM' : 'AM/PM';

  const hoursListId = `${pickerId}__hours`;
  const minutesListId = `${pickerId}__minutes`;
  const ampmListId = `${pickerId}__ampm`;

  hour.setAttribute('list', hoursListId);
  minute.setAttribute('list', minutesListId);
  ampm.setAttribute('list', ampmListId);

  const hours = [];
  for (let h = 1; h <= 12; h += 1) hours.push(String(h));
  const minutes = [];
  for (let m = 0; m <= 59; m += 1) minutes.push(String(m).padStart(2, '0'));
  const ampmVals = ['AM', 'PM'];

  root.appendChild(hour);
  root.appendChild(minute);
  root.appendChild(ampm);
  root.appendChild(makeDatalist(hoursListId, hours));
  root.appendChild(makeDatalist(minutesListId, minutes));
  root.appendChild(makeDatalist(ampmListId, ampmVals));

  const syncToHidden = () => {
    const v = toTime24(hour.value, minute.value, ampm.value);
    hidden.value = v;
  };

  const syncFromHidden = () => {
    const parsed = fromTime24(hidden.value);
    if (!parsed) return;
    hour.value = parsed.hour12;
    minute.value = parsed.minute;
    ampm.value = parsed.ampm;
  };

  hour.addEventListener('input', syncToHidden);
  minute.addEventListener('input', syncToHidden);
  ampm.addEventListener('input', syncToHidden);
  hour.addEventListener('change', syncToHidden);
  minute.addEventListener('change', syncToHidden);
  ampm.addEventListener('change', syncToHidden);

  // Initialize
  if (hidden.value) {
    syncFromHidden();
    syncToHidden();
  } else if (defaultValue) {
    hidden.value = String(defaultValue);
    syncFromHidden();
    syncToHidden();
  } else {
    syncToHidden();
  }

  const form = root.closest('form');
  if (form && !form.dataset.timePickersWired) {
    form.addEventListener('reset', () => {
      // Let the browser reset other fields first.
      setTimeout(() => {
        if (defaultValue) {
          hidden.value = String(defaultValue);
          syncFromHidden();
          syncToHidden();
        } else {
          hidden.value = '';
          if (!required) {
            hour.value = '';
            minute.value = '';
            ampm.value = '';
          }
          syncToHidden();
        }
      }, 0);
    });
    form.dataset.timePickersWired = '1';
  }
}

function getInitials(user) {
  const name = String(user?.name || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || 'A';
    const b = parts[1]?.[0] || '';
    return (a + b).toUpperCase();
  }
  const email = String(user?.email || '').trim();
  if (!email) return 'A';
  return String(email[0] || 'A').toUpperCase();
}

function formatUserRoleLabel(roleValue) {
  const role = String(roleValue || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (role === 'master_admin' || role === 'master') return 'Master Admin';
  if (role === 'administrator' || role === 'admin') return 'Administrator';
  if (role === 'finance_officer') return 'Directory Manager';
  if (role === 'finance_entry' || role === 'financeentry' || role === 'finance') return 'Directory Assistant';
  if (role === 'treasurer') return 'Directory Manager';
  if (role === 'auditor') return 'Support Viewer';
  if (role === 'site_editor') return 'Website Manager';
  if (role === 'website_editor' || role === 'editor' || role === 'website') return 'Website Manager';
  return role ? role.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()) : 'Member';
}

function isAdministratorRole(roleValue) {
  const role = String(roleValue || '').trim().toLowerCase().replace(/\s+/g, '_');
  return role === 'master_admin' || role === 'administrator' || role === 'admin';
}

function syncHeaderBreadcrumbs() {
  const root = $('adminHeaderBreadcrumbs');
  if (!root) return;

  const activeMainTab = document.querySelector('#adminSideNav .tab--nav[aria-selected="true"]');
  const activePanelId = String(activeMainTab?.getAttribute('aria-controls') || '').trim();
  const activePanel = activePanelId ? document.getElementById(activePanelId) : null;
  const crumbLabel = String(activePanel?.dataset?.headerCrumb || '').trim();

  if (crumbLabel) {
    const homeLink = document.createElement('a');
    homeLink.href = '#home';
    homeLink.className = 'pageContext__homeLink';
    homeLink.setAttribute('data-section-target', 'tab-home');
    homeLink.textContent = 'Home';

    root.replaceChildren(
      homeLink,
      document.createTextNode(' \u203a '),
      document.createTextNode(crumbLabel)
    );
    return;
  }

  const crumb = activePanel?.querySelector?.('.pageContext__crumb') || document.querySelector('.tabPanel:not([hidden]) .pageContext__crumb');
  if (crumb) {
    root.innerHTML = crumb.innerHTML;
    return;
  }

  root.innerHTML = '<a href="#home" class="pageContext__homeLink" data-section-target="tab-home">Home</a>';
}

function syncHeaderContextDescription() {
  const root = $('headerContextDescription');
  if (!root) return;

  const activeMainTab = document.querySelector('#adminSideNav .tab--nav[aria-selected="true"]');
  const activePanelId = String(activeMainTab?.getAttribute('aria-controls') || '').trim();
  const panel = activePanelId ? document.getElementById(activePanelId) : document.querySelector('.tabPanel:not([hidden])');
  const panelDescription = String(panel?.dataset?.headerDescription || '').trim();

  if (panelDescription) {
    root.textContent = panelDescription;
    return;
  }

  const context = panel?.querySelector?.('.pageContext');
  if (!context) {
    root.textContent = '';
    return;
  }

  const descriptions = Array.from(context.querySelectorAll('.pageContext__description'));
  const preferred = descriptions.find((node) => node.id !== 'homeWelcomeLine') || descriptions[0];
  root.textContent = String(preferred?.textContent || '').trim();
}

function setTab(activeId) {
  const tabButtons = [
    $('tabBtn-home'),
    $('tabBtn-photos'),
    $('tabBtn-events'),
    $('tabBtn-content'),
    $('tabBtn-ministries'),
    $('tabBtn-directory'),
    $('tabBtn-submissions'),
    $('tabBtn-newsletter'),
    $('tabBtn-support'),
    $('tabBtn-settings')
  ];
  const panels = [
    $('tab-home'),
    $('tab-photos'),
    $('tab-events'),
    $('tab-content'),
    $('tab-ministries'),
    $('tab-directory'),
    $('tab-submissions'),
    $('tab-newsletter'),
    $('tab-support'),
    $('tab-settings')
  ];

  tabButtons.forEach((b) => {
    if (!b) return;
    const isActive = b.getAttribute('aria-controls') === activeId;
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  panels.forEach((p) => {
    if (!p) return;
    p.hidden = p.id !== activeId;
  });

  // Keep Photo Gallery bulk actions scoped to the Photo tab.
  if (activeId !== 'tab-photos') {
    try { photoSelectedIds.clear(); } catch { /* ignore */ }
    try {
      const bar = $('photoBulkBar');
      if (bar) {
        bar.hidden = true;
        bar.dataset.stickyTopSet = '0';
      }
    } catch { /* ignore */ }
  }

  updateActiveSectionExtensions(activeId);
  document.body.classList.toggle('adminHomeSection', activeId === 'tab-home');
  updateLayoutMetrics();
}

function updateActiveSectionExtensions() {
  const extension = $('adminSectionExtension');

  if (extension) extension.hidden = true;
}

let activeRoute = { sectionId: '', subTabId: '' };
const sectionScroll = new Map();
const sectionLoadState = new Map();

function currentSectionLoaders() {
  const can = (permission) => currentPermissions.has(permission);
  return {
    'tab-photos': { run: () => (can('photos.view') ? loadGallery() : null) },
    'tab-content': {
      run: () => Promise.all([
        can('announcements.view') ? loadAnnouncements() : null,
        can('announcements.view') ? loadBulletins() : null,
        can('events.view') ? loadEvents() : null
      ])
    },
    'tab-newsletter': {
      run: () => (can('newsletter.view') ? Promise.all([loadSubscribers(), loadNewsletterRecords()]) : null)
    },
    'tab-submissions': { ttl: SECTION_REFRESH_MS, run: () => loadWebsiteSubmissions() },
    'tab-settings': { ttl: SECTION_REFRESH_MS, run: () => loadSettings() }
  };
}

// Loads a section's data once, de-duplicates in-flight work, and refreshes only
// when the section is stale or explicitly invalidated.
function ensureSectionData(sectionId, { force = false } = {}) {
  const loader = currentSectionLoaders()[sectionId];
  if (!loader) return Promise.resolve();
  const state = sectionLoadState.get(sectionId) || {};
  if (state.promise) return state.promise;
  const fresh = state.at && (loader.ttl === undefined || Date.now() - state.at < loader.ttl);
  if (!force && fresh) return Promise.resolve();
  const promise = Promise.resolve()
    .then(() => loader.run())
    .then(() => { sectionLoadState.set(sectionId, { at: Date.now() }); })
    .catch((error) => {
      sectionLoadState.set(sectionId, { at: 0 });
      console.error('Admin section failed to load', sectionId, error);
      const liveRegion = $('adminLiveRegion');
      if (liveRegion) liveRegion.textContent = 'Some admin data could not be loaded. Other sections remain available.';
    });
  sectionLoadState.set(sectionId, { ...state, promise });
  return promise;
}

function activateMainSection(sectionId, { subTabId = '', closeDrawer = false, updateHash = true, typeFilter = '' } = {}) {
  sectionId = SECTION_ALIASES[sectionId] || sectionId;
  if (!sectionId || !$(sectionId)) return false;
  const requiredPermission = SECTION_PERMISSIONS[sectionId];
  if (requiredPermission && !currentPermissions.has(requiredPermission)) {
    sectionId = 'tab-home';
    subTabId = '';
    typeFilter = '';
  }
  const sectionChanged = activeRoute.sectionId !== sectionId;
  const nextSubTab = subTabId || (sectionChanged ? (SECTION_DEFAULT_SUBTABS[sectionId] || '') : activeRoute.subTabId);
  const filterChanged = sectionId === 'tab-submissions' && !!typeFilter && typeFilter !== submissionsTypeFilter;

  if (!sectionChanged && nextSubTab === activeRoute.subTabId && !filterChanged) {
    if (closeDrawer) closeDrawerAfterNavigation();
    return true;
  }
  if (sectionChanged && activeRoute.sectionId && !window.MMWorkspaceEnabled && !confirmUnsavedChanges()) {
    syncRouteHash(activeRoute, { replace: true });
    return false;
  }

  if (sectionChanged && activeRoute.sectionId) sectionScroll.set(activeRoute.sectionId, window.scrollY);
  const previous = activeRoute;
  activeRoute = { sectionId, subTabId: nextSubTab };

  if (sectionChanged) setTab(sectionId);
  if (closeDrawer) closeDrawerAfterNavigation();

  if (sectionId === 'tab-content') setContentSubTab(nextSubTab);
  if (sectionId === 'tab-photos') setPhotosSubTab(nextSubTab);
  if (sectionId === 'tab-directory') setDirectorySubTab(nextSubTab);
  if (filterChanged) {
    submissionsTypeFilter = typeFilter;
    sectionLoadState.delete('tab-submissions');
  }

  if (updateHash) syncRouteHash(activeRoute, { typeFilter });

  syncHeaderBreadcrumbs();
  syncHeaderContextDescription();
  queueHeaderNavLayoutSync();

  if (sectionChanged) {
    const scrollTop = sectionScroll.get(sectionId) || 0;
    window.requestAnimationFrame(() => window.scrollTo(0, scrollTop));
  }

  ensureSectionData(sectionId);

  try {
    window.dispatchEvent(new CustomEvent('admin:section-activated', {
      detail: { sectionId, subTabId: nextSubTab, previousSectionId: previous.sectionId }
    }));
    if (sectionId === 'tab-home' && sectionChanged) window.dispatchEvent(new CustomEvent('admin:home-activated'));
  } catch {
    // ignore custom-event dispatch failures
  }
  return true;
}

function syncRouteHash(route, { replace = false, typeFilter = submissionsTypeFilter === 'facility_rental' ? 'facility_rental' : '' } = {}) {
  if (window.MMWorkspaceEnabled) return;
  const hash = '#' + canonicalRouteHash(route.sectionId, route.subTabId, typeFilter);
  if (window.location.hash === hash) return;
  try {
    const url = window.location.pathname + window.location.search + hash;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
  } catch { /* ignore history failures */ }
}

// Applies the URL (hash, then /admin/<module> path) without any session or data
// side effects beyond the lazily loaded section.
function applyHashNavigation({ updateHash = false } = {}) {
  if (window.MMWorkspaceEnabled) return;
  const route = resolveAdminRoute();
  const activated = activateMainSection(route.sectionId, {
    subTabId: route.subTabId,
    typeFilter: route.typeFilter,
    updateHash
  });
  if (activated) {
    const effective = activeRoute;
    syncRouteHash(effective, { replace: true, typeFilter: route.typeFilter });
  }
}

const SUBMISSIONS_PAGE_SIZE = 25;
let submissionsOffset = 0;
let submissionsRequestSeq = 0;
let submissionsAbort = null;

function submissionRowHtml(row) {
  const unread = !row.read_at;
  const type = submissionTypeLabel(row.type);
  const sender = escapeHtml(row.sender_name || 'sender');
  const deleteButton = currentPermissions.has('submissions.manage')
    ? `<button class="btn btn--danger actionIconBtn" type="button" data-submission-delete="${escapeHtml(row.id)}" data-submission-type="${escapeHtml(row.type)}" aria-label="Delete message from ${sender}" title="Delete message permanently"><span class="material-icons-round" aria-hidden="true">delete</span></button>` : '';
  return `<tr class="${unread ? 'isUnread' : ''}"><td>${unread ? '<strong>Unread</strong>' : 'Read'}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(row.sender_name || '')}<br><span class="muted">${escapeHtml(row.sender_email || '')}</span></td><td>${escapeHtml(row.subject || '')}</td><td>${escapeHtml(new Date(row.created_at).toLocaleString())}</td><td><div class="submissionActions"><button class="btn actionIconBtn" type="button" data-submission-open="${escapeHtml(row.id)}" data-submission-type="${escapeHtml(row.type)}" aria-label="Open message from ${sender}" title="Open message"><span class="material-icons-round" aria-hidden="true">visibility</span></button>${deleteButton}</div></td></tr>`;
}

function updateSubmissionsPager(total, shown) {
  const info = $('submissionsPageInfo');
  const prev = $('submissionsPrevBtn');
  const next = $('submissionsNextBtn');
  if (info) {
    info.textContent = total
      ? `${submissionsOffset + 1}\u2013${submissionsOffset + shown} of ${total}`
      : '0 messages';
  }
  if (prev) prev.disabled = submissionsOffset <= 0;
  if (next) next.disabled = submissionsOffset + shown >= total;
}

// Server-side filtering and paging. A newer request cancels and supersedes older ones.
async function loadWebsiteSubmissions({ resetPage = false } = {}) {
  const body = $('submissionsTableBody');
  if (!body) return;
  if (resetPage) submissionsOffset = 0;
  if (submissionsAbort) submissionsAbort.abort();
  const controller = new AbortController();
  submissionsAbort = controller;
  const sequence = ++submissionsRequestSeq;
  body.setAttribute('aria-busy', 'true');
  if (!body.querySelector('[data-submission-open]')) body.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  const params = new URLSearchParams({
    q: String($('submissionsSearch')?.value || '').trim(),
    type: submissionsTypeFilter,
    limit: String(SUBMISSIONS_PAGE_SIZE),
    offset: String(submissionsOffset)
  });
  try {
    const data = await api(`/api/submissions?${params}`, { signal: controller.signal });
    if (sequence !== submissionsRequestSeq) return;
    const rows = data?.submissions || [];
    const total = Number(data?.total) || 0;
    if (!rows.length && submissionsOffset > 0 && total > 0) {
      submissionsOffset = Math.floor((total - 1) / SUBMISSIONS_PAGE_SIZE) * SUBMISSIONS_PAGE_SIZE;
      return loadWebsiteSubmissions();
    }
    updateSubmissionTypeFilters(data?.counts);
    updateSubmissionsPager(total, rows.length);
    body.innerHTML = rows.length ? rows.map(submissionRowHtml).join('') : `<tr><td colspan="6" class="muted">No ${escapeHtml(submissionsTypeFilter === 'all' ? 'website submissions' : submissionTypeLabel(submissionsTypeFilter).toLowerCase() + ' messages')} found.</td></tr>`;
    body.querySelectorAll('[data-submission-open]').forEach((button) => button.addEventListener('click', () => openWebsiteSubmission(button.dataset.submissionOpen, button.dataset.submissionType, button).catch((error) => showToast(error.message || 'Unable to open this message.', { variant: 'danger' }))));
    body.querySelectorAll('[data-submission-delete]').forEach((button) => button.addEventListener('click', async () => {
      const row = rows.find((item) => item.id === button.dataset.submissionDelete && item.type === button.dataset.submissionType);
      if (!row || !confirmWrite(`Permanently delete the ${submissionTypeLabel(row.type).toLowerCase()} message from ${row.sender_name || row.sender_email || 'this sender'}? This cannot be undone.`)) return;
      button.disabled = true;
      try {
        await api(`/api/submissions/${encodeURIComponent(row.id)}?type=${encodeURIComponent(row.type)}`, { method: 'DELETE' });
        if ($('submissionDialog')?.dataset.submissionId === row.id) closeSubmissionDialog();
        else await loadWebsiteSubmissions();
      } catch (error) {
        button.disabled = false;
        showToast(error.message || 'Unable to delete this message.', { variant: 'danger' });
      }
    }));
  } catch (error) {
    if (error?.name === 'AbortError' || sequence !== submissionsRequestSeq) return;
    updateSubmissionsPager(0, 0);
    body.innerHTML = `<tr><td colspan="6" class="errorText">${escapeHtml(error.message || 'Unable to load submissions.')}</td></tr>`;
  } finally {
    if (sequence === submissionsRequestSeq) body.removeAttribute('aria-busy');
  }
}

function submissionTypeLabel(type) {
  return String(type || '').toLowerCase() === 'facility_rental' ? 'Facility Rental' : 'Contact';
}

function updateSubmissionTypeFilters(counts) {
  const badgeMap = {
    all: $('submissionsTypeCountAll'),
    contact: $('submissionsTypeCountContact'),
    facility_rental: $('submissionsTypeCountFacility')
  };
  if (counts) {
    Object.entries(badgeMap).forEach(([type, badge]) => {
      if (badge) badge.textContent = String(Number(counts[type]) || 0);
    });
  }

  document.querySelectorAll('[data-submission-type-filter]').forEach((chip) => {
    const type = String(chip.getAttribute('data-submission-type-filter') || 'all').toLowerCase();
    chip.setAttribute('aria-pressed', type === submissionsTypeFilter ? 'true' : 'false');
  });
}

function closeSubmissionDialog() {
  const dialog = $('submissionDialog');
  if (!dialog?.open) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  dialog.dataset.submissionId = '';
}

async function openWebsiteSubmission(id, type, trigger) {
  const row = (await api(`/api/submissions/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`))?.submission;
  if (!row) return;
  if (currentPermissions.has('submissions.manage') && !row.read_at) {
    await api(`/api/submissions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ type, action: 'read' }) });
  }
  const dialog = $('submissionDialog');
  const detail = $('submissionDetail');
  if (!detail || !dialog) return;
  let content = row.body || '';
  if (type === 'facility_rental') { try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* retain raw */ } }
  dialog.dataset.submissionId = id;
  dialog._returnFocus = trigger;
  const contactDetails = [
    row.sender_phone ? `<strong>Phone:</strong> ${escapeHtml(row.sender_phone)}` : '',
    row.sender_address ? `<strong>Address:</strong> ${escapeHtml(row.sender_address)}` : ''
  ].filter(Boolean).join('<br>');
  const replyStatus = String(row.auto_reply_status || 'unknown').toLowerCase();
  const replyLabel = { sent: 'Accepted by email provider', failed: 'Failed', pending: 'Pending', skipped_demo: 'Skipped for demo' }[replyStatus] || 'Unknown';
  const replyClass = replyStatus === 'sent' ? 'submissionDelivery--ok' : replyStatus === 'failed' ? 'submissionDelivery--error' : 'submissionDelivery--pending';
  const replyError = replyStatus === 'failed' && row.auto_reply_error
    ? `<p class="submissionDelivery submissionDelivery--error"><strong>Email error:</strong> ${escapeHtml(row.auto_reply_error)}</p>` : '';
  $('submissionDialogTitle').textContent = row.subject || 'Website message';
  detail.innerHTML = `<p><strong>From:</strong> ${escapeHtml(row.sender_name || '')} &lt;${escapeHtml(row.sender_email || '')}&gt;</p>${contactDetails ? `<p>${contactDetails}</p>` : ''}<p><strong>Auto-reply:</strong> <span class="submissionDelivery ${replyClass}">${escapeHtml(replyLabel)}</span></p>${replyError}<pre class="submissionBody">${escapeHtml(content)}</pre>`;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function applyPermissionVisibility(loggedIn) {
  const elements = document.querySelectorAll('#adminSideNav .tab--nav, [data-section-target]');
  for (const element of elements) {
    const sectionId = String(
      element.getAttribute('aria-controls') || element.getAttribute('data-section-target') || ''
    ).trim();
    const requiredPermission = SECTION_PERMISSIONS[sectionId];
    if (!requiredPermission) continue;
    const allowed = loggedIn && currentPermissions.has(requiredPermission);
    element.hidden = !allowed;
    element.setAttribute('aria-hidden', allowed ? 'false' : 'true');
    if ('disabled' in element) element.disabled = !allowed;
  }
}

let sessionInitialized = false;
let sessionInitPromise = null;

// Refreshes identity, permissions, and header state only. It never reloads data.
async function refreshAuthUI() {
  let me = { user: null };
  try {
    me = await api('/api/me', { method: 'GET' });
  } catch {
    me = { user: null };
  }
  const loggedIn = !!me.user;
  if (!loggedIn) {
    showSessionWarning('Cloudflare Access did not provide an administrator session. Confirm that the Access policy protects /api/*, then refresh this page.');
    return false;
  }
  currentPermissions = new Set(Array.isArray(me.permissions) ? me.permissions.map(String) : []);
  if (loggedIn && isAdministratorRole(me?.user?.role)) currentPermissions.add(USERS_MANAGE_PERMISSION);
  const canViewDiagnostics = loggedIn
    && (
      me?.user?.developer === true
      || me?.capabilities?.developer === true
      || me?.capabilities?.diagnostics?.view === true
      || (Array.isArray(me.permissions) && me.permissions.includes('diagnostics.view'))
    );

  document.body.classList.remove('authMode');

  setAuthenticatedHeaderVisible(loggedIn);

  $('dashboardCard').hidden = !loggedIn;
  $('logoutBtn').hidden = !loggedIn;
  if ($('adminStorageHealthCard')) $('adminStorageHealthCard').hidden = !canViewDiagnostics;
  applyPermissionVisibility(loggedIn);

  const nameOrEmail = String(me?.user?.name || me?.user?.email || '').trim();
  const roleLabel = formatUserRoleLabel(me?.user?.role);
  const authStatus = $('authStatus');
  if (authStatus) {
    authStatus.replaceChildren();
    if (loggedIn) {
      const label = document.createElement('span');
      label.className = 'headerSignedIn__label';
      label.textContent = 'Signed in as';
      const name = document.createElement('span');
      name.className = 'headerSignedIn__name';
      name.textContent = nameOrEmail || String(me.user.email || '').trim();
      authStatus.append(label, name);
    }
  }

  if (loggedIn) {
    const nowHour = new Date().getHours();
    const greeting = nowHour < 12 ? 'Good morning' : (nowHour < 18 ? 'Good afternoon' : 'Good evening');
    $('salutation').textContent = `${greeting}, ${roleLabel}`;
    const homeWelcome = $('homeWelcomeLine');
    if (homeWelcome) homeWelcome.textContent = nameOrEmail ? `${greeting}, ${nameOrEmail}` : 'Welcome';
    const avatarText = $('avatarText');
    if (avatarText) avatarText.textContent = getInitials(me.user);
  }

  syncHeaderBreadcrumbs();
  syncHeaderContextDescription();
  queueHeaderNavLayoutSync();
  updateLayoutMetrics();
  return { me, canViewDiagnostics };
}

// One-time startup: identity, CSRF, diagnostics, and the initial route's section.
function initializeSession() {
  if (sessionInitPromise) return sessionInitPromise;
  sessionInitPromise = (async () => {
    const result = await refreshAuthUI();
    if (!result) {
      setAdminDrawerOpen(false, { restoreFocus: false });
      return;
    }
    if (sessionInitialized) return;
    csrfReady = fetchCsrfToken();
    await csrfReady;
    if (window.MMWorkspaceEnabled) {
      window.MMWorkspaceSession = result.me;
      window.dispatchEvent(new CustomEvent('admin:authenticated', { detail: result.me }));
    }
    sessionInitialized = true;
    setAdminDrawerOpen(getStoredDrawerPreference(), { restoreFocus: false });
    applyHashNavigation({ updateHash: false });
    resetAllUnsavedBaselines();
    if (result.canViewDiagnostics) loadAdminStorageHealth().catch(() => {});
  })().finally(() => { sessionInitPromise = null; });
  return sessionInitPromise;
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function normalizeHash() {
  return String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
}

function setSubTab(buttonIds, panelIds, activePanelId) {
  for (const bid of buttonIds) {
    const b = $(bid);
    if (!b) continue;
    const isActive = b.getAttribute('aria-controls') === activePanelId;
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const pid of panelIds) {
    const p = $(pid);
    if (!p) continue;
    p.hidden = pid !== activePanelId;
  }
}

function setContentSubTab(panelId) {
  setSubTab(
    ['subTabBtn-content-announcements', 'subTabBtn-content-bulletins'],
    ['panel-content-announcements', 'panel-content-bulletins'],
    panelId
  );
}

function setPhotosSubTab(panelId) {
  setSubTab(
    ['subTabBtn-photos-manage', 'subTabBtn-photos-bucket'],
    ['panel-photos-manage', 'panel-photos-bucket'],
    panelId
  );
}

function setDirectorySubTab(panelId) {
  setSubTab(
    ['subTabBtn-directory-contacts', 'subTabBtn-directory-subscribers', 'subTabBtn-directory-groups'],
    ['panel-directory-contacts', 'panel-directory-subscribers', 'panel-directory-groups'],
    panelId
  );
}

// -------- Photo Gallery --------
let galleryItems = [];
let photoArrangeAlbum = '';
let photoSelectedIds = new Set();
let photoTotalItems = 0;
let photoCurrentPage = 1;
let photoGalleryDisplaySettings = { showImageNames: true };
const PHOTO_ROWS_PER_PAGE = 6;

const FIN_CREATE_VALUE = '__CREATE__';
const FIN_DELETE_VALUE = '__DELETE__';

function photoGetColumns() {
  const grid = $('photoGrid');
  if (!grid) return 1;
  try {
    const tpl = String(getComputedStyle(grid).gridTemplateColumns || '').trim();
    const cols = tpl.split(' ').filter(Boolean).length;
    return Math.max(1, cols || 1);
  } catch {
    return 1;
  }
}

function photoPageSize() {
  return photoGetColumns() * PHOTO_ROWS_PER_PAGE;
}

function renderPhotoDisplayNameToggle() {
  const input = $('photoShowImageNames');
  const hint = $('photoDisplayNameToggleHint');
  if (!(input instanceof HTMLInputElement)) return;
  input.checked = photoGalleryDisplaySettings.showImageNames !== false;
  if (hint) {
    hint.textContent = input.checked
      ? 'Live photo names are currently visible on the public gallery page.'
      : 'Live photo names are currently hidden on the public gallery page.';
  }
}

async function loadPhotoDisplayNameSetting() {
  const input = $('photoShowImageNames');
  if (!(input instanceof HTMLInputElement)) return;
  const data = await api('/api/gallery/settings', { method: 'GET' });
  const current = data?.settings?.showImageNames;
  photoGalleryDisplaySettings.showImageNames = current !== false;
  renderPhotoDisplayNameToggle();
}

async function savePhotoDisplayNameSetting(showImageNames) {
  const input = $('photoShowImageNames');
  const hint = $('photoDisplayNameToggleHint');
  if (!(input instanceof HTMLInputElement)) return;

  input.disabled = true;
  if (hint) hint.textContent = 'Saving photo display preference…';

  try {
    const data = await api('/api/gallery/settings', {
      method: 'PUT',
      body: JSON.stringify({ showImageNames: Boolean(showImageNames) })
    });
    photoGalleryDisplaySettings.showImageNames = data?.settings?.showImageNames !== false;
    renderPhotoDisplayNameToggle();
    showToast('Photo gallery name display preference updated.', { variant: 'success' });
  } catch (err) {
    input.checked = photoGalleryDisplaySettings.showImageNames !== false;
    if (hint) hint.textContent = err instanceof Error ? err.message : 'Unable to save photo display preference.';
    showToast('Unable to save photo name display preference.', { variant: 'danger' });
  } finally {
    input.disabled = false;
  }
}

function photoUpdateBulkBar() {
  const bar = $('photoBulkBar');
  const count = $('photoBulkCount');
  if (!bar) return;
  const n = photoSelectedIds.size;
  bar.hidden = n === 0;
  if (count) count.textContent = n ? `${n} selected` : '';

  const editBtn = $('photoBulkEditBtn');
  const deleteBtn = $('photoBulkDeleteBtn');
  if (editBtn) {
    const label = n === 1 ? 'Edit 1 selected photo' : `Edit ${n} selected photos`;
    setActionIconButton(editBtn, 'edit', label);
  }
  if (deleteBtn) {
    const label = n === 1 ? 'Delete 1 selected photo' : `Delete ${n} selected photos`;
    setActionIconButton(deleteBtn, 'delete', label);
  }

  // (Fallback) Stick in-view while scrolling down, but never let it move
  // higher than where it first appeared.
  if (n > 0 && bar.dataset.stickyTopSet !== '1') {
    requestAnimationFrame(() => {
      if (bar.hidden) return;
      try {
        const r = bar.getBoundingClientRect();
        const top = Math.max(0, Math.round(r.top));
        bar.style.setProperty('--photo-bulk-top', `${top}px`);
        bar.dataset.stickyTopSet = '1';
      } catch {
        // ignore
      }
    });
  }
}

function photoUpdatePager() {
  const pagerTop = $('photoPager');
  const infoTop = $('photoPageInfo');
  const prevTop = $('photoPrevPageBtn');
  const nextTop = $('photoNextPageBtn');

  const pagerBottom = $('photoPagerBottom');
  const infoBottom = $('photoPageInfoBottom');
  const prevBottom = $('photoPrevPageBtnBottom');
  const nextBottom = $('photoNextPageBtnBottom');

  const pageSize = photoPageSize();
  const total = photoTotalItems;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (photoCurrentPage > totalPages) photoCurrentPage = totalPages;
  if (photoCurrentPage < 1) photoCurrentPage = 1;

  const showPager = total > pageSize;
  const text = total ? `Page ${photoCurrentPage} of ${totalPages} • ${total} photo(s)` : '';

  if (pagerTop) pagerTop.hidden = !showPager;
  if (infoTop) {
    infoTop.textContent = text;
    infoTop.setAttribute('aria-disabled', showPager ? 'false' : 'true');
    infoTop.setAttribute('title', showPager ? `Jump to page (1-${totalPages})` : '');
  }
  if (prevTop) prevTop.disabled = photoCurrentPage <= 1;
  if (nextTop) nextTop.disabled = photoCurrentPage >= totalPages;

  if (pagerBottom) pagerBottom.hidden = !showPager;
  if (infoBottom) {
    infoBottom.textContent = text;
    infoBottom.setAttribute('aria-disabled', showPager ? 'false' : 'true');
    infoBottom.setAttribute('title', showPager ? `Jump to page (1-${totalPages})` : '');
  }
  if (prevBottom) prevBottom.disabled = photoCurrentPage <= 1;
  if (nextBottom) nextBottom.disabled = photoCurrentPage >= totalPages;
}

function photoPromptJumpToPage() {
  const pageSize = photoPageSize();
  const totalPages = Math.max(1, Math.ceil(photoTotalItems / pageSize));
  if (totalPages <= 1) return;

  const raw = window.prompt(`Go to photo page (1-${totalPages}):`, String(photoCurrentPage));
  if (raw === null) return;

  const next = Number.parseInt(String(raw || '').trim(), 10);
  if (!Number.isInteger(next) || next < 1 || next > totalPages) {
    showToast(`Enter a valid page number from 1 to ${totalPages}.`, { variant: 'danger' });
    return;
  }

  photoCurrentPage = next;
  applyPhotoFilters({ resetPage: false });
}

function bindPhotoPageJump(id) {
  const el = $(id);
  if (!(el instanceof HTMLElement) || el.dataset.pageJumpBound === '1') return;
  el.dataset.pageJumpBound = '1';
  el.classList.add('pageJumpInfo');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;

  const trigger = () => {
    if (el.getAttribute('aria-disabled') === 'true') return;
    photoPromptJumpToPage();
  };

  el.addEventListener('click', trigger);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      trigger();
    }
  });
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function renderArrangeAlbumOptions() {
  const select = $('photoArrangeAlbum');
  if (!select) return;
  const albums = photoAlbums;
  const current = String(photoArrangeAlbum || '');

  select.innerHTML = '<option value="">(Pick an album)</option>';
  for (const a of albums) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    select.appendChild(opt);
  }
  if (albums.includes(current)) select.value = current;
}

function isManualMode() {
  return $('photoSort')?.value === 'manual' && String(photoArrangeAlbum || '').trim();
}

let photoRequestSeq = 0;
let photoAbort = null;
let photoAlbums = [];

// Filtering, sorting, and paging run on the server; stale responses are discarded.
async function applyPhotoFilters({ resetPage = true } = {}) {
  if (resetPage) photoCurrentPage = 1;
  const pageSize = photoPageSize();
  const params = new URLSearchParams({
    limit: String(pageSize),
    offset: String((Math.max(1, photoCurrentPage) - 1) * pageSize),
    sort: $('photoSort').value || 'date-desc'
  });
  const album = $('photoAlbumFilter').value.trim();
  const tag = $('photoTagFilter').value.trim();
  if (album) params.set('album', album);
  if (tag) params.set('tag', tag);
  if (String(photoArrangeAlbum || '').trim()) params.set('arrangeAlbum', photoArrangeAlbum);

  const seq = ++photoRequestSeq;
  if (photoAbort) photoAbort.abort();
  photoAbort = new AbortController();
  const grid = $('photoGrid');
  if (grid) grid.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/api/gallery?' + params.toString(), { method: 'GET', signal: photoAbort.signal });
    if (seq !== photoRequestSeq) return;
    const total = Number(data.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (photoCurrentPage > totalPages) {
      photoCurrentPage = totalPages;
      return applyPhotoFilters({ resetPage: false });
    }
    galleryItems = data.items || [];
    photoAlbums = data.albums || [];
    photoTotalItems = total;
    renderArrangeAlbumOptions();
    photoUpdatePager();
    renderPhotoGrid(galleryItems);
  } catch (err) {
    if (err?.name === 'AbortError' || seq !== photoRequestSeq) return;
    throw err;
  } finally {
    if (seq === photoRequestSeq && grid) grid.removeAttribute('aria-busy');
  }
}

async function saveManualOrder(album, orderedIds) {
  await api('/api/gallery/order', {
    method: 'PUT',
    body: JSON.stringify({ album, orderedIds })
  });

  // Update local positions so the UI stays in sync without a full reload.
  const byId = new Map(galleryItems.map((it) => [String(it.id), it]));
  orderedIds.forEach((id, idx) => {
    const it = byId.get(String(id));
    if (it) it.position = idx;
  });
}

function openPhotoViewDialog(item) {
  const dlg = $('photoViewDialog');
  if (!(dlg instanceof HTMLElement)) return;

  const src = String(item?.file || item?.thumb || '').trim();
  if (!src) return;

  const img = $('photoViewImage');
  const name = $('photoViewName');
  const details = $('photoViewDetails');

  if (img instanceof HTMLImageElement) {
    img.src = src;
    img.alt = String(item?.label || item?.album || 'Photo preview').trim();
  }
  if (name) {
    name.textContent = String(item?.label || item?.originalName || item?.album || 'Photo').trim();
  }
  if (details) {
    const album = String(item?.album || 'General').trim();
    const created = formatDate(item?.createdAt);
    const tags = Array.isArray(item?.tags) && item.tags.length ? `Tags: ${item.tags.join(', ')}` : '';
    details.textContent = [album, created, tags].filter(Boolean).join(' • ');
  }

  openManagedDialog(dlg, { initialFocusId: 'photoViewCloseBtn' });
}

function renderPhotoGrid(items) {
  const grid = $('photoGrid');
  grid.innerHTML = '';

  if (!items.length) {
    grid.innerHTML = '<div class="muted">No photos yet.</div>';
    return;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'thumb';
    card.setAttribute('data-photo-id', String(item.id || ''));

    const selectWrap = document.createElement('label');
    selectWrap.className = 'thumb__select';
    selectWrap.title = 'Select photo';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'thumb__check';
    cb.setAttribute('data-photo-id', String(item.id || ''));
    cb.checked = photoSelectedIds.has(String(item.id || ''));
    if (cb.checked) card.classList.add('thumb--selected');
    cb.addEventListener('click', (e) => {
      try { e.stopPropagation(); } catch { /* ignore */ }
    });
    cb.addEventListener('change', () => {
      const id = String(item.id || '');
      if (!id) return;
      if (cb.checked) {
        photoSelectedIds.add(id);
        card.classList.add('thumb--selected');
      } else {
        photoSelectedIds.delete(id);
        card.classList.remove('thumb--selected');
      }
      photoUpdateBulkBar();
    });
    selectWrap.appendChild(cb);

    const img = document.createElement('img');
    img.className = 'thumb__img';
    img.src = item.thumb || item.file;
    img.alt = item.label ? `${item.label} photo` : 'Gallery photo';
    img.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'thumb__meta';

    const labelRow = document.createElement('div');
    labelRow.className = 'thumb__labelRow';

    const label = document.createElement('div');
    label.className = 'thumb__label';
    label.textContent = item.label || item.album || 'Photo';

    const visibilityToggle = document.createElement('label');
    visibilityToggle.className = 'thumb__visibilityToggle';
    const visibilityCheck = document.createElement('input');
    visibilityCheck.className = 'thumb__visibilityCheck';
    visibilityCheck.type = 'checkbox';
    visibilityCheck.checked = item.hideFromPublic === true;
    visibilityCheck.setAttribute('aria-label', 'Hide From Public Gallery');
    const visibilityText = document.createElement('span');
    visibilityText.textContent = 'Hide';
    visibilityToggle.appendChild(visibilityCheck);
    visibilityToggle.appendChild(visibilityText);

    visibilityCheck.addEventListener('change', async () => {
      const nextValue = visibilityCheck.checked;
      visibilityCheck.disabled = true;
      try {
        const result = await api(`/api/gallery/${item.id}`, {
          method: 'PUT',
          body: JSON.stringify({ hideFromPublic: nextValue })
        });
        item.hideFromPublic = result?.item?.hideFromPublic === true ? true : nextValue;
        showToast(nextValue ? 'Photo hidden from live gallery.' : 'Photo shown on live gallery.', { variant: 'success' });
      } catch (err) {
        visibilityCheck.checked = !nextValue;
        showToast(err instanceof Error ? err.message : 'Unable to update gallery visibility.', { variant: 'danger' });
      } finally {
        visibilityCheck.disabled = false;
      }
    });

    labelRow.appendChild(label);
    labelRow.appendChild(visibilityToggle);

    const small = document.createElement('div');
    small.className = 'thumb__small';
    small.textContent = `${item.album || 'General'} • ${formatDate(item.createdAt)}`;

    const tags = document.createElement('div');
    tags.className = 'thumb__small';
    tags.textContent = (item.tags || []).length ? `Tags: ${(item.tags || []).join(', ')}` : '';

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const view = document.createElement('button');
    view.className = 'btn';
    view.type = 'button';
    setActionIconButton(view, 'view', 'View photo');
    view.addEventListener('click', () => {
      openPhotoViewDialog(item);
    });
    actions.appendChild(view);

    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.type = 'button';
    setActionIconButton(edit, 'edit', 'Edit photo');
    edit.addEventListener('click', async () => {
      const nextLabel = prompt('Name/Label', String(item.label || ''));
      if (nextLabel === null) return;
      const nextAlbum = prompt('Album', String(item.album || 'General'));
      if (nextAlbum === null) return;
      const nextTags = prompt('Tags (comma-separated)', (item.tags || []).join(', '));
      if (nextTags === null) return;
      await api(`/api/gallery/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ label: nextLabel, album: String(nextAlbum || '').trim() || 'General', tags: nextTags })
      });
      await loadGallery();
    });
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'btn btn--danger';
    del.type = 'button';
    setActionIconButton(del, 'delete', 'Delete photo');
    del.addEventListener('click', async () => {
      const labelText = String(item.label || item.originalName || 'this photo');
      const ok = confirmWrite(
        `Delete ${labelText}?\n\nThis will remove it from the website gallery after refresh.`
      );
      if (!ok) return;
      await api(`/api/gallery/${item.id}`, { method: 'DELETE' });
      await loadGallery();
      announceLive(`Deleted ${labelText}.`);
    });

    actions.appendChild(del);

    meta.appendChild(labelRow);
    meta.appendChild(small);
    meta.appendChild(tags);
    meta.appendChild(actions);

    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(selectWrap);

    if (photoSelectedIds.has(String(item.id || ''))) card.classList.add('thumb--selected');

    grid.appendChild(card);
  }

  photoUpdateBulkBar();
}

async function loadGallery() {
  await applyPhotoFilters({ resetPage: false });
  if ($('photoShowImageNames')) {
    try {
      await loadPhotoDisplayNameSetting();
    } catch {
      renderPhotoDisplayNameToggle();
    }
  }
}

// -------- R2 Bucket Browser (gallery/ only) --------
let r2Prefix = 'gallery/';

function normalizeR2Prefix(raw) {
  let p = String(raw || '').trim();
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  // Force under gallery/
  if (!p || !p.startsWith('gallery/')) p = 'gallery/';
  // Normalize double slashes
  p = p.replace(/\/{2,}/g, '/');
  // Basic traversal prevention (server enforces too)
  if (p.includes('..')) p = 'gallery/';
  return p;
}

function parentR2Prefix(prefix) {
  const p = normalizeR2Prefix(prefix);
  if (p === 'gallery/') return 'gallery/';
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const parts = trimmed.split('/');
  if (parts.length <= 2) return 'gallery/';
  return `${parts.slice(0, -1).join('/')}/`;
}

function setR2Status(message) {
  const el = $('r2Status');
  if (el) el.textContent = String(message || '');
}

function setR2UiBusy(busy) {
  const ids = ['r2RefreshBtn', 'r2GoBtn', 'r2UpBtn', 'r2SyncFolderBtn', 'r2PrefixInput', 'exportBtn'];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    if (el.tagName === 'INPUT') el.disabled = Boolean(busy);
    else el.disabled = Boolean(busy);
  }
}

function renderR2Breadcrumb(prefix) {
  const root = $('r2Breadcrumb');
  if (!root) return;
  root.innerHTML = '';

  const p = normalizeR2Prefix(prefix);
  const afterGallery = p.slice('gallery/'.length);
  const segments = afterGallery.split('/').filter(Boolean);

  const makeCrumb = (label, targetPrefix) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'r2Crumb';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      loadR2Tree(targetPrefix).catch((e) => setR2Status(e.message));
    });
    return btn;
  };

  root.appendChild(makeCrumb('gallery/', 'gallery/'));

  let running = 'gallery/';
  for (const s of segments) {
    running = `${running}${s}/`;
    const sep = document.createElement('span');
    sep.className = 'r2CrumbSep';
    sep.textContent = ' / ';
    root.appendChild(sep);
    root.appendChild(makeCrumb(s, running));
  }
}

function formatR2ObjectBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = num;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = i === 0 ? 0 : (v < 10 ? 2 : 1);
  return `${v.toFixed(digits)} ${units[i]}`;
}

function renderR2Tree(prefix, data) {
  const tree = $('r2Tree');
  if (!tree) return;
  tree.innerHTML = '';

  const folders = data?.folders || [];
  const files = data?.files || [];

  if (!folders.length && !files.length) {
    tree.innerHTML = '<div class="muted">No objects under this prefix.</div>';
    return;
  }

  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'r2Row';

    const main = document.createElement('div');
    main.className = 'r2Row__main';
    const title = document.createElement('div');
    title.className = 'r2Row__title';
    title.textContent = `${f.name}/`;
    const meta = document.createElement('div');
    meta.className = 'r2Row__meta muted';
    meta.textContent = f.prefix;

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'r2Row__actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn';
    openBtn.textContent = 'Open';
    setActionIconButton(openBtn, 'go', 'Open folder');
    openBtn.addEventListener('click', () => {
      loadR2Tree(f.prefix).catch((e) => setR2Status(e.message));
    });
    actions.appendChild(openBtn);

    row.appendChild(main);
    row.appendChild(actions);
    tree.appendChild(row);
  }

  for (const o of files) {
    const row = document.createElement('div');
    row.className = 'r2Row';

    const main = document.createElement('div');
    main.className = 'r2Row__main';
    const title = document.createElement('div');
    title.className = 'r2Row__title';
    title.textContent = o.name;
    const meta = document.createElement('div');
    meta.className = 'r2Row__meta muted';
    const when = o.uploaded ? ` • ${formatDate(o.uploaded)}` : '';
    meta.textContent = `${formatR2ObjectBytes(o.size)}${when}`.trim();

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'r2Row__actions';

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn';
    setActionIconButton(viewBtn, 'view', 'View stored file');
    viewBtn.addEventListener('click', () => {
      const key = String(o.key || '');
      if (!key) return;
      window.open(`/cdn/gallery/${encodeURI(key)}`, '_blank');
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn';
    setActionIconButton(delBtn, 'delete', 'Delete stored file');
    delBtn.addEventListener('click', async () => {
      const key = String(o.key || '');
      if (!key) return;
      if (!confirmWrite(`Delete this stored photo file?\n\n${key}`)) return;
      setR2UiBusy(true);
      setR2Status('Deleting…');
      try {
        await api(`/api/gallery/r2object?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
        await loadR2Tree(r2Prefix);
        await loadGallery();
        setR2Status('Deleted.');
      } catch (e) {
        setR2Status(e.message);
      } finally {
        setR2UiBusy(false);
      }
    });

    actions.appendChild(viewBtn);
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    tree.appendChild(row);
  }
}

async function loadR2Tree(prefix) {
  if (!$('r2Tree')) return;

  r2Prefix = normalizeR2Prefix(prefix);
  const prefixInput = $('r2PrefixInput');
  if (prefixInput) prefixInput.value = r2Prefix;

  setR2Status('Loading…');
  renderR2Breadcrumb(r2Prefix);

  try {
    const data = await api(`/api/gallery/r2tree?prefix=${encodeURIComponent(r2Prefix)}&limit=1000`, { method: 'GET' });
    renderR2Tree(r2Prefix, data);
    setR2Status(data?.truncated ? 'Showing first page (use a narrower folder for faster browsing).' : '');
  } catch (e) {
    const msg = String(e?.message || e || 'Unable to load photo storage listing.');
    setR2Status(msg);
    showToast(msg, { variant: 'danger' });
    throw e;
  }
}

async function syncFromR2(prefix, { confirm: shouldConfirm = true } = {}) {
  const p = normalizeR2Prefix(prefix);
  if (shouldConfirm) {
    const ok = confirmWrite(`Refresh website gallery records from photo storage under:\n\n${p}\n\nThis updates what the public Photos page shows.`);
    if (!ok) {
      setR2Status('Refresh canceled.');
      return { ok: false, canceled: true };
    }
  }

  setR2UiBusy(true);
  setR2Status('Refreshing…');

  if (syncProgressHideTimer) {
    try { window.clearTimeout(syncProgressHideTimer); } catch { /* ignore */ }
    syncProgressHideTimer = null;
  }

  setSyncProgress({ visible: true, indeterminate: true, text: 'Starting refresh…' });

  let cursor = null;
  const seenCursors = new Set();
  let loops = 0;
  let totalAdded = 0;
  let totalExisting = 0;
  let totalProcessed = 0;

  try {
    while (true) {
      loops += 1;
      if (loops > 500) throw new Error('Refresh stopped: too many pages (possible cursor loop).');

      setSyncProgress({
        visible: true,
        indeterminate: false,
        max: 500,
        value: loops,
        text: `Refreshing… page ${loops} • processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`
      });
      const qs = new URLSearchParams({ prefix: p, limit: '1000' });
      if (cursor) qs.set('cursor', cursor);
      const controller = new AbortController();
      const t = window.setTimeout(() => controller.abort(), 60_000);
      let res;
      try {
        res = await api(`/api/gallery/sync?${qs.toString()}`, { method: 'POST', body: '{}', signal: controller.signal });
      } finally {
        window.clearTimeout(t);
      }
      totalAdded += Number(res.added || 0);
      totalExisting += Number(res.existing || 0);
      totalProcessed += Number(res.processed || 0);
      setR2Status(`Refreshing… processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`);

      setSyncProgress({
        visible: true,
        indeterminate: false,
        max: 500,
        value: loops,
        text: `Refreshing… page ${loops} • processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`
      });
      cursor = res.nextCursor;
      if (!cursor) break;
      if (seenCursors.has(String(cursor))) throw new Error('Refresh stopped: pagination cursor repeated (possible server cursor bug).');
      seenCursors.add(String(cursor));
    }
    setR2Status(`Refresh complete. Added ${totalAdded} item(s).`);
    setSyncProgress({ visible: true, indeterminate: false, max: 500, value: Math.min(500, loops), text: `Refresh complete. Added ${totalAdded} item(s).` });
    showToast(`Website photos refreshed. Added ${totalAdded} item(s).`, { variant: 'success' });
    await loadGallery();
    await loadR2Tree(p);
    return { ok: true, added: totalAdded, existing: totalExisting, processed: totalProcessed };
  } catch (e) {
    setR2Status(e.message);
    setSyncProgress({ visible: true, indeterminate: false, max: 500, value: Math.min(500, loops || 0), text: `Sync failed: ${String(e?.message || e || 'Unknown error')}` });
    showToast(`Photo refresh failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
    return { ok: false, error: String(e?.message || e || 'Unknown error') };
  } finally {
    setR2UiBusy(false);
  }
}

// -------- Announcements --------
let announcementPosts = [];
let editingAnnouncementId = null;
let announcementPreviewDraft = null;
let eventPreviewDraft = null;
let bulletinPreviewDraft = null;

function formatPreviewDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  return formatDate(new Date(t).toISOString());
}

function buildPreviewRow({ title, meta, body } = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('div');
  main.className = 'row__main';

  const t = document.createElement('div');
  t.className = 'row__title';
  t.textContent = String(title || 'Preview item').trim() || 'Preview item';
  main.appendChild(t);

  if (meta) {
    const m = document.createElement('div');
    m.className = 'row__meta';
    m.textContent = String(meta);
    main.appendChild(m);
  }
  if (body) {
    const b = document.createElement('div');
    b.className = 'row__meta';
    b.textContent = String(body);
    main.appendChild(b);
  }

  row.appendChild(main);
  return row;
}

function renderPreviewRows(listId, rows, emptyText) {
  const root = $(listId);
  if (!root) return;
  root.innerHTML = '';
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!safeRows.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = String(emptyText || 'Nothing to preview yet.');
    root.appendChild(empty);
    return;
  }
  for (const row of safeRows) root.appendChild(buildPreviewRow(row));
}

function actionIconSvg(kind) {
  const type = String(kind || '').trim().toLowerCase();
  const iconNames = {
    close: 'close',
    refresh: 'refresh',
    sync: 'sync',
    prev: 'chevron_left',
    left: 'chevron_left',
    next: 'chevron_right',
    right: 'chevron_right',
    go: 'chevron_right',
    up: 'arrow_upward',
    upload: 'upload_file',
    edit: 'edit',
    delete: 'delete',
    print: 'print',
    view: 'visibility'
  };
  const iconName = iconNames[type] || 'visibility';
  return `<span class="material-icons-round" aria-hidden="true">${iconName}</span>`;
}

function setActionIconButton(el, kind, label) {
  if (!(el instanceof HTMLElement)) return;
  const safeLabel = String(label || kind || 'Action').trim() || 'Action';
  el.classList.add('actionIconBtn');
  el.setAttribute('aria-label', safeLabel);
  el.setAttribute('title', safeLabel);
  el.innerHTML = `<span class="srOnly">${escapeHtml(safeLabel)}</span>${actionIconSvg(kind)}`;
}

function initPhotoActionIcons() {
  const buttonIcons = [
    ['photoHelpCloseBtn', 'close', 'Close photo upload instructions'],
    ['photoViewCloseBtn', 'close', 'Close photo preview'],
    ['photoPrevPageBtn', 'prev', 'Previous photo page'],
    ['photoNextPageBtn', 'next', 'Next photo page'],
    ['photoPrevPageBtnBottom', 'prev', 'Previous photo page'],
    ['photoNextPageBtnBottom', 'next', 'Next photo page'],
    ['exportBtn', 'refresh', 'Refresh website gallery'],
    ['r2RefreshBtn', 'refresh', 'Refresh storage view'],
    ['r2UpBtn', 'up', 'Go up one folder'],
    ['r2SyncFolderBtn', 'sync', 'Refresh this folder from storage'],
    ['r2GoBtn', 'go', 'Open folder path']
  ];

  for (const [id, kind, label] of buttonIcons) {
    const el = $(id);
    if (el) setActionIconButton(el, kind, label);
  }

  const addPhotosBtn = document.querySelector('#tab-photos button[form="photoUploadForm"]');
  if (addPhotosBtn instanceof HTMLElement) {
    setActionIconButton(addPhotosBtn, 'upload', 'Add photos');
  }

  photoUpdateBulkBar();
}

function getAnnouncementFormDraftPreview() {
  const form = $('announceForm');
  if (!(form instanceof HTMLFormElement)) return null;
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  const body = String(fd.get('body') || '').trim();
  const neverExpires = fd.get('neverExpires') === 'on';
  const days = Number(fd.get('expiresInDays'));
  if (!title && !body) return null;
  const expiryText = neverExpires
    ? 'Expires: Never'
    : `Expires in ${Number.isFinite(days) && days > 0 ? days : 30} day(s)`;
  return {
    title: title || 'Announcement title',
    meta: `Draft announcement • ${expiryText}`,
    body: body || 'Message preview'
  };
}

function renderAnnouncementsPreview() {
  const rows = [];
  const draft = announcementPreviewDraft || getAnnouncementFormDraftPreview();
  if (draft) rows.push(draft);

  renderPreviewRows('announcePreviewList', rows, 'No announcement preview yet.');
}

function renderAnnouncements() {
  const root = $('announceList');
  root.innerHTML = '';
  renderAnnouncementsPreview();

  for (const post of announcementPosts) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    if (editingAnnouncementId === post.id) {
      const titleLabel = document.createElement('label');
      titleLabel.className = 'label';
      titleLabel.textContent = 'Title';
      const titleInput = document.createElement('input');
      titleInput.className = 'input';
      titleInput.type = 'text';
      titleInput.maxLength = 120;
      titleInput.value = String(post.title || '');
      titleLabel.appendChild(titleInput);

      const bodyLabel = document.createElement('label');
      bodyLabel.className = 'label';
      bodyLabel.textContent = 'Message';
      const bodyInput = document.createElement('textarea');
      bodyInput.className = 'textarea';
      bodyInput.rows = 4;
      bodyInput.maxLength = 5000;
      bodyInput.value = String(post.body || '');
      bodyLabel.appendChild(bodyInput);

      const startsLabel = document.createElement('label');
      startsLabel.className = 'label';
      startsLabel.textContent = 'Show from (optional)';
      const startsInput = document.createElement('input');
      startsInput.className = 'input';
      startsInput.type = 'datetime-local';
      startsInput.value = toLocalDateTimeValue(post.startsAt);
      startsLabel.appendChild(startsInput);

      const endsLabel = document.createElement('label');
      endsLabel.className = 'label';
      endsLabel.textContent = 'Show until';
      const endsInput = document.createElement('input');
      endsInput.className = 'input';
      endsInput.type = 'datetime-local';
      endsInput.value = toLocalDateTimeValue(post.expiresAt);
      endsLabel.appendChild(endsInput);

      const neverWrap = document.createElement('label');
      neverWrap.className = 'label label--inline';
      const neverInput = document.createElement('input');
      neverInput.className = 'checkbox';
      neverInput.type = 'checkbox';
      neverInput.checked = !post.expiresAt;
      neverInput.addEventListener('change', () => {
        endsInput.disabled = neverInput.checked;
        if (neverInput.checked) endsInput.value = '';
      });
      endsInput.disabled = neverInput.checked;
      neverWrap.appendChild(neverInput);
      neverWrap.appendChild(document.createTextNode('Never expires'));

      const syncAnnouncementDraftPreview = () => {
        announcementPreviewDraft = {
          id: post.id,
          title: String(titleInput.value || '').trim() || 'Announcement title',
          meta: (() => {
            const starts = String(startsInput.value || '').trim();
            const ends = String(endsInput.value || '').trim();
            const parts = ['Editing announcement'];
            if (starts) parts.push(`Starts: ${formatPreviewDateTime(starts)}`);
            parts.push(neverInput.checked ? 'Expires: Never' : `Expires: ${formatPreviewDateTime(ends) || 'Set a date'}`);
            return parts.join(' • ');
          })(),
          body: String(bodyInput.value || '').trim() || 'Message preview'
        };
        renderAnnouncementsPreview();
      };
      [titleInput, bodyInput, startsInput, endsInput].forEach((el) => {
        el.addEventListener('input', syncAnnouncementDraftPreview);
      });
      neverInput.addEventListener('change', syncAnnouncementDraftPreview);
      syncAnnouncementDraftPreview();

      main.appendChild(titleLabel);
      main.appendChild(bodyLabel);
      main.appendChild(startsLabel);
      main.appendChild(endsLabel);
      main.appendChild(neverWrap);
    } else {
      const details = document.createElement('details');
      details.className = 'announceItem';

      const summary = document.createElement('summary');
      summary.className = 'announceItem__summary';
      const t = document.createElement('span');
      t.className = 'row__title';
      t.textContent = post.title;
      summary.appendChild(t);

      const content = document.createElement('div');
      content.className = 'announceItem__content';

      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const created = post.createdAt ? `Posted: ${formatDate(post.createdAt)}` : '';
      const starts = post.startsAt ? ` • Starts: ${formatDate(post.startsAt)}` : '';
      const expires = post.expiresAt ? ` • Expires: ${formatDate(post.expiresAt)}` : ' • Expires: Never';
      meta.textContent = `${created}${starts}${expires}`.trim();

      const body = document.createElement('div');
      body.className = 'row__meta';
      body.textContent = post.body;

      content.appendChild(meta);
      content.appendChild(body);
      details.appendChild(summary);
      details.appendChild(content);
      main.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    if (editingAnnouncementId === post.id) {
      const save = document.createElement('button');
      save.className = 'btn btn--primary';
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const inputs = main.querySelectorAll('input, textarea');
        const title = String(inputs[0]?.value || '').trim();
        const body = String(inputs[1]?.value || '').trim();
        const startsAt = String(inputs[2]?.value || '').trim();
        const expiresAt = String(inputs[3]?.value || '').trim();
        const neverExpires = Boolean(inputs[4]?.checked);
        if (!title || !body) {
          showToast('Title and message are required.', { variant: 'danger' });
          return;
        }
        if (!neverExpires && startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
          showToast('Show until must be after show from.', { variant: 'danger' });
          return;
        }
        if (!confirmWrite('Save changes to this announcement?')) return;

        await api(`/api/announcements/${post.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            title,
            body,
            startsAt: startsAt || null,
            expiresAt: neverExpires ? null : (expiresAt || null),
            neverExpires
          })
        });
        announcementPreviewDraft = null;
        editingAnnouncementId = null;
        await loadAnnouncements();
      });

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        announcementPreviewDraft = null;
        editingAnnouncementId = null;
        renderAnnouncements();
      });

      actions.appendChild(save);
      actions.appendChild(cancel);
    } else {
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.type = 'button';
      setActionIconButton(edit, 'edit', 'Edit announcement');
      edit.addEventListener('click', () => {
        announcementPreviewDraft = null;
        editingAnnouncementId = post.id;
        renderAnnouncements();
      });
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    setActionIconButton(del, 'delete', 'Delete announcement');
    del.addEventListener('click', async () => {
      if (!confirmWrite('Delete this announcement?')) return;
      await api(`/api/announcements/${post.id}`, { method: 'DELETE' });
      announcementPreviewDraft = null;
      if (editingAnnouncementId === post.id) editingAnnouncementId = null;
      await loadAnnouncements();
    });

    actions.appendChild(del);
    row.appendChild(main);
    row.appendChild(actions);
    root.appendChild(row);
  }

  if (!announcementPosts.length) root.innerHTML = '<div class="muted">No announcements yet.</div>';
}

async function loadAnnouncements() {
  const data = await api('/api/announcements', { method: 'GET' });
  announcementPosts = data.posts || [];
  if (editingAnnouncementId && !announcementPosts.some((p) => p.id === editingAnnouncementId)) {
    editingAnnouncementId = null;
    announcementPreviewDraft = null;
  }
  renderAnnouncements();
}

// -------- Events --------
let events = [];
let editingEventId = null;

function formatLocalTimestamp(d = new Date()) {
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return d.toISOString();
  }
}

function formatEventTime12h(timeStr) {
  const t = String(timeStr || '').trim();
  if (!t) return '';
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!m) return t;
  let hh = Number(m[1]);
  const mm = m[2];
  const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${mm} ${ap}`;
}

function normalizeTitle(t) {
  return String(t || '').trim();
}

function setPrintMode(mode) {
  document.body.dataset.printMode = String(mode || 'events');
  const body = $('adminPrintBody');
  if (body) body.innerHTML = '';
}

function closeDetailsMenu(id) {
  const el = $(id);
  if (el && el.tagName === 'DETAILS') el.open = false;
}

function setEventsPrintHeader(reportLabel, extraMetaParts = []) {
  const title = $('eventsPrintTitle');
  if (title) title.textContent = 'Mt. Moriah Missionary Baptist Church — Events';

  const meta = $('eventsPrintMeta');
  if (!meta) return;

  const parts = [`Printed: ${formatLocalTimestamp()}`];
  if (reportLabel) parts.push(`Report: ${reportLabel}`);
  for (const p of extraMetaParts) {
    if (p) parts.push(String(p));
  }
  meta.textContent = parts.join(' • ');
}

function renderEventsPrintReport(rows, reportTitle) {
  const root = $('adminPrintBody');
  if (!root) return;

  const safeRows = Array.isArray(rows) ? rows : [];
  const sorted = [...safeRows].sort((a, b) => {
    const ad = String(a?.date || '');
    const bd = String(b?.date || '');
    if (ad !== bd) return ad.localeCompare(bd);
    const at = String(a?.time || '');
    const bt = String(b?.time || '');
    if (at !== bt) return at.localeCompare(bt);
    return String(a?.title || '').localeCompare(String(b?.title || ''));
  });

  const h = document.createElement('div');
  h.className = 'printReportTitle';
  h.textContent = reportTitle || 'Events Report';
  root.appendChild(h);

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'printMuted';
    empty.textContent = 'No events match your selection.';
    root.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'printTable';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th style="width:120px">Date</th><th style="width:110px">Time</th><th>Title</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const ev of sorted) {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = String(ev?.date || '');
    const tdTime = document.createElement('td');
    tdTime.textContent = formatEventTime12h(ev?.time);
    const tdTitle = document.createElement('td');
    tdTitle.textContent = normalizeTitle(ev?.title);
    tr.appendChild(tdDate);
    tr.appendChild(tdTime);
    tr.appendChild(tdTitle);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

function refreshEventsPrintOptions() {
  const groupSel = $('printEventsGroupTitle');
  const eventSel = $('printEventId');
  if (!groupSel || !eventSel) return;

  const previousGroup = String(groupSel.value || '');
  const previousEvent = String(eventSel.value || '');

  const sorted = [...events].sort((a, b) => {
    const ad = String(a?.date || '');
    const bd = String(b?.date || '');
    if (ad !== bd) return ad.localeCompare(bd);
    const at = String(a?.time || '');
    const bt = String(b?.time || '');
    if (at !== bt) return at.localeCompare(bt);
    return String(a?.title || '').localeCompare(String(b?.title || ''));
  });

  const titles = Array.from(new Set(sorted.map((e) => normalizeTitle(e?.title)).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));

  groupSel.replaceChildren();
  const groupPrompt = document.createElement('option');
  groupPrompt.value = '';
  groupPrompt.textContent = 'Choose a title…';
  groupSel.appendChild(groupPrompt);
  for (const title of titles) {
    const option = document.createElement('option');
    option.value = title;
    option.textContent = title;
    groupSel.appendChild(option);
  }
  if (titles.includes(previousGroup)) groupSel.value = previousGroup;

  eventSel.replaceChildren();
  const eventPrompt = document.createElement('option');
  eventPrompt.value = '';
  eventPrompt.textContent = 'Choose an event…';
  eventSel.appendChild(eventPrompt);
  for (const event of sorted) {
    const option = document.createElement('option');
    option.value = String(event?.id || '');
    const date = String(event?.date || '').trim();
    const time = formatEventTime12h(event?.time);
    const title = normalizeTitle(event?.title) || 'Event';
    option.textContent = [date, time, title].filter(Boolean).join(' • ');
    eventSel.appendChild(option);
  }
  if (sorted.some((event) => String(event?.id || '') === previousEvent)) eventSel.value = previousEvent;
}

function normalizeTimeValue(value) {
  const t = String(value || '').trim();
  if (!t) return '';
  // Accept HH:MM or HH:MM:SS from some browsers
  const m = t.match(/^([0-2]\d):([0-5]\d)/);
  return m ? `${m[1]}:${m[2]}` : '';
}

function getEventFormDraftPreview() {
  const form = $('eventForm');
  if (!(form instanceof HTMLFormElement)) return null;
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  const date = String(fd.get('date') || '').trim();
  const time = normalizeTimeValue(fd.get('time'));
  if (!title && !date && !time) return null;
  return {
    title: title || 'Event title',
    meta: [date || 'No date', formatEventTime12h(time) || 'No time'].join(' • ')
  };
}

function renderEventsPreview() {
  const rows = [];
  const draft = eventPreviewDraft || getEventFormDraftPreview();
  if (draft) rows.push(draft);

  renderPreviewRows('eventPreviewList', rows, 'No event preview yet.');
}

function renderEvents() {
  const root = $('eventList');
  root.innerHTML = '';
  renderEventsPreview();

  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    if (editingEventId === ev.id) {
      const titleLabel = document.createElement('label');
      titleLabel.className = 'label';
      titleLabel.textContent = 'Title';
      const titleInput = document.createElement('input');
      titleInput.className = 'input';
      titleInput.type = 'text';
      titleInput.value = ev.title || '';
      titleLabel.appendChild(titleInput);

      const dateLabel = document.createElement('label');
      dateLabel.className = 'label';
      dateLabel.textContent = 'Date';
      const dateInput = document.createElement('input');
      dateInput.className = 'input';
      dateInput.type = 'date';
      dateInput.value = ev.date || '';
      dateLabel.appendChild(dateInput);

      const timeLabel = document.createElement('label');
      timeLabel.className = 'label';
      timeLabel.textContent = 'Time';
      const timeInput = document.createElement('input');
      timeInput.className = 'input';
      timeInput.type = 'time';
      timeInput.value = normalizeTimeValue(ev.time);
      timeLabel.appendChild(timeInput);

      const syncEventDraftPreview = () => {
        eventPreviewDraft = {
          id: ev.id,
          title: String(titleInput.value || '').trim() || 'Event title',
          meta: `${String(dateInput.value || '').trim() || 'No date'} • ${formatEventTime12h(normalizeTimeValue(timeInput.value)) || 'No time'}`
        };
        renderEventsPreview();
      };
      [titleInput, dateInput, timeInput].forEach((el) => el.addEventListener('input', syncEventDraftPreview));
      syncEventDraftPreview();

      main.appendChild(titleLabel);
      main.appendChild(dateLabel);
      main.appendChild(timeLabel);
    } else {
      const details = document.createElement('details');
      details.className = 'announceItem';

      const summary = document.createElement('summary');
      summary.className = 'announceItem__summary';
      const t = document.createElement('span');
      t.className = 'row__title';
      t.textContent = ev.title;
      summary.appendChild(t);

      const content = document.createElement('div');
      content.className = 'announceItem__content';
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      meta.textContent = `${ev.date}${ev.time ? ` • ${ev.time}` : ''}`;
      content.appendChild(meta);

      details.appendChild(summary);
      details.appendChild(content);
      main.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    if (editingEventId === ev.id) {
      const save = document.createElement('button');
      save.className = 'btn btn--primary';
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const inputs = main.querySelectorAll('input');
        const title = inputs[0]?.value || '';
        const date = inputs[1]?.value || '';
        const time = inputs[2]?.value || '';

        if (!confirmWrite('Save changes to this event?')) return;

        await api(`/api/events/${ev.id}`, {
          method: 'PUT',
          body: JSON.stringify({ title, date, time })
        });
        eventPreviewDraft = null;
        editingEventId = null;
        await loadEvents();
      });

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        eventPreviewDraft = null;
        editingEventId = null;
        renderEvents();
      });

      actions.appendChild(save);
      actions.appendChild(cancel);
    } else {
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.type = 'button';
      setActionIconButton(edit, 'edit', 'Edit event');
      edit.addEventListener('click', () => {
        eventPreviewDraft = null;
        editingEventId = ev.id;
        renderEvents();
      });
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    setActionIconButton(del, 'delete', 'Delete event');
    del.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await api(`/api/events/${ev.id}`, { method: 'DELETE' });
      eventPreviewDraft = null;
      if (editingEventId === ev.id) editingEventId = null;
      await loadEvents();
    });

    actions.appendChild(del);
    row.appendChild(main);
    row.appendChild(actions);
    root.appendChild(row);
  }

  if (!events.length) root.innerHTML = '<div class="muted">No events yet.</div>';
}

async function loadEvents() {
  const data = await api('/api/events', { method: 'GET' });
  events = data.events || [];
  if (editingEventId && !events.some((e) => e.id === editingEventId)) {
    editingEventId = null;
    eventPreviewDraft = null;
  }
  renderEvents();
  refreshEventsPrintOptions();
}

// -------- Bulletins --------
let bulletins = [];
let editingBulletinId = null;

function toLocalDateTimeValue(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isActiveBulletin(b) {
  const start = b?.startsAt ? Date.parse(b.startsAt) : NaN;
  const end = b?.endsAt ? Date.parse(b.endsAt) : NaN;
  const now = Date.now();
  if (!Number.isNaN(start) && now < start) return false;
  if (!Number.isNaN(end) && now >= end) return false;
  if (Number.isNaN(start) && Number.isNaN(end)) return false;
  return true;
}

function getBulletinFormDraftPreview() {
  const form = $('bulletinForm');
  if (!(form instanceof HTMLFormElement)) return null;
  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  const startsAt = String(fd.get('startsAt') || '').trim();
  const endsAt = String(fd.get('endsAt') || '').trim();
  const file = form.querySelector('input[name="file"]')?.files?.[0];
  if (!title && !startsAt && !endsAt && !file) return null;
  return {
    title: title || 'Bulletin title',
    meta: `${formatPreviewDateTime(startsAt) || 'No start'} → ${formatPreviewDateTime(endsAt) || 'No end'}`,
    body: file ? `File: ${file.name}` : 'File: not selected'
  };
}

function renderBulletinsPreview() {
  const rows = [];
  const draft = bulletinPreviewDraft || getBulletinFormDraftPreview();
  if (draft) rows.push(draft);

  renderPreviewRows('bulletinPreviewList', rows, 'No bulletin preview yet.');
}

function renderBulletins() {
  const root = $('bulletinList');
  root.innerHTML = '';
  renderBulletinsPreview();

  for (const b of bulletins) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    if (editingBulletinId === b.id) {
      const titleLabel = document.createElement('label');
      titleLabel.className = 'label';
      titleLabel.textContent = 'Bulletin title';
      const titleInput = document.createElement('input');
      titleInput.className = 'input';
      titleInput.type = 'text';
      titleInput.maxLength = 120;
      titleInput.value = String(b.title || 'Bulletin');
      titleLabel.appendChild(titleInput);

      const startsLabel = document.createElement('label');
      startsLabel.className = 'label';
      startsLabel.textContent = 'Show from';
      const startsInput = document.createElement('input');
      startsInput.className = 'input';
      startsInput.type = 'datetime-local';
      startsInput.value = toLocalDateTimeValue(b.startsAt);
      startsLabel.appendChild(startsInput);

      const endsLabel = document.createElement('label');
      endsLabel.className = 'label';
      endsLabel.textContent = 'Show until';
      const endsInput = document.createElement('input');
      endsInput.className = 'input';
      endsInput.type = 'datetime-local';
      endsInput.value = toLocalDateTimeValue(b.endsAt);
      endsLabel.appendChild(endsInput);

      const syncBulletinDraftPreview = () => {
        bulletinPreviewDraft = {
          id: b.id,
          title: String(titleInput.value || '').trim() || 'Bulletin title',
          meta: `${formatPreviewDateTime(startsInput.value) || 'No start'} → ${formatPreviewDateTime(endsInput.value) || 'No end'}`,
          body: `File: ${b.originalName || b.fileName || 'Bulletin file'}`
        };
        renderBulletinsPreview();
      };
      [titleInput, startsInput, endsInput].forEach((el) => el.addEventListener('input', syncBulletinDraftPreview));
      syncBulletinDraftPreview();

      const fileMeta = document.createElement('div');
      fileMeta.className = 'row__meta';
      fileMeta.textContent = `File: ${b.originalName || b.fileName || 'Bulletin file'}`;

      main.appendChild(titleLabel);
      main.appendChild(startsLabel);
      main.appendChild(endsLabel);
      main.appendChild(fileMeta);
    } else {
      const details = document.createElement('details');
      details.className = 'announceItem';

      const summary = document.createElement('summary');
      summary.className = 'announceItem__summary';
      const t = document.createElement('span');
      t.className = 'row__title';
      t.textContent = `${b.title || 'Bulletin'} • ${b.originalName || ''}`.trim();
      summary.appendChild(t);

      const content = document.createElement('div');
      content.className = 'announceItem__content';
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const active = isActiveBulletin(b);
      meta.textContent = `${active ? 'Active now' : ''}${active ? ' • ' : ''}${toLocalDateTimeValue(b.startsAt)} → ${toLocalDateTimeValue(b.endsAt)}`;
      content.appendChild(meta);

      details.appendChild(summary);
      details.appendChild(content);
      main.appendChild(details);
    }

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const open = document.createElement('a');
    open.className = 'btn';
    open.href = b.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open';
    setActionIconButton(open, 'view', 'View bulletin');

    if (editingBulletinId === b.id) {
      const save = document.createElement('button');
      save.className = 'btn btn--primary';
      save.type = 'button';
      save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const inputs = main.querySelectorAll('input');
        const title = String(inputs[0]?.value || '').trim();
        const startsAt = String(inputs[1]?.value || '').trim();
        const endsAt = String(inputs[2]?.value || '').trim();
        if (!title || !startsAt || !endsAt) {
          showToast('Title, show from, and show until are required.', { variant: 'danger' });
          return;
        }
        if (Date.parse(endsAt) <= Date.parse(startsAt)) {
          showToast('Show until must be after show from.', { variant: 'danger' });
          return;
        }
        if (!confirmWrite('Save changes to this bulletin schedule?')) return;
        await api(`/api/bulletins/${b.id}`, {
          method: 'PUT',
          body: JSON.stringify({ title, startsAt, endsAt })
        });
        bulletinPreviewDraft = null;
        editingBulletinId = null;
        await loadBulletins();
      });

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        bulletinPreviewDraft = null;
        editingBulletinId = null;
        renderBulletins();
      });

      actions.appendChild(open);
      actions.appendChild(save);
      actions.appendChild(cancel);
    } else {
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.type = 'button';
      setActionIconButton(edit, 'edit', 'Edit bulletin');
      edit.addEventListener('click', () => {
        bulletinPreviewDraft = null;
        editingBulletinId = b.id;
        renderBulletins();
      });
      actions.appendChild(open);
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    setActionIconButton(del, 'delete', 'Delete bulletin');
    del.addEventListener('click', async () => {
      if (!confirmWrite('Delete this bulletin?')) return;
      await api(`/api/bulletins/${b.id}`, { method: 'DELETE' });
      bulletinPreviewDraft = null;
      if (editingBulletinId === b.id) editingBulletinId = null;
      await loadBulletins();
    });
    actions.appendChild(del);

    row.appendChild(main);
    row.appendChild(actions);
    root.appendChild(row);
  }

  if (!bulletins.length) root.innerHTML = '<div class="muted">No bulletins scheduled yet.</div>';
}

async function loadBulletins() {
  const data = await api('/api/bulletins', { method: 'GET' });
  bulletins = data.bulletins || [];
  if (editingBulletinId && !bulletins.some((b) => b.id === editingBulletinId)) {
    editingBulletinId = null;
    bulletinPreviewDraft = null;
  }
  renderBulletins();
}

// -------- Users --------
let users = [];

function renderUsers() {
  const root = $('userList');
  root.innerHTML = '';

  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = u.email + (u.isMaster ? ' (master)' : '');
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    meta.textContent = u.createdAt ? formatDate(u.createdAt) : '';

    main.appendChild(t);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    if (!u.isMaster) {
      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      setActionIconButton(del, 'delete', 'Delete admin account');
      del.addEventListener('click', async () => {
        if (!confirm('Delete this admin account?')) return;
        await api(`/api/users/${u.id}`, { method: 'DELETE' });
        await loadUsers();
      });
      actions.appendChild(del);
    }

    row.appendChild(main);
    row.appendChild(actions);
    root.appendChild(row);
  }

  if (!users.length) root.innerHTML = '<div class="muted">No users.</div>';
}

async function loadUsers() {
  const data = await api('/api/users', { method: 'GET' });
  users = data.users || [];
  renderUsers();
}

// -------- Newsletter --------
let subscribers = [];
let newsletterRecords = { drafts: [], scheduled: [], history: [] };
let newsletterRecordsTab = 'drafts';
let newsletterSelectedRecipients = new Set();
let newsletterRecipientSelection = '__all__';

const NEWSLETTER_RECORDS_COLLAPSE_KEY = 'mmmbc_admin_newsletter_records_collapsed_v1';

function getStoredBoolean(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // ignore storage errors
  }
  return fallback;
}

function setStoredBoolean(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore storage errors
  }
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function setPanelCollapse(buttonId, panelId, collapsed, labels) {
  const btn = $(buttonId);
  const panel = $(panelId);
  if (panel) panel.hidden = collapsed;
  if (btn) {
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const show = String(labels?.show || 'Show');
    const hide = String(labels?.hide || 'Hide');
    btn.textContent = collapsed ? show : hide;
  }
}

function updateNewsletterStepSummaries() {
  const payload = buildNewsletterPayloadFromForm();
  const recipients = Array.isArray(payload.emails) ? payload.emails.length : 0;
  const recipientSummary = $('newsletterRecipientSummary');
  if (recipientSummary) {
    recipientSummary.textContent = `This newsletter will be sent to ${recipients} ${recipients === 1 ? 'person' : 'people'}.`;
  }

  const review = $('newsletterReviewSummary');
  if (review) {
    const subject = payload.subject || '(no subject yet)';
    const schedule = (payload.scheduleDate && payload.scheduleTime)
      ? `Scheduled for ${payload.scheduleDate} at ${payload.scheduleTime} ${payload.scheduleTimezone || 'America/Chicago'}.`
      : 'This newsletter will be queued for delivery when you choose Send Now.';
    review.textContent = `${recipients} recipient(s) • Subject: ${subject}. ${schedule}`;
  }
}

function recipientListFiltered() {
  const activeGroup = String($('newsletterGroupSelect')?.value || '').trim();
  return activeGroup
    ? subscribers.filter((s) => String(s.group || '').trim() === activeGroup)
    : subscribers;
}

function renderSubscribers() {
  const groupSel = $('newsletterGroupSelect');
  const recipients = $('newsletterRecipients');
  if (groupSel) groupSel.innerHTML = '<option value="">All groups</option>';
  if (recipients) recipients.innerHTML = '';

  const groups = Array.from(new Set(subscribers.map((s) => String(s.group || 'general').trim() || 'general'))).sort((a, b) => a.localeCompare(b));

  if (groupSel) {
    for (const g of groups) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      groupSel.appendChild(opt);
    }
  }

  const allowedEmails = new Set(subscribers.map((s) => String(s.email || '').trim().toLowerCase()));
  newsletterSelectedRecipients = new Set(Array.from(newsletterSelectedRecipients).filter((email) => allowedEmails.has(email)));

  renderRecipientOptions();
}

function renderRecipientOptions() {
  const recipients = $('newsletterRecipients');
  if (!(recipients instanceof HTMLSelectElement)) return;
  const previousSelection = String(newsletterRecipientSelection || recipients.value || '__all__').trim() || '__all__';

  recipients.innerHTML = '';
  const filtered = recipientListFiltered();
  const filteredEmails = filtered
    .map((s) => String(s.email || '').trim().toLowerCase())
    .filter(Boolean);

  const allOpt = document.createElement('option');
  allOpt.value = '__all__';
  allOpt.textContent = `All subscribers in selected group (${filteredEmails.length})`;
  recipients.appendChild(allOpt);

  for (const s of filtered) {
    const email = String(s.email || '').trim().toLowerCase();
    if (!email) continue;
    const opt = document.createElement('option');
    opt.value = email;
    const group = String(s.group || 'general').trim() || 'general';
    opt.textContent = s.name ? `${s.name} - ${email} (${group})` : `${email} (${group})`;
    recipients.appendChild(opt);
  }

  newsletterRecipientSelection = previousSelection;
  if (!Array.from(recipients.options).some((opt) => String(opt.value) === newsletterRecipientSelection)) {
    newsletterRecipientSelection = '__all__';
  }
  recipients.value = newsletterRecipientSelection;

  if (newsletterRecipientSelection === '__all__') {
    newsletterSelectedRecipients = new Set(filteredEmails);
  } else {
    newsletterSelectedRecipients = new Set([newsletterRecipientSelection]);
  }

  renderNewsletterPreview();
  updateNewsletterStepSummaries();
}

function buildNewsletterPayloadFromForm() {
  return {
    subject: String($('newsletterSubject')?.value || '').trim(),
    message: String($('newsletterMessage')?.value || '').trim(),
    emails: Array.from(newsletterSelectedRecipients),
    scheduleDate: String($('newsletterScheduleDate')?.value || '').trim(),
    scheduleTime: String($('newsletterScheduleTime')?.value || '').trim(),
    scheduleTimezone: String($('newsletterScheduleTimezone')?.value || 'America/Chicago').trim() || 'America/Chicago'
  };
}

function applyNewsletterPayloadToForm(record) {
  const form = $('newsletterForm');
  withProgrammaticFormUpdate(form, () => {
    if ($('newsletterSubject')) $('newsletterSubject').value = String(record?.subject || '');
    if ($('newsletterMessage')) $('newsletterMessage').value = String(record?.message || '');
    if ($('newsletterScheduleDate')) $('newsletterScheduleDate').value = String(record?.scheduleDate || '');
    if ($('newsletterScheduleTime')) $('newsletterScheduleTime').value = String(record?.scheduleTime || '');
    if ($('newsletterScheduleTimezone')) $('newsletterScheduleTimezone').value = String(record?.scheduleTimezone || 'America/Chicago');
    const emails = Array.isArray(record?.emails) ? record.emails : [];
    const normalized = emails.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
    newsletterSelectedRecipients = new Set(normalized);
    newsletterRecipientSelection = normalized.length === 1 ? normalized[0] : '__all__';
    renderRecipientOptions();
    renderNewsletterPreview();
  });
}

function detectBrowserTimeZone() {
  try {
    const tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
    return tz;
  } catch {
    return '';
  }
}

function applyDetectedNewsletterTimezone() {
  const select = $('newsletterScheduleTimezone');
  const hint = $('newsletterTimezoneHint');
  if (!(select instanceof HTMLSelectElement)) return;

  const detected = detectBrowserTimeZone();
  if (!detected) {
    if (hint) hint.textContent = 'Could not auto-detect your browser time zone.';
    return;
  }

  const current = String(select.value || '').trim();
  const hasOption = Array.from(select.options).some((o) => String(o.value) === detected);
  if (!hasOption) {
    const opt = document.createElement('option');
    opt.value = detected;
    opt.textContent = detected;
    select.appendChild(opt);
  }

  if (!current || current === 'America/Chicago') {
    select.value = detected;
  }

  if (hint) hint.textContent = `Detected time zone: ${detected}`;
}

function ensureNewsletterBodyTemplate() {
  const rawField = $('newsletterMessage');
  if (!(rawField instanceof HTMLTextAreaElement)) return;

  const hasAnySectionText = NEWSLETTER_SECTION_FIELDS
    .map(({ fieldId }) => $(fieldId))
    .some((field) => (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && String(field.value || '').trim());

  if (!String(rawField.value || '').trim() && !hasAnySectionText) {
    rawField.value = NEWSLETTER_BODY_TEMPLATE;
  }

  if (hasAnySectionText) {
    syncNewsletterMessageFromSections();
    return;
  }

  populateNewsletterSectionsFromMessage(String(rawField.value || ''));
}

function composeNewsletterMessageFromSections() {
  return NEWSLETTER_SECTION_FIELDS.map(({ heading, fieldId }) => {
    const field = $(fieldId);
    const body = (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)
      ? String(field.value || '').trim()
      : '';
    return `${heading}\n\n${body}`;
  }).join('\n\n');
}

function syncNewsletterMessageFromSections() {
  const rawField = $('newsletterMessage');
  if (!(rawField instanceof HTMLTextAreaElement)) return;
  rawField.value = composeNewsletterMessageFromSections();
}

function parseNewsletterTemplateSections(message) {
  const lines = String(message || '').split(/\r?\n/);
  const sections = new Map(NEWSLETTER_TEMPLATE_SECTIONS.map((name) => [name, []]));
  let activeSection = NEWSLETTER_TEMPLATE_SECTIONS[0];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    const normalized = line.toLowerCase();
    const matchedHeading = NEWSLETTER_TEMPLATE_SECTIONS.find((name) => normalized === name.toLowerCase());
    const aliasedHeading = NEWSLETTER_SECTION_ALIASES[normalized];
    const resolvedHeading = matchedHeading || aliasedHeading;
    if (resolvedHeading) {
      activeSection = resolvedHeading;
      continue;
    }
    sections.get(activeSection).push(rawLine);
  }

  const out = {};
  for (const sectionName of NEWSLETTER_TEMPLATE_SECTIONS) {
    out[sectionName] = (sections.get(sectionName) || []).join('\n').trim();
  }
  return out;
}

function populateNewsletterSectionsFromMessage(message) {
  const parsed = parseNewsletterTemplateSections(message);
  for (const { heading, fieldId } of NEWSLETTER_SECTION_FIELDS) {
    const field = $(fieldId);
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) continue;
    field.value = String(parsed[heading] || '').trim();
  }
}

function bindNewsletterSectionEditor() {
  for (const { fieldId } of NEWSLETTER_SECTION_FIELDS) {
    const field = $(fieldId);
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) continue;
    field.addEventListener('input', () => {
      syncNewsletterMessageFromSections();
      renderNewsletterPreview();
      updateNewsletterStepSummaries();
    });
  }

  const rawField = $('newsletterMessage');
  if (rawField instanceof HTMLTextAreaElement) {
    rawField.addEventListener('input', () => {
      populateNewsletterSectionsFromMessage(String(rawField.value || ''));
      renderNewsletterPreview();
      updateNewsletterStepSummaries();
    });
  }

  const weekOfField = $('newsletterWeekOfDate');
  if (weekOfField instanceof HTMLInputElement) {
    weekOfField.addEventListener('change', () => {
      syncNewsletterMessageFromSections();
      renderNewsletterPreview();
      updateNewsletterStepSummaries();
    });
  }
}

function formatNewsletterWeekOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Week of';
  const date = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(date.getTime())) return `Week of ${raw}`;
  return `Week of ${date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
}

function setNewsletterRecordsTab(nextTab) {
  newsletterRecordsTab = ['drafts', 'scheduled', 'history'].includes(nextTab) ? nextTab : 'drafts';
  const tabs = {
    drafts: $('newsletterRecordsTabDrafts'),
    scheduled: $('newsletterRecordsTabScheduled'),
    history: $('newsletterRecordsTabHistory')
  };
  const panels = {
    drafts: $('newsletterRecordsDrafts'),
    scheduled: $('newsletterRecordsScheduled'),
    history: $('newsletterRecordsHistory')
  };
  for (const [key, btn] of Object.entries(tabs)) {
    if (btn) btn.setAttribute('aria-selected', key === newsletterRecordsTab ? 'true' : 'false');
  }
  for (const [key, panel] of Object.entries(panels)) {
    if (panel) panel.hidden = key !== newsletterRecordsTab;
  }
}

function renderNewsletterRecordsList(container, records, { emptyLabel, includeStatus } = {}) {
  if (!container) return;
  if (!Array.isArray(records) || !records.length) {
    container.innerHTML = `<div class="muted">${String(emptyLabel || 'No records found.')}</div>`;
    return;
  }
  const rows = records.map((r) => {
    const id = String(r.id || '');
    const subject = String(r.subject || '(no subject)');
    const modifiedAt = String(r.updatedAt || r.createdAt || '').trim();
    const when = modifiedAt ? new Date(modifiedAt).toLocaleString() : 'Unknown date';
    const statusText = includeStatus ? `<span class="statusChip">${String(r.status || '').trim() || 'unknown'}</span>` : '';
    return `
      <div class="row newsletterRecordRow" data-newsletter-record-id="${id}">
        <div class="row__main">
          <strong>${subject}</strong>
          <div class="row__meta">${when}</div>
          ${statusText}
        </div>
        <div class="toolbar">
          <button class="btn" type="button" data-action="load" data-newsletter-record-id="${id}">Load</button>
          <button class="btn actionIconBtn" type="button" data-action="delete" data-newsletter-record-id="${id}" aria-label="Delete newsletter record" title="Delete newsletter record"><span class="srOnly">Delete newsletter record</span>${actionIconSvg('delete')}</button>
        </div>
      </div>
    `;
  }).join('');
  container.innerHTML = rows;
}

function renderNewsletterRecords() {
  renderNewsletterRecordsList($('newsletterRecordsDrafts'), newsletterRecords.drafts, {
    emptyLabel: 'No drafts saved yet.',
    includeStatus: false
  });
  renderNewsletterRecordsList($('newsletterRecordsScheduled'), newsletterRecords.scheduled, {
    emptyLabel: 'No scheduled newsletters.',
    includeStatus: true
  });
  renderNewsletterRecordsList($('newsletterRecordsHistory'), newsletterRecords.history, {
    emptyLabel: 'No send history yet.',
    includeStatus: true
  });
  renderNewsletterPreview();
}

async function loadNewsletterRecords() {
  try {
    const data = await api('/api/newsletter/records', { method: 'GET' });
    newsletterRecords = {
      drafts: Array.isArray(data?.drafts) ? data.drafts : [],
      scheduled: Array.isArray(data?.scheduled) ? data.scheduled : [],
      history: Array.isArray(data?.history) ? data.history : []
    };
  } catch {
    newsletterRecords = { drafts: [], scheduled: [], history: [] };
  }
  renderNewsletterRecords();
}

async function mutateNewsletterRecord(action, payload) {
  const data = await api('/api/newsletter/records', {
    method: 'POST',
    body: JSON.stringify({ action, ...payload })
  });
  newsletterRecords = {
    drafts: Array.isArray(data?.drafts) ? data.drafts : [],
    scheduled: Array.isArray(data?.scheduled) ? data.scheduled : [],
    history: Array.isArray(data?.history) ? data.history : []
  };
  renderNewsletterRecords();
  return data;
}

async function loadSubscribers() {
  try {
    const data = await api('/api/subscribers', { method: 'GET' });
    subscribers = Array.isArray(data?.subscribers) ? data.subscribers : [];
  } catch {
    subscribers = [];
  }
  renderSubscribers();
}

function renderNewsletterPreview() {
  const preview = $('newsletterLivePreview');
  if (!preview) return;
  const payload = buildNewsletterPayloadFromForm();
  const subject = payload.subject || 'Newsletter subject';
  const message = payload.message || '';
  const recipients = Array.isArray(payload.emails) ? payload.emails : [];
  const parsedSections = parseNewsletterTemplateSections(message);
  const weekOfDate = String(parsedSections['Week of date'] || '').trim();
  const bodyHeader = String(parsedSections['Header'] || '').trim() || 'Weekly Newsletter Header';
  const welcomeBody = String(parsedSections['Welcome'] || '').trim() || 'Add the welcome message for this newsletter issue.';
  const contactLine = String(parsedSections['Contact line'] || '').trim() || 'www.mmmbc.com';
  const footerLine = String(parsedSections['Footer line'] || '').trim() || 'Mt. Moriah Newsletter';

  const contentSections = [
    { heading: 'Announcements', body: String(parsedSections['Announcements'] || '').trim() || 'Add announcements for this week.' },
    { heading: 'Events', body: String(parsedSections['Events'] || '').trim() || 'Add event details, dates, and times.' },
    { heading: 'Ministry updates', body: String(parsedSections['Ministry updates'] || '').trim() || 'Add ministry updates and highlights.' },
    { heading: 'Pastor message', body: String(parsedSections['Pastor message'] || '').trim() || 'Add the pastor message for this issue.' }
  ];

  const sectionMarkup = contentSections.map(({ heading, body }, index) => {
    const step = String(index + 1).padStart(2, '0');
    return `
      <section class="newsletterTemplate__section">
        <div class="newsletterTemplate__sectionHeading">
          <div class="newsletterTemplate__step">${step}</div>
          <h5 class="newsletterTemplate__sectionTitle">${escapeHtml(heading)}</h5>
        </div>
        <p class="newsletterTemplate__sectionBody">${escapeHtml(body).replace(/\n/g, '<br />')}</p>
      </section>
    `;
  }).join('');

  preview.innerHTML = `
    <article class="newsletterTemplate">
      <div class="newsletterTemplate__masthead">
        <div class="newsletterTemplate__headerGrid">
          <div class="newsletterTemplate__logoWrap">
            <img class="newsletterTemplate__logo" src="/ConImg/MtMoriahLogo-1.png" alt="Mt. Moriah logo" />
          </div>
          <div class="newsletterTemplate__titleWrap">
            <div class="newsletterTemplate__kicker">Mt. Moriah Missionary Baptist Church</div>
            <h4 class="newsletterTemplate__title">${escapeHtml(subject)}</h4>
            <div class="newsletterTemplate__tagline">Building Faith. Strengthening Families. Serving Our Community.</div>
          </div>
        </div>
        <div class="newsletterTemplate__weekOf">${escapeHtml(formatNewsletterWeekOf(weekOfDate))}</div>
      </div>
      <div class="newsletterTemplate__body">
        <section class="newsletterTemplate__intro">
          <h5 class="newsletterTemplate__bodyHeader">${escapeHtml(bodyHeader)}</h5>
          <p class="newsletterTemplate__welcomeBody">${escapeHtml(welcomeBody).replace(/\n/g, '<br />')}</p>
        </section>
        ${sectionMarkup}
      </div>
      <div class="newsletterTemplate__footer">
        <div class="newsletterTemplate__footerLineWrap"><span>${escapeHtml(contactLine)}</span><span class="newsletterTemplate__footerSep">|</span><span>${escapeHtml(footerLine)}</span></div>
        <div class="newsletterTemplate__footerPills">${recipients.length ? recipients.map((email) => `<span class="previewPill">${escapeHtml(email)}</span>`).join('') : '<span class="previewPill previewPill--muted">Recipient list will appear here</span>'}</div>
      </div>
    </article>
  `;
  updateNewsletterStepSummaries();
}

// -------- Users & Roles Settings --------
const settingsState = {
  roles: [],
  page: 1,
  pageSize: 25,
  totalPages: 1,
  pendingConfirm: null
};

const SETTINGS_PERMISSION_ROWS = [
  { label: 'Announcements', view: 'announcements.view', manage: ['announcements.manage'] },
  { label: 'Events', view: 'events.view', manage: ['events.manage'] },
  { label: 'Photos', view: 'photos.view', manage: ['photos.manage'] },
  { label: 'Newsletter', view: 'newsletter.view', manage: ['newsletter.manage'] },
  { label: 'Directory', view: 'directory.view', manage: ['directory.manage'] },
  { label: 'Help & Support', view: 'support.send', manage: ['support.send'] },
  { label: 'Users & Roles', view: 'users.manage', manage: ['users.manage'] }
];

function settingsCell(text, tagName = 'td') {
  const cell = document.createElement(tagName);
  cell.textContent = String(text ?? '');
  return cell;
}

function settingsDate(value, fallback = 'Never') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return raw;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function settingsShortDate(value, fallback = 'Never') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return raw;
  const date = new Date(timestamp);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

function settingsRoleByKey(key) {
  return settingsState.roles.find((role) => String(role.key) === String(key));
}

function settingsRoleAccess(role, row) {
  const permissions = new Set(Array.isArray(role?.permissions) ? role.permissions.map(String) : []);
  if (row.manage.some((permission) => permissions.has(permission))) return 'Manage';
  if (permissions.has(row.view)) return 'View';
  return 'No access';
}

function settingsRoleSelect(selectedKey, ariaLabel) {
  const select = document.createElement('select');
  select.className = 'select settingsRoleSelect';
  select.setAttribute('aria-label', ariaLabel);
  for (const role of settingsState.roles) {
    const option = document.createElement('option');
    option.value = String(role.key || '');
    option.textContent = String(role.label || role.key || 'Role');
    option.selected = option.value === String(selectedKey || '');
    select.appendChild(option);
  }
  return select;
}

function renderSettingsRoleSummary() {
  const root = $('settingsSelectedRoleSummary');
  const select = $('settingsAddRole');
  if (!root || !select) return;
  const role = settingsRoleByKey(select.value);
  root.replaceChildren();
  if (!role) return;
  const title = document.createElement('strong');
  title.textContent = String(role.label || role.key || 'Selected role');
  const description = document.createElement('p');
  description.textContent = String(role.description || '');
  const access = document.createElement('p');
  access.className = 'muted';
  access.textContent = `Access: ${SETTINGS_PERMISSION_ROWS.map((row) => `${row.label}: ${settingsRoleAccess(role, row)}`).join('; ')}`;
  root.append(title, description, access);
}

function renderSettingsRoles() {
  const head = $('settingsRolesHead');
  const body = $('settingsRolesBody');
  const addRole = $('settingsAddRole');
  const roleFilter = $('settingsRoleFilter');
  if (!head || !body || !addRole || !roleFilter) return;

  const headRow = document.createElement('tr');
  headRow.appendChild(settingsCell('Area', 'th'));
  for (const role of settingsState.roles) headRow.appendChild(settingsCell(role.label || role.key, 'th'));
  head.replaceChildren(headRow);

  const rows = SETTINGS_PERMISSION_ROWS.map((permissionRow) => {
    const row = document.createElement('tr');
    row.appendChild(settingsCell(permissionRow.label, 'th'));
    for (const role of settingsState.roles) {
      const level = settingsRoleAccess(role, permissionRow);
      const cell = settingsCell(level);
      cell.dataset.access = level.toLowerCase().replace(/\s+/g, '-');
      row.appendChild(cell);
    }
    return row;
  });
  body.replaceChildren(...rows);

  const priorAddRole = addRole.value || 'website_editor';
  const priorFilter = roleFilter.value;
  addRole.replaceChildren();
  roleFilter.replaceChildren(new Option('All roles', ''));
  for (const role of settingsState.roles) {
    const addOption = new Option(String(role.label || role.key), String(role.key || ''));
    addOption.selected = addOption.value === priorAddRole;
    addRole.appendChild(addOption);
    roleFilter.appendChild(new Option(String(role.label || role.key), String(role.key || '')));
  }
  if (Array.from(roleFilter.options).some((option) => option.value === priorFilter)) roleFilter.value = priorFilter;
  renderSettingsRoleSummary();
}

function settingsActionLabel(action) {
  return {
    'user.created': 'Added administrator',
    'user.updated': 'Changed administrator role or name',
    'user.activated': 'Activated administrator',
    'user.suspended': 'Suspended administrator',
    'user.reactivated': 'Reactivated administrator',
    'user.revoked': 'Revoked administrator access'
  }[String(action || '')] || String(action || '').replace(/[._]/g, ' ');
}

function openSettingsConfirmation(message, onConfirm, onCancel = null) {
  const dialog = $('settingsConfirmDialog');
  const messageNode = $('settingsConfirmMessage');
  if (!(dialog instanceof HTMLDialogElement) || !messageNode) return;
  settingsState.pendingConfirm = { onConfirm, onCancel };
  messageNode.textContent = String(message || 'Confirm this administrator change.');
  openManagedDialog(dialog, { initialFocusId: 'settingsConfirmCancelBtn' });
}

async function runSettingsMutation(path, options, successMessage) {
  const status = $('settingsUsersStatus');
  if (status) status.textContent = 'Saving change...';
  try {
    await api(path, options);
    showToast(successMessage, { variant: 'success' });
    await Promise.all([loadSettingsUsers(), loadSettingsAudit()]);
  } catch (error) {
    if (status) status.textContent = String(error?.message || 'The administrator change could not be saved.');
    showToast(String(error?.message || 'The administrator change could not be saved.'), { variant: 'danger' });
  }
}

function renderSettingsUsers(data) {
  const body = $('settingsUsersBody');
  const status = $('settingsUsersStatus');
  const pageInfo = $('settingsUsersPageInfo');
  if (!body || !status || !pageInfo) return;
  const users = Array.isArray(data?.users) ? data.users : [];
  const pagination = data?.pagination || {};
  settingsState.page = Number(pagination.page || 1);
  settingsState.totalPages = Math.max(1, Number(pagination.totalPages || 1));

  const rows = users.map((user) => {
    const row = document.createElement('tr');
    row.appendChild(settingsCell(user.fullName || user.name || 'Not provided'));
    row.appendChild(settingsCell(user.email || ''));

    const roleCell = document.createElement('td');
    const roleSelect = settingsRoleSelect(user.role, `Role for ${String(user.fullName || user.email || 'administrator')}`);
    roleSelect.addEventListener('change', () => {
      const nextRole = roleSelect.value;
      const previousRole = String(user.role || '');
      const role = settingsRoleByKey(nextRole);
      openSettingsConfirmation(
        `Change ${String(user.fullName || user.email || 'this administrator')} to ${String(role?.label || nextRole)}?`,
        () => runSettingsMutation(`/api/admin/settings/users/${encodeURIComponent(String(user.id || ''))}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: nextRole })
        }, 'Administrator role updated.'),
        () => { roleSelect.value = previousRole; }
      );
    });
    roleCell.appendChild(roleSelect);
    row.appendChild(roleCell);

    const statusCell = settingsCell(String(user.status || 'unknown').replace(/\b\w/g, (character) => character.toUpperCase()));
    statusCell.dataset.status = String(user.status || '').toLowerCase();
    row.appendChild(statusCell);
    row.appendChild(settingsCell(settingsShortDate(user.lastLoginAt)));
    row.appendChild(settingsCell(settingsShortDate(user.createdAt, 'Unknown')));

    const actionsCell = document.createElement('td');
    actionsCell.className = 'settingsUserActions';
    const actions = {
      pending: ['activate'],
      active: ['suspend', 'revoke'],
      suspended: ['reactivate', 'revoke'],
      revoked: ['reactivate']
    }[String(user.status || '').toLowerCase()] || [];
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action === 'revoke' ? 'btn btn--danger' : 'btn';
      button.textContent = action.replace(/\b\w/g, (character) => character.toUpperCase());
      button.addEventListener('click', () => {
        openSettingsConfirmation(
          `${button.textContent} access for ${String(user.fullName || user.email || 'this administrator')}?`,
          () => runSettingsMutation(`/api/admin/settings/users/${encodeURIComponent(String(user.id || ''))}/${action}`, {
            method: 'POST',
            body: '{}'
          }, `Administrator ${action}d.`)
        );
      });
      actionsCell.appendChild(button);
    }
    row.appendChild(actionsCell);
    return row;
  });

  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = settingsCell('No administrators match these filters.');
    cell.colSpan = 7;
    row.appendChild(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
  status.textContent = `${Number(pagination.total || users.length)} administrator${Number(pagination.total || users.length) === 1 ? '' : 's'}`;
  pageInfo.textContent = `Page ${settingsState.page} of ${settingsState.totalPages}`;
  $('settingsUsersPrevBtn').disabled = settingsState.page <= 1;
  $('settingsUsersNextBtn').disabled = settingsState.page >= settingsState.totalPages;
}

function renderSettingsAudit(data) {
  const body = $('settingsAuditBody');
  if (!body) return;
  const entries = Array.isArray(data?.audit) ? data.audit : (Array.isArray(data?.entries) ? data.entries : []);
  const rows = entries.map((entry) => {
    const row = document.createElement('tr');
    row.appendChild(settingsCell(entry.actorEmail || 'System'));
    row.appendChild(settingsCell(settingsActionLabel(entry.action)));
    row.appendChild(settingsCell(entry.targetEmail || 'Not applicable'));
    row.appendChild(settingsCell(settingsDate(entry.createdAt, 'Unknown')));
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = settingsCell('No administrator activity has been recorded yet.');
    cell.colSpan = 4;
    row.appendChild(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
}

async function loadSettingsRoles() {
  const data = await api('/api/admin/settings/roles', { method: 'GET' });
  settingsState.roles = Array.isArray(data?.roles) ? data.roles : [];
  renderSettingsRoles();
}

async function loadSettingsUsers() {
  const query = new URLSearchParams({ page: String(settingsState.page), pageSize: String(settingsState.pageSize) });
  const search = String($('settingsUserSearch')?.value || '').trim();
  const role = String($('settingsRoleFilter')?.value || '').trim();
  const status = String($('settingsStatusFilter')?.value || '').trim();
  if (search) query.set('q', search);
  if (role) query.set('role', role);
  if (status) query.set('status', status);
  const data = await api(`/api/admin/settings/users?${query.toString()}`, { method: 'GET' });
  renderSettingsUsers(data);
}

async function loadSettingsAudit() {
  const data = await api('/api/admin/settings/users/audit?page=1&pageSize=10', { method: 'GET' });
  renderSettingsAudit(data);
}

async function loadSettings() {
  if (!currentPermissions.has(USERS_MANAGE_PERMISSION)) return;
  const status = $('settingsUsersStatus');
  if (status) status.textContent = 'Loading administrators...';
  try {
    if (!settingsState.roles.length) await loadSettingsRoles();
    await Promise.all([loadSettingsUsers(), loadSettingsAudit()]);
  } catch (error) {
    if (status) status.textContent = String(error?.message || 'Settings could not be loaded.');
  }
}

// The unified shell loads a module only when it becomes visible. Existing forms
// keep their original event handlers, APIs, and unsaved-change guards.
const workspaceLoadedSections = new Set();
window.MMWorkspaceLoadSection = async (panel) => {
  if (workspaceLoadedSections.has(panel)) return;
  const loaders = {
    'tab-photos': () => loadGallery(),
    'tab-content': () => Promise.all([loadAnnouncements(), loadBulletins()]),
    'tab-events': () => loadEvents(),
    'tab-directory': () => window.AdminDirectory?.refresh(),
    'tab-newsletter': () => Promise.all([loadSubscribers(), loadNewsletterRecords()]),
    'tab-settings': () => loadSettings()
  };
  if (loaders[panel]) await loaders[panel]();
  workspaceLoadedSections.add(panel);
  applyPermissionVisibility(true);
  document.getElementById(panel)?.querySelectorAll('form[id]').forEach(resetUnsavedBaseline);
};

function renderStorageHealthStatus(data) {
  const summary = $('adminStorageHealthSummary');
  const details = $('adminStorageHealthDetails');
  if (!summary || !details) return;

  if (!data || typeof data !== 'object') {
    summary.textContent = 'Diagnostics unavailable.';
    summary.className = 'hint diagnosticStatus diagnosticStatus--error';
    details.textContent = '';
    return;
  }

  const checks = data.checks || {};
  const statuses = [
    ['Admin database (D1)', checks.adminDatabase],
    ['Site database (D1)', checks.siteDatabase],
    ['Gallery bucket (R2)', checks.galleryBucket],
    ['Static assets', checks.staticAssets]
  ];
  const degraded = data.degraded === true || statuses.some(([, status]) => !['healthy', 'configured'].includes(status));
  summary.textContent = degraded ? 'Storage health degraded.' : 'Storage health OK.';
  summary.className = `hint diagnosticStatus diagnosticStatus--${degraded ? 'error' : 'ok'}`;
  details.replaceChildren();
  const mode = document.createElement('div');
  mode.textContent = `Active mode: ${String(data?.storage?.mode || 'Cloudflare D1 + R2')}.`;
  details.append(mode);
  for (const [label, rawStatus] of statuses) {
    const status = String(rawStatus || 'unknown');
    const row = document.createElement('div');
    row.textContent = `${label}: `;
    const value = document.createElement('span');
    value.className = `diagnosticStatus diagnosticStatus--${['healthy', 'configured'].includes(status) ? 'ok' : 'error'}`;
    value.textContent = status;
    row.append(value);
    details.append(row);
  }
}

async function loadAdminStorageHealth() {
  const card = $('adminStorageHealthCard');
  const summary = $('adminStorageHealthSummary');
  const details = $('adminStorageHealthDetails');
  if (!card || !summary || !details) return;

  summary.textContent = 'Checking storage health…';
  summary.className = 'hint diagnosticStatus';
  details.textContent = '';

  try {
    const data = await api('/api/admin/storage-health', { method: 'GET' });
    renderStorageHealthStatus(data);
  } catch (err) {
    summary.textContent = err instanceof Error ? err.message : 'Storage diagnostics failed.';
    summary.className = 'hint diagnosticStatus diagnosticStatus--error';
    details.textContent = '';
  }
}

// Small public bridge for focused admin modules. Keeping the shared request and
// unsaved-change handling here means section-specific editors use the same CSRF,
// session-expiry, and navigation behavior as the rest of the dashboard.
window.MMBCAdmin = Object.assign(window.MMBCAdmin || {}, {
  api,
  confirmWrite,
  resetUnsavedBaseline,
  updateUnsavedForForm
});

// -------- Wire UI --------
document.addEventListener('DOMContentLoaded', async () => {
  updateHeaderBumper();
  updateLayoutMetrics();
  window.addEventListener('resize', () => {
    try { updateLayoutMetrics(); } catch { /* ignore */ }
    try { queueHeaderNavLayoutSync(); } catch { /* ignore */ }
  });

  resetTransientUiState();

  applyAppearancePreference(getAppearancePreference());
  document.querySelectorAll('[data-appearance-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = String(button.getAttribute('data-appearance-mode') || 'light').toLowerCase();
      try { window.localStorage.setItem(APPEARANCE_PREF_KEY, value); } catch { /* ignore */ }
      applyAppearancePreference(value);
      if ($('appearanceHint')) {
        $('appearanceHint').textContent = value === 'system' ? 'Using your device appearance setting.' : `${value[0].toUpperCase()}${value.slice(1)} appearance selected.`;
      }
    });
  });
  if ($('adminStorageHealthRefreshBtn')) {
    $('adminStorageHealthRefreshBtn').addEventListener('click', async () => {
      await loadAdminStorageHealth();
    });
  }
  if ($('appearanceSelect')) {
    $('appearanceSelect').value = getAppearancePreference();
    $('appearanceSelect').addEventListener('change', () => {
      const value = String($('appearanceSelect').value || 'light');
      try { window.localStorage.setItem(APPEARANCE_PREF_KEY, value); } catch { /* ignore */ }
      applyAppearancePreference(value);
      if ($('appearanceHint')) {
        $('appearanceHint').textContent = value === 'system' ? 'Using your device appearance setting.' : `${value[0].toUpperCase()}${value.slice(1)} appearance selected.`;
      }
    });
  }
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', () => {
        if (getAppearancePreference() === 'system') applyAppearancePreference('system');
      });
    }
  } catch {
    // ignore
  }

  // If the page is restored from bfcache (back/forward), DOMContentLoaded
  // may not run; this ensures transient UI stays reset.
  window.addEventListener('pageshow', () => {
    try { updateHeaderBumper(); } catch { /* ignore */ }
    try { resetTransientUiState(); } catch { /* ignore */ }
  });

  setAdminDrawerOpen(false, { restoreFocus: false });
  if ($('navDrawerToggle')) {
    renderDrawerToggleButton($('navDrawerToggle'), false);
    $('navDrawerToggle').addEventListener('click', () => {
      setAdminDrawerOpen(!adminDrawerOpen, { restoreFocus: false });
    });
  }
  if ($('adminDrawerBackdrop')) {
    $('adminDrawerBackdrop').addEventListener('click', () => {
      setAdminDrawerOpen(false, { restoreFocus: true });
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && adminDrawerOpen) {
      e.preventDefault();
      setAdminDrawerOpen(false, { restoreFocus: true });
      return;
    }
    trapDrawerFocus(e);
  });

  if ($('submissionsRefreshBtn')) $('submissionsRefreshBtn').addEventListener('click', () => loadWebsiteSubmissions().catch(() => {}));
  if ($('submissionsSearch')) $('submissionsSearch').addEventListener('input', () => {
    window.clearTimeout(submissionsSearchTimer);
    submissionsSearchTimer = window.setTimeout(() => loadWebsiteSubmissions({ resetPage: true }).catch(() => {}), 250);
  });
  if ($('submissionsPrevBtn')) $('submissionsPrevBtn').addEventListener('click', () => {
    submissionsOffset = Math.max(0, submissionsOffset - SUBMISSIONS_PAGE_SIZE);
    loadWebsiteSubmissions().catch(() => {});
  });
  if ($('submissionsNextBtn')) $('submissionsNextBtn').addEventListener('click', () => {
    submissionsOffset += SUBMISSIONS_PAGE_SIZE;
    loadWebsiteSubmissions().catch(() => {});
  });
  if ($('submissionDialogCloseBtn')) $('submissionDialogCloseBtn').addEventListener('click', closeSubmissionDialog);
  if ($('submissionDialog')) {
    $('submissionDialog').addEventListener('click', (event) => { if (event.target === $('submissionDialog')) closeSubmissionDialog(); });
    $('submissionDialog').addEventListener('close', () => {
      const dialog = $('submissionDialog');
      const trigger = dialog._returnFocus;
      dialog.dataset.submissionId = '';
      if (trigger?.isConnected) trigger.focus();
      loadWebsiteSubmissions().catch(() => {});
    });
  }
  document.querySelectorAll('[data-submission-type-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      submissionsTypeFilter = String(chip.getAttribute('data-submission-type-filter') || 'all').toLowerCase();
      loadWebsiteSubmissions({ resetPage: true }).catch(() => {});
    });
  });

  // The single navigation handler for tabs, dashboard shortcuts, and data-section-target links.
  document.addEventListener('click', (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('.tab--nav,[data-section-target]') : null;
    if (!trigger) return;
    const target = String(trigger.getAttribute('data-section-target') || trigger.getAttribute('aria-controls') || '').trim();
    if (!target) return;
    event.preventDefault();
    activateMainSection(target, {
      subTabId: String(trigger.getAttribute('data-subtab-target') || '').trim(),
      closeDrawer: true
    });
  });

  queueHeaderNavLayoutSync();

  if ($('settingsRefreshBtn')) $('settingsRefreshBtn').addEventListener('click', () => loadSettings());
  if ($('settingsAddRole')) $('settingsAddRole').addEventListener('change', renderSettingsRoleSummary);
  const settingsRolesDialog = $('settingsRolesDialog');
  if ($('settingsRolesBtn') && settingsRolesDialog instanceof HTMLDialogElement) {
    $('settingsRolesBtn').addEventListener('click', () => openManagedDialog(settingsRolesDialog, { initialFocusId: 'settingsRolesDialogCloseBtn' }));
  }
  if ($('settingsRolesDialogCloseBtn') && settingsRolesDialog instanceof HTMLDialogElement) {
    $('settingsRolesDialogCloseBtn').addEventListener('click', () => closeManagedDialog(settingsRolesDialog));
  }
  if (settingsRolesDialog instanceof HTMLDialogElement) wireDialogDismissBehavior(settingsRolesDialog);
  if ($('settingsUserFilters')) {
    $('settingsUserFilters').addEventListener('submit', async (event) => {
      event.preventDefault();
      settingsState.page = 1;
      await loadSettingsUsers();
    });
  }
  if ($('settingsUsersPrevBtn')) {
    $('settingsUsersPrevBtn').addEventListener('click', async () => {
      if (settingsState.page <= 1) return;
      settingsState.page -= 1;
      await loadSettingsUsers();
    });
  }
  if ($('settingsUsersNextBtn')) {
    $('settingsUsersNextBtn').addEventListener('click', async () => {
      if (settingsState.page >= settingsState.totalPages) return;
      settingsState.page += 1;
      await loadSettingsUsers();
    });
  }
  if ($('settingsAddUserForm')) {
    $('settingsAddUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const hint = $('settingsAddHint');
      const formData = new FormData(form);
      if (hint) hint.textContent = 'Adding administrator...';
      try {
        await api('/api/admin/settings/users', {
          method: 'POST',
          body: JSON.stringify({
            fullName: String(formData.get('fullName') || '').trim(),
            email: String(formData.get('email') || '').trim().toLowerCase(),
            role: String(formData.get('role') || ''),
            status: String(formData.get('status') || 'pending')
          })
        });
        form.reset();
        $('settingsAddStatus').value = 'pending';
        renderSettingsRoleSummary();
        if (hint) hint.textContent = 'Administrator added.';
        showToast('Administrator added.', { variant: 'success' });
        settingsState.page = 1;
        await Promise.all([loadSettingsUsers(), loadSettingsAudit()]);
      } catch (error) {
        if (hint) hint.textContent = String(error?.message || 'The administrator could not be added.');
      }
    });
  }

  const settingsConfirmDialog = $('settingsConfirmDialog');
  const cancelSettingsConfirmation = () => {
    const pending = settingsState.pendingConfirm;
    settingsState.pendingConfirm = null;
    if (typeof pending?.onCancel === 'function') pending.onCancel();
    if (settingsConfirmDialog instanceof HTMLDialogElement) closeManagedDialog(settingsConfirmDialog);
  };
  if ($('settingsConfirmCancelBtn')) $('settingsConfirmCancelBtn').addEventListener('click', cancelSettingsConfirmation);
  if ($('settingsConfirmApplyBtn')) {
    $('settingsConfirmApplyBtn').addEventListener('click', async () => {
      const pending = settingsState.pendingConfirm;
      settingsState.pendingConfirm = null;
      if (settingsConfirmDialog instanceof HTMLDialogElement) closeManagedDialog(settingsConfirmDialog);
      if (typeof pending?.onConfirm === 'function') await pending.onConfirm();
    });
  }
  if (settingsConfirmDialog instanceof HTMLDialogElement) {
    wireDialogDismissBehavior(settingsConfirmDialog, { onClose: cancelSettingsConfirmation });
  }

  // Sub-tabs
  if ($('subTabBtn-content-announcements')) {
    $('subTabBtn-content-announcements').addEventListener('click', () => setContentSubTab('panel-content-announcements'));
  }
  if ($('subTabBtn-content-bulletins')) {
    $('subTabBtn-content-bulletins').addEventListener('click', () => setContentSubTab('panel-content-bulletins'));
  }

  if ($('subTabBtn-photos-manage')) {
    $('subTabBtn-photos-manage').addEventListener('click', () => setPhotosSubTab('panel-photos-manage'));
  }
  // Default Photo Gallery view
  if ($('panel-photos-manage') && $('panel-photos-bucket')) {
    // Keep login clean; bucket browsing requires auth.
    setPhotosSubTab('panel-photos-manage');
  }
  if ($('subTabBtn-directory-contacts')) {
    $('subTabBtn-directory-contacts').addEventListener('click', () => setDirectorySubTab('panel-directory-contacts'));
  }
  if ($('subTabBtn-directory-subscribers')) {
    $('subTabBtn-directory-subscribers').addEventListener('click', () => setDirectorySubTab('panel-directory-subscribers'));
  }
  if ($('subTabBtn-directory-groups')) {
    $('subTabBtn-directory-groups').addEventListener('click', () => setDirectorySubTab('panel-directory-groups'));
  }

  applyDetectedNewsletterTimezone();
  ensureNewsletterBodyTemplate();
  bindNewsletterSectionEditor();
  renderNewsletterPreview();
  updateNewsletterStepSummaries();

  const unsavedFormIds = [
    'announceForm',
    'eventForm',
    'bulletinForm',
    'newsletterForm',
    'photoUploadForm',
    'supportForm',
    'directoryContactForm',
    'ministriesPageForm'
  ];
  for (const formId of unsavedFormIds) {
    const form = $(formId);
    if (!(form instanceof HTMLFormElement)) continue;
    resetUnsavedBaseline(form);
    form.addEventListener('input', () => updateUnsavedForForm(form));
    form.addEventListener('change', () => updateUnsavedForForm(form));
    form.addEventListener('reset', () => {
      window.setTimeout(() => resetUnsavedBaseline(form), 0);
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (!hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = UNSAVED_WARNING_TEXT;
  });

  if ($('printEventsAllBtn')) {
    $('printEventsAllBtn').addEventListener('click', async () => {
      closeDetailsMenu('eventsPrintMenu');
      if (!Array.isArray(events) || !events.length) {
        try { await loadEvents(); } catch { /* ignore */ }
      }
      setPrintMode('events');
      setEventsPrintHeader('Events report', [`All events (${events.length})`]);
      renderEventsPrintReport(events, 'Events Report — All Events');
      window.print();
    });
  }

  if ($('printEventsGroupBtn')) {
    $('printEventsGroupBtn').addEventListener('click', async () => {
      const title = String($('printEventsGroupTitle')?.value || '').trim();
      if (!title) return;
      closeDetailsMenu('eventsPrintMenu');
      if (!Array.isArray(events) || !events.length) {
        try { await loadEvents(); } catch { /* ignore */ }
      }
      const rows = events.filter((e) => normalizeTitle(e?.title) === title);
      setPrintMode('events');
      setEventsPrintHeader('Events report', [`Group: ${title}`, `${rows.length} event(s)`]);
      renderEventsPrintReport(rows, `Events Report — ${title}`);
      window.print();
    });
  }

  if ($('printEventBtn')) {
    $('printEventBtn').addEventListener('click', async () => {
      const id = String($('printEventId')?.value || '').trim();
      if (!id) return;
      closeDetailsMenu('eventsPrintMenu');
      if (!Array.isArray(events) || !events.length) {
        try { await loadEvents(); } catch { /* ignore */ }
      }
      const ev = events.find((e) => String(e?.id || '') === id);
      const rows = ev ? [ev] : [];
      const label = ev ? `${String(ev?.date || '')} ${formatEventTime12h(ev?.time)} ${normalizeTitle(ev?.title)}`.trim() : `Event ID: ${id}`;
      setPrintMode('events');
      setEventsPrintHeader('Events report', [`Single: ${label}`, `${rows.length} event(s)`]);
      renderEventsPrintReport(rows, 'Events Report — Single Event');
      window.print();
    });
  }

  // Support
  if ($('supportForm')) {
    $('supportForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('supportHint');
      const errEl = $('supportError');
      if (errEl) errEl.hidden = true;
      if (hint) hint.textContent = '';

      const fd = new FormData(e.currentTarget);
      const subject = String(fd.get('subject') || '').trim();
      const message = String(fd.get('message') || '').trim();
      const replyTo = String(fd.get('replyTo') || '').trim();

      if (!subject || !message) return;

      if (hint) hint.textContent = 'Sending…';
      try {
        await api('/api/support/message', {
          method: 'POST',
          body: JSON.stringify({ subject, message, replyTo })
        });
        if (hint) hint.textContent = '';
        showToast('Email sent to support.', { variant: 'success' });
        safeResetForm(e);
        const supportForm = $('supportForm');
        if (supportForm instanceof HTMLFormElement) resetUnsavedBaseline(supportForm);
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
        if (hint) hint.textContent = '';
        showToast(`Email failed: ${String(err?.message || 'Unable to send email.')}`, { variant: 'danger' });
      }
    });
  }

  // Newsletter subscribers
  if ($('newsletterGroupSelect')) {
    $('newsletterGroupSelect').addEventListener('change', () => renderRecipientOptions());
  }
  if ($('newsletterRecipients')) {
    $('newsletterRecipients').addEventListener('change', () => {
      const value = String($('newsletterRecipients').value || '__all__').trim() || '__all__';
      newsletterRecipientSelection = value;
      const filteredEmails = recipientListFiltered()
        .map((s) => String(s.email || '').trim().toLowerCase())
        .filter(Boolean);
      newsletterSelectedRecipients = value === '__all__'
        ? new Set(filteredEmails)
        : new Set([value]);
      renderNewsletterPreview();
      updateNewsletterStepSummaries();
    });
  }

  setPanelCollapse(
    'newsletterRecordsToggle',
    'newsletterRecordsPanel',
    getStoredBoolean(NEWSLETTER_RECORDS_COLLAPSE_KEY, true),
    { show: 'Show Records', hide: 'Hide Records' }
  );
  if ($('newsletterRecordsToggle')) {
    $('newsletterRecordsToggle').addEventListener('click', () => {
      const collapsed = !$('newsletterRecordsPanel') || !$('newsletterRecordsPanel').hidden;
      setPanelCollapse('newsletterRecordsToggle', 'newsletterRecordsPanel', collapsed, {
        show: 'Show Records',
        hide: 'Hide Records'
      });
      setStoredBoolean(NEWSLETTER_RECORDS_COLLAPSE_KEY, collapsed);
    });
  }

  setNewsletterRecordsTab('drafts');
  if ($('newsletterRecordsTabDrafts')) $('newsletterRecordsTabDrafts').addEventListener('click', () => setNewsletterRecordsTab('drafts'));
  if ($('newsletterRecordsTabScheduled')) $('newsletterRecordsTabScheduled').addEventListener('click', () => setNewsletterRecordsTab('scheduled'));
  if ($('newsletterRecordsTabHistory')) $('newsletterRecordsTabHistory').addEventListener('click', () => setNewsletterRecordsTab('history'));

  const writeNewsletterError = (text) => {
    const errEl = $('newsletterError');
    if (!errEl) return;
    if (!text) {
      errEl.hidden = true;
      errEl.textContent = '';
      return;
    }
    errEl.hidden = false;
    errEl.textContent = String(text);
  };

  const validateNewsletterPayload = (payload, { requireSchedule = false } = {}) => {
    if (!payload.subject || !payload.message) return 'Subject and message are required.';
    if (!Array.isArray(payload.emails) || !payload.emails.length) return 'Select at least one recipient.';
    if (requireSchedule && (!payload.scheduleDate || !payload.scheduleTime || !payload.scheduleTimezone)) {
      return 'Schedule date, time, and time zone are required.';
    }
    return '';
  };

  let newsletterTestRecipientEmails = [];

  const renderNewsletterTestRecipientChips = () => {
    const list = $('newsletterTestRecipientsList');
    if (!list) return;
    list.innerHTML = '';
    for (const email of newsletterTestRecipientEmails) {
      const chip = document.createElement('span');
      chip.className = 'newsletterRecipientChip';
      chip.textContent = email;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'newsletterRecipientChipRemove';
      removeBtn.setAttribute('aria-label', `Remove ${email}`);
      removeBtn.textContent = 'x';
      removeBtn.addEventListener('click', () => {
        newsletterTestRecipientEmails = newsletterTestRecipientEmails.filter((x) => x !== email);
        renderNewsletterTestRecipientChips();
      });

      chip.appendChild(removeBtn);
      list.appendChild(chip);
    }
  };

  const commitNewsletterTestRecipients = ({ finalizeAll = false } = {}) => {
    const input = $('newsletterTestRecipientsInput');
    if (!(input instanceof HTMLInputElement)) return;
    const raw = String(input.value || '');
    const hasDelimiter = raw.includes(',');
    if (!hasDelimiter && !finalizeAll) return;

    const parts = raw.split(',');
    const keep = (!finalizeAll && parts.length > 0) ? String(parts.pop() || '').trim() : '';
    const candidates = parts.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean);
    const invalid = candidates.filter((email) => !validEmail(email));
    const valid = candidates.filter((email) => validEmail(email));

    if (finalizeAll) {
      const trailing = String(keep || '').trim().toLowerCase();
      if (trailing) {
        if (validEmail(trailing)) valid.push(trailing);
        else invalid.push(trailing);
      }
    }

    if (invalid.length) {
      writeNewsletterError(`Invalid test recipient email: ${invalid[0]}`);
    }

    newsletterTestRecipientEmails = Array.from(new Set([
      ...newsletterTestRecipientEmails,
      ...valid
    ]));
    input.value = keep;
    renderNewsletterTestRecipientChips();
  };

  if ($('newsletterTestRecipientsInput')) {
    $('newsletterTestRecipientsInput').addEventListener('input', () => {
      commitNewsletterTestRecipients({ finalizeAll: false });
    });
    $('newsletterTestRecipientsInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.key === 'Enter') e.preventDefault();
        commitNewsletterTestRecipients({ finalizeAll: true });
      }
    });
    $('newsletterTestRecipientsInput').addEventListener('blur', () => {
      commitNewsletterTestRecipients({ finalizeAll: true });
    });
  }

  if ($('newsletterSendNowBtn')) {
    $('newsletterSendNowBtn').addEventListener('click', async () => {
      const hint = $('newsletterHint');
      const payload = buildNewsletterPayloadFromForm();
      writeNewsletterError('');

      const validationError = validateNewsletterPayload(payload);
      if (validationError) {
        writeNewsletterError(validationError);
        return;
      }

      if (!confirmWrite(`Send newsletter to ${payload.emails.length} recipient(s)?`)) return;
      if (hint) hint.textContent = 'Sending…';
      try {
        const out = await api('/api/newsletter/send', {
          method: 'POST',
          body: JSON.stringify({
            subject: payload.subject,
            message: payload.message,
            emails: payload.emails
          })
        });
        if (hint) hint.textContent = out?.disabled ? 'Sending is disabled on this server.' : out?.queued ? 'Queued for delivery. Check newsletter history for the result.' : `Sent to ${Number(out?.sent || 0)} recipient(s).`;
        await loadNewsletterRecords();
        const newsletterForm = $('newsletterForm');
        if (newsletterForm instanceof HTMLFormElement) resetUnsavedBaseline(newsletterForm);
      } catch (err) {
        if (hint) hint.textContent = '';
        writeNewsletterError(err.message);
      }
    });
  }

  if ($('newsletterSendTestBtn')) {
    $('newsletterSendTestBtn').addEventListener('click', async () => {
      const hint = $('newsletterHint');
      const payload = buildNewsletterPayloadFromForm();
      writeNewsletterError('');
      commitNewsletterTestRecipients({ finalizeAll: true });
      if (!payload.subject || !payload.message) {
        writeNewsletterError('Subject and message are required for test send.');
        return;
      }
      const targetLabel = newsletterTestRecipientEmails.length
        ? `${newsletterTestRecipientEmails.length} typed recipient(s)`
        : 'your signed-in account';
      if (!confirmWrite(`Send test email to ${targetLabel}?`)) return;
      if (hint) hint.textContent = 'Sending test…';
      try {
        const out = await api('/api/newsletter/test', {
          method: 'POST',
          body: JSON.stringify({
            subject: payload.subject,
            message: payload.message,
            emails: newsletterTestRecipientEmails
          })
        });
        if (hint) hint.textContent = out?.disabled ? 'Sending is disabled on this server.' : 'Test email sent.';
      } catch (err) {
        if (hint) hint.textContent = '';
        writeNewsletterError(err.message);
      }
    });
  }

  if ($('newsletterSaveDraftBtn')) {
    $('newsletterSaveDraftBtn').addEventListener('click', async () => {
      const hint = $('newsletterHint');
      const payload = buildNewsletterPayloadFromForm();
      writeNewsletterError('');

      const validationError = validateNewsletterPayload(payload);
      if (validationError) {
        writeNewsletterError(validationError);
        return;
      }

      if (!confirmWrite('Save newsletter draft?')) return;
      if (hint) hint.textContent = 'Saving draft…';
      try {
        await mutateNewsletterRecord('save_draft', payload);
        setNewsletterRecordsTab('drafts');
        if (hint) hint.textContent = 'Draft saved.';
        const newsletterForm = $('newsletterForm');
        if (newsletterForm instanceof HTMLFormElement) resetUnsavedBaseline(newsletterForm);
      } catch (err) {
        if (hint) hint.textContent = '';
        writeNewsletterError(err.message);
      }
    });
  }

  if ($('newsletterScheduleBtn')) {
    $('newsletterScheduleBtn').addEventListener('click', async () => {
      const hint = $('newsletterHint');
      const payload = buildNewsletterPayloadFromForm();
      writeNewsletterError('');

      const validationError = validateNewsletterPayload(payload, { requireSchedule: true });
      if (validationError) {
        writeNewsletterError(validationError);
        return;
      }

      if (!confirmWrite('Schedule this newsletter?')) return;
      if (hint) hint.textContent = 'Scheduling…';
      try {
        await mutateNewsletterRecord('schedule', payload);
        setNewsletterRecordsTab('scheduled');
        if (hint) hint.textContent = 'Scheduled.';
        const newsletterForm = $('newsletterForm');
        if (newsletterForm instanceof HTMLFormElement) resetUnsavedBaseline(newsletterForm);
      } catch (err) {
        if (hint) hint.textContent = '';
        writeNewsletterError(err.message);
      }
    });
  }

  for (const id of ['newsletterSubject', 'newsletterMessage', 'newsletterScheduleDate', 'newsletterScheduleTime', 'newsletterScheduleTimezone', 'newsletterGroupSelect']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => renderNewsletterPreview());
    el.addEventListener('change', () => renderNewsletterPreview());
  }

  if ($('newsletterForm')) {
    $('newsletterForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('newsletterSendNowBtn');
      if (btn) btn.click();
    });
  }

  const wireRecordsActions = (containerId) => {
    const el = $(containerId);
    if (!el) return;
    el.addEventListener('click', async (e) => {
      const btn = e.target?.closest?.('button[data-action]');
      if (!btn) return;
      const action = String(btn.getAttribute('data-action') || '').trim();
      const id = String(btn.getAttribute('data-newsletter-record-id') || '').trim();
      if (!id) return;

      const all = [
        ...(newsletterRecords.drafts || []),
        ...(newsletterRecords.scheduled || []),
        ...(newsletterRecords.history || [])
      ];
      const item = all.find((x) => String(x.id) === id);
      if (action === 'load' && item) {
        applyNewsletterPayloadToForm(item);
        return;
      }
      if (action === 'delete') {
        if (!confirmWrite('Delete this newsletter record?')) return;
        try {
          await mutateNewsletterRecord('delete', { id });
        } catch (err) {
          writeNewsletterError(err.message);
        }
      }
    });
  };

  wireRecordsActions('newsletterRecordsDrafts');
  wireRecordsActions('newsletterRecordsScheduled');
  wireRecordsActions('newsletterRecordsHistory');

  const logoutBtn = $('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      window.location.assign('/cdn-cgi/access/logout');
    });
  }

  // Account profile (optional UI)
  const accountForm = $('accountForm');
  if (accountForm) {
    accountForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('accountHint');
      if (!confirmWrite('Save account profile changes?')) return;
      if (hint) hint.textContent = 'Saving…';
      const fd = new FormData(e.currentTarget);
      try {
        await api('/api/account', {
          method: 'PUT',
          body: JSON.stringify({
            name: String(fd.get('name') || ''),
            email: String(fd.get('email') || '')
          })
        });
        if (hint) hint.textContent = 'Saved.';
        await refreshAuthUI();
      } catch (err) {
        if (hint) hint.textContent = err.message;
      }
    });
  }

  // Photo uploads (multipart)
  $('photoUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const hint = $('photoUploadHint');
    const submitBtn = form?.querySelector?.('button[type="submit"]');
    const fileInput = form?.querySelector?.('input[name="images"]');

    const validationError = validateUploadFiles(fileInput?.files, {
      maxFileBytes: PHOTO_UPLOAD_MAX_BYTES,
      maxFiles: PHOTO_UPLOAD_MAX_FILES,
      allowedMimes: IMAGE_UPLOAD_MIME_TYPES,
      label: 'image'
    });
    if (validationError) {
      if (hint) hint.textContent = validationError;
      return;
    }

    if (!confirmWrite('Upload selected photo(s)?')) return;

    hint.textContent = 'Uploading…';
    if (submitBtn) submitBtn.disabled = true;
    markFormUploadState(form, true);

    const fd = new FormData(form);
    try {
      const data = await api('/api/gallery/upload', {
        method: 'POST',
        body: fd
      });

      hint.textContent = `Uploaded ${data?.added?.length || 0} photo(s).`;
      if (form && typeof form.reset === 'function') form.reset();
      resetUnsavedBaseline(form);
      await loadGallery();
    } catch (err) {
      hint.textContent = err.message;
    } finally {
      markFormUploadState(form, false);
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $('photoSort').addEventListener('change', applyPhotoFilters);
  $('photoAlbumFilter').addEventListener('input', applyPhotoFilters);
  $('photoTagFilter').addEventListener('input', applyPhotoFilters);

  if ($('photoShowImageNames')) {
    $('photoShowImageNames').addEventListener('change', async (e) => {
      const input = e.currentTarget;
      const next = Boolean(input?.checked);
      await savePhotoDisplayNameSetting(next);
    });
  }

  initPhotoActionIcons();

  $('photoArrangeAlbum').addEventListener('change', (e) => {
    photoArrangeAlbum = String(e.currentTarget.value || '').trim();
    // If they picked an album, default to manual ordering.
    if (photoArrangeAlbum) {
      const sortSel = $('photoSort');
      if (sortSel) sortSel.value = 'manual';
    }
    applyPhotoFilters();
  });

  // Photo paging (6 rows at a time)
  const photoPageDelta = (delta) => {
    photoCurrentPage = Math.max(1, Number(photoCurrentPage || 1) + Number(delta || 0));
    applyPhotoFilters({ resetPage: false });
  };

  if ($('photoPrevPageBtn')) {
    $('photoPrevPageBtn').addEventListener('click', () => {
      photoPageDelta(-1);
    });
  }
  if ($('photoNextPageBtn')) {
    $('photoNextPageBtn').addEventListener('click', () => {
      photoPageDelta(1);
    });
  }

  if ($('photoPrevPageBtnBottom')) {
    $('photoPrevPageBtnBottom').addEventListener('click', () => {
      photoPageDelta(-1);
    });
  }
  if ($('photoNextPageBtnBottom')) {
    $('photoNextPageBtnBottom').addEventListener('click', () => {
      photoPageDelta(1);
    });
  }

  bindPhotoPageJump('photoPageInfo');
  bindPhotoPageJump('photoPageInfoBottom');

  // Bulk actions
  if ($('photoBulkEditBtn')) {
    $('photoBulkEditBtn').addEventListener('click', async () => {
      const ids = Array.from(photoSelectedIds);
      if (!ids.length) return;

      const nextAlbum = prompt('Album (leave blank to keep unchanged)', '');
      if (nextAlbum === null) return;
      const nextTags = prompt('Tags (comma-separated) (leave blank to keep unchanged)', '');
      if (nextTags === null) return;

      const payload = {};
      const a = String(nextAlbum || '').trim();
      const t = String(nextTags || '').trim();
      if (a) payload.album = a;
      if (t) payload.tags = t;

      if (Object.keys(payload).length === 0) {
        showToast('No changes entered.', { variant: 'danger' });
        return;
      }

      if (!confirmWrite(`Apply updates to ${ids.length} selected photo(s)?`)) {
        try { $('photoBulkEditBtn')?.focus(); } catch { /* ignore */ }
        return;
      }

      const btn = $('photoBulkEditBtn');
      if (btn) {
        btn.disabled = true;
        setActionIconButton(btn, 'edit', 'Editing selected photos...');
      }

      try {
        let ok = 0;
        for (const id of ids) {
          await api(`/api/gallery/${encodeURIComponent(String(id))}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
          });
          ok += 1;
        }
        photoSelectedIds.clear();
        if ($('photoBulkBar')) {
          $('photoBulkBar').dataset.stickyTopSet = '0';
        }
        await loadGallery();
        const msg = `Updated ${ok} selected photo(s).`;
        showToast(msg, { variant: 'success' });
        announceLive(msg);
        try { $('photoBulkEditBtn')?.focus(); } catch { /* ignore */ }
      } catch (e) {
        const msg = `Bulk edit failed: ${String(e?.message || e || 'Unknown error')}`;
        showToast(msg, { variant: 'danger' });
        announceLive(msg);
      } finally {
        if (btn) {
          btn.disabled = false;
        }
        photoUpdateBulkBar();
      }
    });
  }

  if ($('photoBulkDeleteBtn')) {
    $('photoBulkDeleteBtn').addEventListener('click', async () => {
      const ids = Array.from(photoSelectedIds);
      if (!ids.length) return;
      const countLabel = ids.length === 1 ? '1 selected photo' : `${ids.length} selected photos`;
      const confirmed = confirmWrite(
        `Delete ${countLabel}?\n\nThis will remove the selected images from the photo gallery and public website after refresh. This cannot be undone.`
      );
      if (!confirmed) {
        try { $('photoBulkDeleteBtn')?.focus(); } catch { /* ignore */ }
        announceLive('Photo deletion canceled.');
        return;
      }

      const btn = $('photoBulkDeleteBtn');
      if (btn) {
        btn.disabled = true;
        setActionIconButton(btn, 'delete', 'Deleting selected photos...');
      }

      try {
        let ok = 0;
        for (const id of ids) {
          await api(`/api/gallery/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
          ok += 1;
        }
        photoSelectedIds.clear();
        if ($('photoBulkBar')) {
          $('photoBulkBar').dataset.stickyTopSet = '0';
        }
        await loadGallery();
        const msg = `${ok === 1 ? 'One photo was' : `${ok} photos were`} deleted and removed from the public gallery.`;
        showToast(msg, { variant: 'success' });
        announceLive(msg);
        try { $('photoGrid')?.focus(); } catch { /* ignore */ }
      } catch (e) {
        const msg = `Bulk delete failed: ${String(e?.message || e || 'Unknown error')}`;
        showToast(msg, { variant: 'danger' });
        announceLive(msg);
      } finally {
        if (btn) {
          btn.disabled = false;
        }
        photoUpdateBulkBar();
      }
    });
  }

  $('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    if (btn) {
      btn.disabled = true;
      setActionIconButton(btn, 'refresh', 'Refreshing website gallery...');
    }

    // Failsafe: never leave the UI stuck forever.
    const watchdog = window.setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        setActionIconButton(btn, 'refresh', 'Refresh website gallery');
      }
      setR2UiBusy(false);
      setR2Status('Refresh timed out.');
      showToast('Gallery refresh timed out. Please try again.', { variant: 'danger' });
    }, 120_000);

    try {
      // Avoid confirm() here: some embedded browsers/policies block dialogs,
      // which makes the button appear to do nothing.
      const out = await syncFromR2('gallery/', { confirm: false });
      if (out?.canceled) showToast('Gallery refresh canceled.', { variant: 'success' });
    } catch (e) {
      showToast(`Gallery refresh failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
    } finally {
      window.clearTimeout(watchdog);
      if (btn) {
        btn.disabled = false;
        setActionIconButton(btn, 'refresh', 'Refresh website gallery');
      }

      // Never leave the progress meter hanging around after the action.
      if (syncProgressHideTimer) {
        try { window.clearTimeout(syncProgressHideTimer); } catch { /* ignore */ }
      }
      syncProgressHideTimer = window.setTimeout(() => {
        setSyncProgress({ visible: false, text: '' });
      }, 2000);
    }
  });

  // Photo upload instructions help dialog
  if ($('photoHelpDialog')) {
    const dlg = $('photoHelpDialog');
    const openDlg = () => openManagedDialog(dlg, { initialFocusId: 'photoHelpCloseBtn' });
    const closeDlg = () => closeManagedDialog(dlg);

    if ($('photoHelpBtn')) {
      $('photoHelpBtn').addEventListener('click', (e) => {
        e.preventDefault();
        openDlg();
      });

      $('photoHelpBtn').addEventListener('keydown', (e) => {
        const k = String(e.key || '').toLowerCase();
        if (k !== 'enter' && k !== ' ') return;
        e.preventDefault();
        openDlg();
      }, true);
    }
    if ($('photoHelpCloseBtn')) {
      $('photoHelpCloseBtn').addEventListener('click', (e) => {
        e.preventDefault();
        closeDlg();
      });
    }

    wireDialogDismissBehavior(dlg, { onClose: closeDlg });
  }

  if ($('photoViewDialog')) {
    const dlg = $('photoViewDialog');
    const closeDlg = () => {
      const img = $('photoViewImage');
      if (img instanceof HTMLImageElement) img.removeAttribute('src');
      closeManagedDialog(dlg);
    };

    if ($('photoViewCloseBtn')) {
      $('photoViewCloseBtn').addEventListener('click', (e) => {
        e.preventDefault();
        closeDlg();
      });
    }

    wireDialogDismissBehavior(dlg, { onClose: closeDlg });
  }

  if ($('r2GoBtn')) {
    $('r2GoBtn').addEventListener('click', () => {
      const raw = $('r2PrefixInput') ? $('r2PrefixInput').value : 'gallery/';
      loadR2Tree(raw).catch((e) => setR2Status(e.message));
    });
  }
  if ($('r2UpBtn')) {
    $('r2UpBtn').addEventListener('click', () => {
      loadR2Tree(parentR2Prefix(r2Prefix)).catch((e) => setR2Status(e.message));
    });
  }
  if ($('r2RefreshBtn')) {
    $('r2RefreshBtn').addEventListener('click', async () => {
      const raw = $('r2PrefixInput') ? $('r2PrefixInput').value : r2Prefix;
      setR2UiBusy(true);
      setR2Status('Refreshing…');
      try {
        await loadR2Tree(raw);
        // Keep the gallery list in sync with any bucket-side changes.
        await loadGallery();
        setR2Status('Refreshed.');
      } catch (e) {
        setR2Status(e.message);
      } finally {
        setR2UiBusy(false);
      }
    });
  }
  if ($('r2SyncFolderBtn')) {
    $('r2SyncFolderBtn').addEventListener('click', async () => {
      await syncFromR2(r2Prefix);
    });
  }
  if ($('r2PrefixInput')) {
    $('r2PrefixInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = $('r2PrefixInput').value;
      loadR2Tree(raw).catch((err) => setR2Status(err.message));
    });
  }

  if ($('advancedPhotoTools')) {
    $('advancedPhotoTools').addEventListener('toggle', () => {
      if (!$('advancedPhotoTools').open) return;
      loadR2Tree(r2Prefix).catch((e) => setR2Status(e.message));
    });
  }

  // Announcements
  if ($('announceForm')) {
    $('announceForm').addEventListener('input', () => {
      if (!editingAnnouncementId) announcementPreviewDraft = null;
      renderAnnouncementsPreview();
    });
    $('announceForm').addEventListener('change', () => {
      if (!editingAnnouncementId) announcementPreviewDraft = null;
      renderAnnouncementsPreview();
    });

    $('announceForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('announceHint');

      if (!confirmWrite('Post this announcement?')) return;

      hint.textContent = 'Posting…';

      const fd = new FormData(e.currentTarget);
      const never = fd.get('neverExpires') === 'on';
      const expiresInDaysRaw = never ? 0 : fd.get('expiresInDays');
      await api('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({
          title: fd.get('title'),
          body: fd.get('body'),
          expiresInDays: expiresInDaysRaw
        })
      });

      safeResetForm(e);
      announcementPreviewDraft = null;
      hint.textContent = 'Posted.';
      await loadAnnouncements();
      const announceForm = $('announceForm');
      if (announceForm instanceof HTMLFormElement) resetUnsavedBaseline(announceForm);
    });
  }

  // Hash navigation (e.g. /admin/#announcements)
  window.addEventListener('hashchange', () => {
    if (sessionInitialized) applyHashNavigation();
  });

  // Events
  if ($('eventForm')) {
    $('eventForm').addEventListener('input', () => {
      if (!editingEventId) eventPreviewDraft = null;
      renderEventsPreview();
    });
    $('eventForm').addEventListener('change', () => {
      if (!editingEventId) eventPreviewDraft = null;
      renderEventsPreview();
    });

    $('eventForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('eventHint');

      if (!confirmWrite('Save this event?')) return;

      hint.textContent = 'Saving…';

      const fd = new FormData(e.currentTarget);
      await api('/api/events', {
        method: 'POST',
        body: JSON.stringify({
          title: fd.get('title'),
          date: fd.get('date'),
          time: fd.get('time')
        })
      });

      safeResetForm(e);
      eventPreviewDraft = null;
      hint.textContent = 'Saved.';
      await loadEvents();
      const eventForm = $('eventForm');
      if (eventForm instanceof HTMLFormElement) resetUnsavedBaseline(eventForm);
    });
  }

  // Bulletins (multipart)
  if ($('bulletinForm')) {
    $('bulletinForm').addEventListener('input', () => {
      if (!editingBulletinId) bulletinPreviewDraft = null;
      renderBulletinsPreview();
    });
    $('bulletinForm').addEventListener('change', () => {
      if (!editingBulletinId) bulletinPreviewDraft = null;
      renderBulletinsPreview();
    });

    $('bulletinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const hint = $('bulletinHint');
      const submitBtn = form?.querySelector?.('button[type="submit"]');
      const fileInput = form?.querySelector?.('input[name="file"]');

      const validationError = validateUploadFiles(fileInput?.files, {
        maxFileBytes: BULLETIN_UPLOAD_MAX_BYTES,
        maxFiles: 1,
        allowedMimes: BULLETIN_UPLOAD_MIME_TYPES,
        label: 'bulletin file'
      });
      if (validationError) {
        hint.textContent = validationError;
        return;
      }

      if (!confirmWrite('Upload and schedule this bulletin?')) return;

      hint.textContent = 'Uploading…';
      if (submitBtn) submitBtn.disabled = true;
      markFormUploadState(form, true);

      const fd = new FormData(form);
      const createAnnouncement = fd.get('createAnnouncement') === 'on';
      fd.set('createAnnouncement', createAnnouncement ? 'true' : 'false');

      try {
        await api('/api/bulletins/upload', {
          method: 'POST',
          body: fd
        });

        safeResetForm(e);
        bulletinPreviewDraft = null;
        hint.textContent = 'Uploaded.';
        await loadBulletins();
      } catch (err) {
        hint.textContent = err.message;
      } finally {
        markFormUploadState(form, false);
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Time pickers
  if ($('eventTimePicker') && $('eventTime')) initTimePicker('eventTimePicker', 'eventTime', { required: false });

  // Initial
  initializeSession().catch((err) => {
    console.error('Admin initialization failed', err);
    const authStatus = $('authStatus');
    if (authStatus) authStatus.textContent = 'Admin connection needs attention.';
    showSessionWarning(err instanceof Error ? err.message : 'The admin could not finish loading. Refresh and try again.');
  });
});
