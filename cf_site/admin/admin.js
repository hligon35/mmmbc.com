let csrfToken = '';
let csrfReady = Promise.resolve();
let authProviders = { google: { enabled: false, clientId: '' } };
let googleInitializedClientId = '';
let googleRenderedClientId = '';
let googleInitRetryCount = 0;
let googleInitRetryTimer = null;
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
    : trimmed;
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
      <button class="btn" id="sessionWarningRefreshBtn" type="button">Refresh session</button>
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
        await refreshAuthUI();
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
    && !url.startsWith('/api/auth/login')
    && !url.startsWith('/api/auth/logout')
    && !url.startsWith('/api/auth/recover')
    && !url.startsWith('/api/invites/');

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
const dialogFocusRestoreTargets = new WeakMap();

function updateHeaderBumper() {
  const header = document.querySelector?.('.header');
  if (!header) return;
  try {
    const h = Math.max(0, Math.round(header.getBoundingClientRect().height || 0));
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
  btn.setAttribute('aria-label', next ? 'Close Menu' : 'Open Menu');
  btn.textContent = next ? 'Close Menu' : 'Open Menu';

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
    } catch {
      document.body.classList.remove('theme-effective-dark');
      document.body.classList.add('theme-effective-light');
    }
  } else {
    document.body.classList.toggle('theme-effective-dark', selected === 'dark');
    document.body.classList.toggle('theme-effective-light', selected === 'light');
  }
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

function showToast(message, { variant = 'success', timeoutMs = 3500 } = {}) {
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
  toast.setAttribute('role', 'status');
  toast.textContent = text;
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

  setTimeout(remove, Math.max(500, Number(timeoutMs) || 0));
  toast.addEventListener('click', remove);
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

function isWorkersDeployment() {
  // Option B runs on Cloudflare Workers, usually on a *.workers.dev hostname.
  // In that mode, authentication is handled by Cloudflare Access instead of the legacy password form.
  const host = String(window.location.hostname || '').toLowerCase();
  return host.endsWith('.workers.dev');
}

async function loadAuthProviders() {
  try {
    const data = await api('/api/auth/providers', { method: 'GET' });
    const google = data?.google || {};
    authProviders = {
      google: {
        enabled: !!google.enabled,
        clientId: String(google.clientId || '')
      }
    };
  } catch {
    authProviders = { google: { enabled: false, clientId: '' } };
  }
}

function hideGoogleButton() {
  const g = window.google;
  try {
    if (g && g.accounts && g.accounts.id && typeof g.accounts.id.cancel === 'function') {
      g.accounts.id.cancel();
    }
  } catch {
    // ignore
  }
  const btnWrap = $('googleSignInBtn');
  if (btnWrap) btnWrap.innerHTML = '';
  googleRenderedClientId = '';
  googleInitRetryCount = 0;
  if (googleInitRetryTimer) {
    try { window.clearTimeout(googleInitRetryTimer); } catch { /* ignore */ }
    googleInitRetryTimer = null;
  }
}

async function loginWithGoogle(idToken) {
  await api('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ idToken })
  });
  csrfReady = fetchCsrfToken();
  await csrfReady;
}

function initGoogleSignInButton() {
  const hint = $('googleLoginHint');
  const panel = $('googleLoginPanel');
  const wrap = $('googleSignInBtn');
  if (!panel || !wrap || !hint) return;

  if (!authProviders.google.enabled || !authProviders.google.clientId) {
    panel.hidden = false;
    hint.textContent = 'Google sign-in is currently unavailable. Refresh and try again.';
    hideGoogleButton();
    return;
  }

  panel.hidden = false;

  const g = window.google;
  if (!g || !g.accounts || !g.accounts.id) {
    if (googleInitRetryCount < 15) {
      googleInitRetryCount += 1;
      hint.textContent = 'Loading Google sign-in…';
      googleInitRetryTimer = window.setTimeout(() => {
        googleInitRetryTimer = null;
        initGoogleSignInButton();
      }, 250);
      return;
    }
    hint.textContent = 'Google sign-in failed to load. Refresh and try again.';
    return;
  }

  googleInitRetryCount = 0;
  if (googleInitRetryTimer) {
    try { window.clearTimeout(googleInitRetryTimer); } catch { /* ignore */ }
    googleInitRetryTimer = null;
  }

  hint.textContent = 'Use your approved Google account.';

  if (googleInitializedClientId !== authProviders.google.clientId) {
    g.accounts.id.initialize({
      client_id: authProviders.google.clientId,
      callback: async (response) => {
        const token = String(response?.credential || '').trim();
        if (!token) {
          showToast('Google sign-in did not return a credential.', { variant: 'danger' });
          return;
        }
        try {
          await loginWithGoogle(token);
          await refreshAuthUI();
        } catch (err) {
          const el = $('loginError');
          if (el) {
            el.textContent = String(err?.message || 'Google sign-in failed.');
            el.hidden = false;
          }
        }
      }
    });
    googleInitializedClientId = authProviders.google.clientId;
  }

  if (googleRenderedClientId === authProviders.google.clientId && wrap.childElementCount > 0) {
    return;
  }

  wrap.innerHTML = '';

  g.accounts.id.renderButton(wrap, {
    type: 'standard',
    shape: 'rectangular',
    size: 'large',
    text: 'signin_with',
    theme: 'outline',
    logo_alignment: 'left'
  });
  googleRenderedClientId = authProviders.google.clientId;
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
  if (role === 'administrator' || role === 'admin') return 'Administrator';
  if (role === 'finance_entry' || role === 'financeentry' || role === 'finance') return 'Finance Entry';
  if (role === 'treasurer') return 'Treasurer';
  if (role === 'auditor') return 'Auditor';
  if (role === 'website_editor' || role === 'editor' || role === 'website') return 'Website Manager';
  return role ? role.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()) : 'Member';
}

function isAdministratorRole(roleValue) {
  const role = String(roleValue || '').trim().toLowerCase().replace(/\s+/g, '_');
  return role === 'administrator' || role === 'admin';
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

function passwordScore(pw) {
  const p = String(pw || '');
  let score = 0;
  if (p.length >= 8) score += 1;
  if (/[A-Z]/.test(p)) score += 1;
  if (/[^A-Za-z0-9]/.test(p)) score += 1;
  if (p.length >= 12) score += 1;
  return score;
}

function passwordPolicyError(pw) {
  const p = String(pw || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(p)) return 'Password must include at least 1 capital letter.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include at least 1 special character.';
  return '';
}

function wirePeekButtons() {
  const buttons = Array.from(document.querySelectorAll('[data-peek-target]'));
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-peek-target');
      const input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      const isPassword = input.getAttribute('type') === 'password';
      input.setAttribute('type', isPassword ? 'text' : 'password');
      btn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
      btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
    });
  }
}

function wirePasswordMeter(inputId, meterId, textId) {
  const input = $(inputId);
  const meter = $(meterId);
  const text = $(textId);
  if (!input || !meter || !text) return;

  const update = () => {
    const score = passwordScore(input.value);
    meter.value = score;
    const label = score <= 1 ? 'Weak' : score === 2 ? 'Fair' : score === 3 ? 'Good' : 'Strong';
    text.textContent = `Password strength: ${label}`;
  };
  if (!input.dataset.meterWired) {
    input.addEventListener('input', update);
    input.dataset.meterWired = '1';
  }
  update();
}

function setTab(activeId) {
  const tabButtons = [
    $('tabBtn-home'),
    $('tabBtn-photos'),
    $('tabBtn-events'),
    $('tabBtn-content'),
    $('tabBtn-finances'),
    $('tabBtn-directory'),
    $('tabBtn-newsletter'),
    $('tabBtn-support')
  ];
  const panels = [
    $('tab-home'),
    $('tab-photos'),
    $('tab-events'),
    $('tab-content'),
    $('tab-finances'),
    $('tab-directory'),
    $('tab-newsletter'),
    $('tab-support')
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
  const financeTopBar = $('financeTopBar');

  // Legacy section extension is no longer used for finance header layout.
  if (financeTopBar) financeTopBar.hidden = true;
  if (extension) extension.hidden = true;
}

function activateMainSection(sectionId, { subTabId = '' } = {}) {
  if (!sectionId) return;
  const currentPanel = document.querySelector('.tabPanel:not([hidden])');
  if (currentPanel && currentPanel.id !== sectionId && !confirmUnsavedChanges()) {
    return;
  }

  setTab(sectionId);
  closeDrawerAfterNavigation();

  if (sectionId === 'tab-content' && subTabId) {
    setContentSubTab(subTabId);
  }
  if (sectionId === 'tab-photos') {
    setPhotosSubTab(subTabId || 'panel-photos-manage');
  }
  if (sectionId === 'tab-finances') {
    setFinanceSubTab(subTabId || 'panel-finances-record');
  }
  if (sectionId === 'tab-directory') {
    setDirectorySubTab(subTabId || 'panel-directory-contacts');
  }

  const hashMap = {
    'tab-home': 'home',
    'tab-photos': 'photos',
    'tab-events': 'events',
    'tab-content': subTabId === 'panel-content-bulletins' ? 'bulletins' : 'announcements',
    'tab-finances': 'finances',
    'tab-directory': 'directory',
    'tab-newsletter': 'newsletter',
    'tab-support': 'support'
  };
  const nextHash = hashMap[sectionId];
  if (nextHash) {
    try { window.location.hash = nextHash; } catch { /* ignore */ }
  }

  syncHeaderBreadcrumbs();
  syncHeaderContextDescription();

  try {
    window.dispatchEvent(new CustomEvent('admin:section-activated', {
      detail: { sectionId, subTabId: subTabId || '' }
    }));
  } catch {
    // ignore custom-event dispatch failures
  }

  if (sectionId === 'tab-home') {
    try {
      window.dispatchEvent(new CustomEvent('admin:home-activated'));
    } catch {
      // ignore dashboard refresh signaling failures
    }
  }
}

async function refreshAuthUI() {
  let me = { user: null };
  try {
    me = await api('/api/me', { method: 'GET' });
  } catch {
    me = { user: null };
  }
  const loggedIn = !!me.user;
  const canManageUsers = loggedIn
    && (
      (Array.isArray(me.permissions) && me.permissions.includes(USERS_MANAGE_PERMISSION))
      || isAdministratorRole(me?.user?.role)
    );

  const inviteToken = getInviteTokenFromHash();
  const inInviteFlow = !!inviteToken;
  const showSignInScreen = !loggedIn && !inInviteFlow;

  document.body.classList.toggle('authMode', showSignInScreen);

  setAuthenticatedHeaderVisible(loggedIn && !inInviteFlow);

  $('inviteCard').hidden = !inInviteFlow;
  $('loginCard').hidden = !showSignInScreen;
  const authShell = $('authShell');
  if (authShell) authShell.hidden = loggedIn;
  $('dashboardCard').hidden = !loggedIn || inInviteFlow;
  $('logoutBtn').hidden = !loggedIn;
  if ($('inviteAdminBtn')) {
    const inviteButton = $('inviteAdminBtn');
    inviteButton.hidden = !canManageUsers || inInviteFlow;
    inviteButton.disabled = !canManageUsers || inInviteFlow;
    inviteButton.style.display = 'inline-flex';
    inviteButton.style.pointerEvents = 'auto';
    inviteButton.style.position = 'relative';
    inviteButton.style.zIndex = '20';
  }
  if ($('adminStorageHealthCard')) $('adminStorageHealthCard').hidden = !canManageUsers || inInviteFlow;

  if (!loggedIn && !inInviteFlow) {
    const form = $('loginForm');
    const forgotToggle = $('forgotToggle');
    const forgotPanel = $('forgotPanel');
    if (form) form.hidden = false;
    if (forgotToggle) forgotToggle.hidden = false;
    if (forgotPanel) forgotPanel.hidden = true;
    await loadAuthProviders();
    initGoogleSignInButton();
  }

  const nameOrEmail = String(me?.user?.name || me?.user?.email || '').trim();
  const roleLabel = formatUserRoleLabel(me?.user?.role);
  $('authStatus').textContent = loggedIn
    ? `Signed in as ${nameOrEmail || String(me.user.email || '').trim()}`
    : '';

  if (loggedIn) {
    const nowHour = new Date().getHours();
    const greeting = nowHour < 12 ? 'Good morning' : (nowHour < 18 ? 'Good afternoon' : 'Good evening');
    $('salutation').textContent = `${greeting}, ${roleLabel}`;
    const homeWelcome = $('homeWelcomeLine');
    if (homeWelcome) homeWelcome.textContent = nameOrEmail ? `${greeting}, ${nameOrEmail}` : 'Welcome';
    const avatarText = $('avatarText');
    if (avatarText) avatarText.textContent = getInitials(me.user);
  } else {
    $('salutation').textContent = '';
    const homeWelcome = $('homeWelcomeLine');
    if (homeWelcome) homeWelcome.textContent = 'Welcome';
    updateActiveSectionExtensions('');
  }

  if (loggedIn) {
    csrfReady = fetchCsrfToken();
    await csrfReady;
    await loadAll();
    if (canManageUsers) {
      await loadAdminStorageHealth();
    }
    applyHashNavigation();
    setAdminDrawerOpen(getStoredDrawerPreference(), { restoreFocus: false });
    resetAllUnsavedBaselines();
  } else {
    setAdminDrawerOpen(false, { restoreFocus: false });
  }

  if (inInviteFlow) {
    await loadInvite(inviteToken);
  }

  syncHeaderBreadcrumbs();
  syncHeaderContextDescription();
  updateLayoutMetrics();
}

async function login(email, password) {
  await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password
    })
  });

  csrfReady = fetchCsrfToken();
  await csrfReady;
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  csrfToken = '';
  csrfReady = Promise.resolve();
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function normalizeHash() {
  return String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
}

function getInviteTokenFromHash() {
  const raw = String(window.location.hash || '').replace(/^#/, '').trim();
  const m = raw.match(/(?:^|&)invite=([^&]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function applyHashNavigation() {
  const h = normalizeHash();
  if (!h) {
    activateMainSection('tab-home');
    return;
  }

  if (/invite=/.test(h)) return;

  if (h === 'home') activateMainSection('tab-home');
  if (h === 'photos') activateMainSection('tab-photos', { subTabId: 'panel-photos-manage' });
  if (h === 'events') activateMainSection('tab-events');
  if (h === 'content') {
    activateMainSection('tab-content', { subTabId: 'panel-content-announcements' });
  }
  if (h === 'finances' || h === 'finance') activateMainSection('tab-finances');
  if (h === 'directory') activateMainSection('tab-directory', { subTabId: 'panel-directory-contacts' });
  if (h === 'newsletter') activateMainSection('tab-newsletter');
  if (h === 'support') activateMainSection('tab-support');

  if (h === 'announcements') {
    activateMainSection('tab-content', { subTabId: 'panel-content-announcements' });
  }

  if (h === 'bulletins') {
    activateMainSection('tab-content', { subTabId: 'panel-content-bulletins' });
  }
}

// -------- Finances --------
let finances = { entries: [], meta: { categories: [], funds: [] } };
// Real, registered church funds (from /api/finances/funds) — the source of truth the
// server validates against when saving an entry. Distinct from the legacy free-text
// `finances.meta.funds` name list used only for filter-dropdown history.
let financeFundsRegistry = [];
let financeQuickKind = '';
let financeGivingPeriod = 'week';

async function loadFinanceFundsRegistry() {
  try {
    const res = await api('/api/finances/funds', { method: 'GET' });
    financeFundsRegistry = Array.isArray(res?.funds) ? res.funds : [];
  } catch {
    financeFundsRegistry = [];
  }
}

function financeActiveFunds() {
  return (Array.isArray(financeFundsRegistry) ? financeFundsRegistry : [])
    .filter((f) => f?.active !== false)
    .slice()
    .sort((a, b) => String(a?.fundName || '').localeCompare(String(b?.fundName || '')));
}

function financeFundNameById(id) {
  const key = String(id || '').trim();
  if (!key) return '';
  const match = (Array.isArray(financeFundsRegistry) ? financeFundsRegistry : []).find((f) => String(f?.id || '') === key);
  return match ? String(match.fundName || '') : '';
}

function formatMoneyCents(cents) {
  const n = Number(cents || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function setFinanceHint(text) {
  const el = $('financeHint');
  if (!el) return;
  el.textContent = String(text || '');
}

function financeSelectedTypes() {
  const incomeEl = $('financeTypeIncome');
  const expenseEl = $('financeTypeExpense');

  // Backward compatible: fall back to the legacy single-select if the new checkboxes aren't present.
  if (!incomeEl && !expenseEl) {
    const legacy = $('financeTypeFilter');
    const t = String(legacy?.value || '').trim();
    return t ? [t] : [];
  }

  const types = [];
  if (incomeEl?.checked) types.push('income');
  if (expenseEl?.checked) types.push('expense');

  // If none or both are selected, treat it as "All".
  if (types.length === 0 || types.length === 2) return [];
  return types;
}

function financeNormalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function financeDetectKindFromEntry(entry) {
  const t = financeNormalizeKey(entry?.type);
  if (t === 'expense') return 'expense';
  if (t === 'income') {
    const cat = financeNormalizeKey(entry?.category);
    if (cat.includes('tithe')) return 'tithes';
    if (cat.includes('offering')) return 'offerings';
    return 'income';
  }
  return 'income';
}

function financeApplyKindToForm(kind) {
  const typeEl = $('financeType');
  if (typeEl) typeEl.value = (kind === 'expense') ? 'expense' : 'income';

  const dateLabel = $('financeDateLabelText');
  if (dateLabel) dateLabel.textContent = (kind === 'expense') ? 'Date paid' : 'Date received';

  const catLabel = $('financeCategoryLabelText');
  if (catLabel) catLabel.textContent = (kind === 'expense') ? 'What was the expense for?' : 'What kind of giving?';

  const catHint = $('financeCategoryHint');
  if (catHint) {
    catHint.textContent = (kind === 'expense')
      ? 'Choose what the payment was for.'
      : 'Choose what the money was received for.';
  }

  const fundLabel = $('financeFundLabelText');
  if (fundLabel) fundLabel.textContent = 'Which church fund?';

  const partyLabel = $('financePartyLabel');
  const partyInput = $('financeParty');
  if (partyLabel) partyLabel.textContent = (kind === 'expense') ? 'Paid To' : 'Received From (optional)';
  if (partyInput instanceof HTMLInputElement) {
    partyInput.required = false; // Validated explicitly in the wizard step logic instead of native required.
  }

  const question = $('financeDirectionQuestion');
  if (question) question.textContent = 'What are you recording?';

  const incomeBtn = $('financeChoiceIncomeBtn');
  const expenseBtn = $('financeChoiceExpenseBtn');
  if (incomeBtn) incomeBtn.setAttribute('aria-pressed', kind === 'expense' ? 'false' : 'true');
  if (expenseBtn) expenseBtn.setAttribute('aria-pressed', kind === 'expense' ? 'true' : 'false');
}

function financeSetQuickKind(kind, { render = true, toggle = false } = {}) {
  const requested = financeNormalizeKey(kind);
  if (!requested) return;
  // Clicking the already-active filter turns it off (shows all again).
  financeQuickKind = (toggle && financeQuickKind === requested) ? '' : requested;

  // Sync the Money Received / Money Spent filter buttons in Review Transactions.
  const tabs = $('financeQuickTabs');
  if (tabs) {
    const btns = Array.from(tabs.querySelectorAll('[data-fin-kind]'));
    for (const b of btns) {
      const v = String(b.getAttribute('data-fin-kind') || '');
      b.setAttribute('aria-pressed', v === financeQuickKind ? 'true' : 'false');
    }
  }

  // Sync the type checkboxes in the filter menu.
  const incomeCb = $('financeTypeIncome');
  const expenseCb = $('financeTypeExpense');
  if (incomeCb instanceof HTMLInputElement && expenseCb instanceof HTMLInputElement) {
    if (financeQuickKind === 'expense') {
      incomeCb.checked = false;
      expenseCb.checked = true;
    } else if (financeQuickKind === 'income') {
      incomeCb.checked = true;
      expenseCb.checked = false;
    } else {
      incomeCb.checked = true;
      expenseCb.checked = true;
    }
  }

  if (render) renderFinances();
}

function financeDateRangeSelection() {
  const checked = document.querySelector('input[name="financeDateRange"]:checked');
  const value = String(checked?.value || '').trim().toLowerCase();
  if (value === '7' || value === '30' || value === '90' || value === 'custom' || value === 'all') return value;
  return 'all';
}

function financeCustomRangeValidation() {
  const from = String($('financeFrom')?.value || '').trim();
  const to = String($('financeTo')?.value || '').trim();
  if (!from || !to) {
    return { ok: false, from, to, message: 'Choose both From and To dates.' };
  }
  if (from > to) {
    return { ok: false, from, to, message: 'From date cannot be after To date.' };
  }
  return { ok: true, from, to, message: '' };
}

function financeRangeFromSelection(selection) {
  const sel = String(selection || 'all').trim().toLowerCase();
  if (sel === 'custom') {
    const check = financeCustomRangeValidation();
    return {
      from: check.ok ? check.from : '',
      to: check.ok ? check.to : '',
      rangeError: check.ok ? '' : check.message
    };
  }
  if (sel === '7' || sel === '30' || sel === '90') {
    const days = Number(sel);
    const to = isoDateToday();
    const from = addDaysToIsoDate(to, -(days - 1));
    return { from, to, rangeError: '' };
  }
  return { from: '', to: '', rangeError: '' };
}

function financeDateRangeLabel(filters) {
  const selection = String(filters?.dateRange || 'all');
  if (selection === '7') return 'Last 7 days (inclusive)';
  if (selection === '30') return 'Last 30 days (inclusive)';
  if (selection === '90') return 'Last 90 days (inclusive)';
  if (selection === 'custom') {
    if (filters?.from && filters?.to) return `Custom: ${filters.from} to ${filters.to} (To date inclusive)`;
    return 'Custom date range';
  }
  return 'All dates';
}

function financeRenderFilterSummary(filters, rowCount) {
  const el = $('financeFilterSummary');
  if (!el) return;

  const types = Array.isArray(filters?.types) ? filters.types : [];
  let kindPhrase = 'all transactions';
  if (types.length === 1 && types[0] === 'income') kindPhrase = 'Money Received';
  else if (types.length === 1 && types[0] === 'expense') kindPhrase = 'Money Spent';

  const selection = String(filters?.dateRange || 'all');
  let rangePhrase = 'all dates';
  if (selection === '7') rangePhrase = 'the last 7 days';
  else if (selection === '30') rangePhrase = 'the last 30 days';
  else if (selection === '90') rangePhrase = 'the last 90 days';
  else if (selection === 'custom' && filters?.from && filters?.to) rangePhrase = `${filters.from} to ${filters.to}`;

  const extra = [];
  if (filters?.category) extra.push(`category "${filters.category}"`);
  if (filters?.fund) extra.push(`fund "${filters.fund}"`);
  if (filters?.method) extra.push(`payment method "${financeMethodLabel(filters.method)}"`);
  const searchText = String(filters?.search || '').trim();
  if (searchText) extra.push(`search "${searchText}"`);
  const extraPhrase = extra.length ? `, filtered by ${extra.join(', ')}` : '';

  const countText = Number.isFinite(Number(rowCount)) ? ` (${rowCount} matching)` : '';
  el.textContent = `Showing ${kindPhrase} from ${rangePhrase}${extraPhrase}${countText}.`;
}

function financeCurrentFilters() {
  const selectedTypes = financeSelectedTypes();
  const dateRange = financeDateRangeSelection();
  const range = financeRangeFromSelection(dateRange);
  return {
    from: range.from,
    to: range.to,
    dateRange,
    rangeError: range.rangeError,
    type: String($('financeTypeFilter')?.value || ''),
    types: selectedTypes,
    kind: String(financeQuickKind || ''),
    search: String($('financeSearch')?.value || '').trim().toLowerCase(),
    category: String($('financeFilterCategory')?.value || '').trim(),
    fund: String($('financeFilterFund')?.value || '').trim(),
    method: String($('financeFilterMethod')?.value || '').trim()
  };
}

function setFinanceRangePreset(days) {
  const fromEl = $('financeFrom');
  const toEl = $('financeTo');
  if (!fromEl || !toEl) return;

  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return;

  const to = isoDateToday();
  const from = addDaysToIsoDate(to, -(d - 1));
  fromEl.value = from;
  toEl.value = to;
}

function setFinanceCustomMode(enabled) {
  const panel = $('financeCustomRange');
  if (!panel) return;
  panel.hidden = !enabled;
}

function financeEntryMatches(entry, filters) {
  const date = String(entry?.date || '');
  if (filters.from && date && date < filters.from) return false;
  if (filters.to && date && date > filters.to) return false;

  const entryType = financeNormalizeKey(entry?.type);
  if (Array.isArray(filters.types) && filters.types.length > 0) {
    if (!filters.types.includes(entryType)) return false;
  } else if (filters.type && entryType !== filters.type) {
    // Legacy single-select support
    return false;
  }

  const kind = String(filters?.kind || '').trim();
  if (kind === 'income' && entryType !== 'income') return false;
  if (kind === 'expense' && entryType !== 'expense') return false;
  if (kind === 'tithes') {
    if (entryType !== 'income') return false;
    if (!financeNormalizeKey(entry?.category).includes('tithe')) return false;
  }
  if (kind === 'offerings') {
    if (entryType !== 'income') return false;
    if (!financeNormalizeKey(entry?.category).includes('offering')) return false;
  }

  if (filters.category && financeNormalizeKey(entry?.category) !== financeNormalizeKey(filters.category)) return false;
  if (filters.fund && financeNormalizeKey(entry?.fund) !== financeNormalizeKey(filters.fund)) return false;
  if (filters.method && financeNormalizeKey(entry?.method) !== financeNormalizeKey(filters.method)) return false;

  if (filters.search) {
    const hay = [
      entry?.category,
      entry?.fund,
      entry?.method,
      entry?.party,
      entry?.memo,
      entry?.type,
      entry?.date
    ].map((v) => String(v || '').toLowerCase()).join(' ');
    if (!hay.includes(filters.search)) return false;
  }
  return true;
}

function populateFinanceDatalists() {
  const catSel = $('financeCategory');
  const fundSel = $('financeFund');

  const categories = Array.isArray(finances?.meta?.categories) ? finances.meta.categories : [];
  const funds = Array.isArray(finances?.meta?.funds) ? finances.meta.funds : [];

  const setOptions = (sel, values, { required = false, allowDelete = false } = {}) => {
    if (!(sel instanceof HTMLSelectElement)) return;
    const current = String(sel.value || '');
    sel.innerHTML = '';

    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = required ? '(Pick one)' : '(None)';
    sel.appendChild(blank);

    const unique = Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
    unique.sort((a, b) => a.localeCompare(b));

    // Ensure current value remains selectable even if it isn't in meta.
    if (current && !unique.includes(current) && current !== FIN_CREATE_VALUE && current !== FIN_DELETE_VALUE) unique.unshift(current);

    for (const v of unique) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }

    const createOpt = document.createElement('option');
    createOpt.value = FIN_CREATE_VALUE;
    createOpt.textContent = 'Create…';
    sel.appendChild(createOpt);

    if (allowDelete) {
      const deleteOpt = document.createElement('option');
      deleteOpt.value = FIN_DELETE_VALUE;
      deleteOpt.textContent = 'Delete…';
      sel.appendChild(deleteOpt);
    }

    if (current && Array.from(sel.options).some((o) => o.value === current)) sel.value = current;
  };

  setOptions(catSel, categories, { required: true, allowDelete: true });
  setFundSelectOptions(fundSel);

  const setFilterOptions = (sel, values, allLabel) => {
    if (!(sel instanceof HTMLSelectElement)) return;
    const current = String(sel.value || '');
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = allLabel;
    sel.appendChild(blank);
    const unique = Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
    unique.sort((a, b) => a.localeCompare(b));
    for (const v of unique) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    if (current && Array.from(sel.options).some((o) => o.value === current)) sel.value = current;
  };

  setFilterOptions($('financeFilterCategory'), categories, '(All categories)');
  setFilterOptions($('financeFilterFund'), funds, '(All funds)');
}

// Populates the Record Money wizard's Fund select from the real, registered fund
// records (option value = fund id) so a save always resolves to a valid fund on
// the server \u2014 rather than the legacy free-text `finances.meta.funds` name list,
// which isn't guaranteed to match any actual fund and caused saves to silently fail.
function setFundSelectOptions(sel) {
  if (!(sel instanceof HTMLSelectElement)) return;
  const current = String(sel.value || '');
  sel.innerHTML = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '(Pick a fund)';
  sel.appendChild(blank);

  const activeFunds = financeActiveFunds();
  for (const f of activeFunds) {
    const opt = document.createElement('option');
    opt.value = String(f.id);
    opt.textContent = f.fundCode ? `${f.fundName} (${f.fundCode})` : String(f.fundName || '');
    sel.appendChild(opt);
  }

  if (!activeFunds.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No funds set up yet — add one on the Funds page';
    empty.disabled = true;
    sel.appendChild(empty);
  }

  const createOpt = document.createElement('option');
  createOpt.value = FIN_CREATE_VALUE;
  createOpt.textContent = 'Create…';
  sel.appendChild(createOpt);

  if (activeFunds.length) {
    const deleteOpt = document.createElement('option');
    deleteOpt.value = FIN_DELETE_VALUE;
    deleteOpt.textContent = 'Delete…';
    sel.appendChild(deleteOpt);
  }

  const hint = $('financeFundHint');
  if (hint) {
    hint.textContent = activeFunds.length
      ? 'Choose where this money should be recorded, such as General Fund or Building Fund.'
      : 'No church funds are set up yet. Go to Church Finances → Funds to add one before recording money.';
  }

  if (current && Array.from(sel.options).some((o) => o.value === current)) sel.value = current;
}

function normalizeFinanceName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function financePromptDeleteTarget(kindLabel, names) {
  const options = Array.from(new Set((Array.isArray(names) ? names : [])
    .map((name) => normalizeFinanceName(name))
    .filter(Boolean)));
  if (!options.length) return '';

  options.sort((a, b) => a.localeCompare(b));
  const numbered = options.map((name, index) => `${index + 1}. ${name}`).join('\n');
  const raw = prompt(`Type the ${kindLabel} name or number to delete:\n${numbered}`);
  if (raw === null) return null;
  const typed = normalizeFinanceName(raw);
  if (!typed) return '';

  const asNumber = Number(typed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1];
  }

  const matched = options.find((name) => financeNormalizeKey(name) === financeNormalizeKey(typed));
  return matched || '';
}

async function financeHandleCreateSelect(kind) {
  const sel = kind === 'fund' ? $('financeFund') : $('financeCategory');
  if (!(sel instanceof HTMLSelectElement)) return;
  const selected = String(sel.value || '');
  if (selected !== FIN_CREATE_VALUE && selected !== FIN_DELETE_VALUE) return;

  if (selected === FIN_DELETE_VALUE) {
    sel.value = '';
    if (kind === 'fund') {
      const activeFunds = financeActiveFunds();
      if (!activeFunds.length) {
        setFinanceHint('There are no funds to delete.');
        return;
      }

      const typed = financePromptDeleteTarget('fund', activeFunds.map((fund) => fund?.fundName));
      if (typed === null) return;
      if (!typed) {
        setFinanceHint('Fund not found. Enter an existing fund name.');
        return;
      }

      const matched = activeFunds.find((fund) => financeNormalizeKey(fund?.fundName) === financeNormalizeKey(typed));
      if (!matched) {
        setFinanceHint('Fund not found. Enter an existing fund name.');
        return;
      }

      if (!confirmWrite(`Delete fund "${matched.fundName}"?`)) return;

      setFinanceHint('Deleting fund…');
      try {
        await api(`/api/finances/funds/${encodeURIComponent(String(matched.id || ''))}/archive`, {
          method: 'POST',
          body: '{}'
        });
        await loadFinanceFundsRegistry();
        populateFinanceDatalists();
        setFinanceHint('Fund deleted.');
      } catch (e) {
        setFinanceHint(String(e?.message || e || 'Unable to delete fund.'));
      }
      return;
    }

    if (kind !== 'category') return;

    const currentCats = Array.isArray(finances?.meta?.categories) ? finances.meta.categories : [];
    if (!currentCats.length) {
      setFinanceHint('There are no categories to delete.');
      return;
    }

    const typed = financePromptDeleteTarget('category', currentCats);
    if (typed === null) return;
    if (!typed) {
      setFinanceHint('Category not found. Enter an existing category name.');
      return;
    }

    const matched = currentCats.find((name) => financeNormalizeKey(name) === financeNormalizeKey(typed));
    if (!matched) {
      setFinanceHint('Category not found. Enter an existing category name.');
      return;
    }

    const entries = Array.isArray(finances?.entries) ? finances.entries : [];
    const inUse = entries.some((entry) => financeNormalizeKey(entry?.category) === financeNormalizeKey(matched));
    if (inUse) {
      setFinanceHint('That category is in use by existing ledger entries and cannot be deleted.');
      return;
    }

    if (!confirmWrite(`Delete category "${matched}"?`)) return;

    const currentFunds = Array.isArray(finances?.meta?.funds) ? finances.meta.funds : [];
    const cats = currentCats.filter((name) => financeNormalizeKey(name) !== financeNormalizeKey(matched));

    setFinanceHint('Saving…');
    try {
      const res = await api('/api/finances/meta', {
        method: 'PUT',
        body: JSON.stringify({ categories: cats, funds: currentFunds })
      });
      finances = res.data;
      populateFinanceDatalists();
      setFinanceHint('Category deleted.');
    } catch (e) {
      setFinanceHint(String(e?.message || e || 'Unable to save.'));
    }
    return;
  }

  // Reset immediately so cancel doesn't leave it stuck on the sentinel.
  sel.value = '';

  const label = kind === 'fund' ? 'fund' : 'category';
  const next = normalizeFinanceName(prompt(`Create new ${label} name`));
  if (!next) return;

  if (kind === 'fund') {
    const activeFunds = financeActiveFunds();
    const exists = activeFunds.some((fund) => financeNormalizeKey(fund?.fundName) === financeNormalizeKey(next));
    if (exists) {
      setFinanceHint('That fund already exists.');
      return;
    }

    setFinanceHint('Saving…');
    try {
      const res = await api('/api/finances/funds', {
        method: 'POST',
        body: JSON.stringify({ fundName: next })
      });
      await loadFinanceFundsRegistry();
      populateFinanceDatalists();
      const newId = String(res?.fund?.id || '');
      if (newId && $('financeFund')) $('financeFund').value = newId;
      setFinanceHint('Saved.');
    } catch (e) {
      setFinanceHint(String(e?.message || e || 'Unable to save.'));
    }
    return;
  }

  const currentCats = Array.isArray(finances?.meta?.categories) ? finances.meta.categories : [];
  const currentFunds = Array.isArray(finances?.meta?.funds) ? finances.meta.funds : [];

  const cats = (kind === 'category') ? Array.from(new Set([...currentCats, next])) : currentCats;
  const funds = (kind === 'fund') ? Array.from(new Set([...currentFunds, next])) : currentFunds;

  setFinanceHint('Saving…');
  try {
    const res = await api('/api/finances/meta', {
      method: 'PUT',
      body: JSON.stringify({ categories: cats, funds })
    });
    finances = res.data;
    populateFinanceDatalists();
    if (kind === 'category') $('financeCategory').value = next;
    else $('financeFund').value = next;
    setFinanceHint('Saved.');
  } catch (e) {
    setFinanceHint(String(e?.message || e || 'Unable to save.'));
  }
}

function financeSetEditMode(isEditing) {
  const saveBtn = $('financeSaveBtn');
  const heading = $('financeWizardHeading');
  const reviewHeading = $('financeReviewHeading');
  if (saveBtn) saveBtn.textContent = isEditing ? 'Save Changes' : 'Save Entry';
  if (heading) heading.textContent = isEditing ? 'Edit Transaction' : 'Record Money';
  if (reviewHeading) reviewHeading.textContent = isEditing ? 'Review changes' : 'Review this entry';
  financeWizard.mode = isEditing ? 'edit' : 'add';
}

function financeResetForm() {
  $('financeEditId').value = '';
  $('financeType').value = 'income';
  $('financeCategory').value = '';
  $('financeFund').value = '';
  $('financeMethod').value = '';
  $('financeAmount').value = '';
  $('financeParty').value = '';
  $('financeMemo').value = '';

  // Default date to today if empty.
  if (!$('financeDate').value) {
    $('financeDate').value = new Date().toISOString().slice(0, 10);
  }

  financeSetEditMode(false);
  financeApplyKindToForm('income');
  financeClearAllFieldErrors();
  financeWizard.maxStepIndex = 0;
  financeWizard.dirty = false;
  try { resetUnsavedBaseline($('financeEntryForm')); } catch { /* ignore */ }
  financeGoToStep('direction', { focus: false });
}

function financeStartEdit(entry) {
  if (!entry) return;
  setFinanceSubTab('panel-finances-record');
  const kind = financeDetectKindFromEntry(entry) === 'expense' ? 'expense' : 'income';
  $('financeEditId').value = String(entry.id || '');
  $('financeDate').value = String(entry.date || '');
  $('financeType').value = String(entry.type || 'income');
  $('financeCategory').value = String(entry.category || '');
  // The fund select's option values are fund ids; prefer the entry's stored fundId,
  // falling back to matching by fund name for older entries saved before that field existed.
  const entryFundId = String(entry.fundId || '');
  const fundByName = entryFundId ? null : financeActiveFunds().find((f) => financeNormalizeKey(f.fundName) === financeNormalizeKey(entry.fund));
  $('financeFund').value = entryFundId || (fundByName ? String(fundByName.id) : '');
  $('financeMethod').value = String(entry.method || '');
  $('financeAmount').value = (Number(entry.amountCents || 0) / 100).toFixed(2);
  $('financeParty').value = String(entry.party || '');
  $('financeMemo').value = String(entry.memo || '');
  financeApplyKindToForm(kind);
  financeSetEditMode(true);
  financeClearAllFieldErrors();
  financeWizard.maxStepIndex = FINANCE_WIZARD_STEPS.indexOf('details');
  financeWizard.dirty = false;
  try { resetUnsavedBaseline($('financeEntryForm')); } catch { /* ignore */ }
  financeGoToStep('details');
}

// ---------------------------------------------------------------------------
// Record Money wizard engine
// ---------------------------------------------------------------------------
const FINANCE_WIZARD_STEPS = ['direction', 'details', 'payment', 'review', 'saved'];
const financeWizard = { mode: 'add', step: 'direction', maxStepIndex: 0, dirty: false, saving: false, lastSavedId: '' };

function financeClearAllFieldErrors() {
  for (const id of ['financeCategoryError', 'financeFundError', 'financeAmountError', 'financeMethodError', 'financePartyError']) {
    const el = $(id);
    if (el) { el.textContent = ''; el.hidden = true; }
  }
}

function financeSetFieldError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function financeMarkDirty() {
  financeWizard.dirty = true;
}

function financeWizardHasUnsavedChanges() {
  return financeWizard.dirty && financeWizard.step !== 'saved';
}

function financeGoToStep(step, { focus = true } = {}) {
  if (!FINANCE_WIZARD_STEPS.includes(step)) return;
  const idx = FINANCE_WIZARD_STEPS.indexOf(step);
  if (idx > financeWizard.maxStepIndex) financeWizard.maxStepIndex = idx;
  financeWizard.step = step;

  for (const s of FINANCE_WIZARD_STEPS) {
    const panel = document.querySelector(`.wizardStep[data-step-panel="${s}"]`);
    if (panel) panel.hidden = s !== step;
  }

  const progress = $('financeWizardProgress');
  if (progress) {
    const navSteps = ['direction', 'details', 'payment', 'review'];
    for (const btn of progress.querySelectorAll('[data-wizard-goto]')) {
      const target = btn.getAttribute('data-wizard-goto');
      const targetIdx = navSteps.indexOf(target);
      const isCurrent = target === step;
      // Keep the chip compact (just the step number) until it becomes the active step,
      // where it expands to show the full step name too.
      const label = btn.getAttribute('aria-label') || '';
      btn.textContent = isCurrent ? `${targetIdx + 1} ${label}` : String(targetIdx + 1);
      btn.classList.toggle('wizardProgress__step--current', isCurrent);
      btn.classList.toggle('wizardProgress__step--done', targetIdx < navSteps.indexOf(step) || (step === 'saved'));
      if (isCurrent) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
      // Only allow returning to steps already reached.
      btn.disabled = targetIdx > financeWizard.maxStepIndex;
    }
  }

  if (step === 'review') financeRenderReviewSummary();

  if (focus) {
    const panel = document.querySelector(`.wizardStep[data-step-panel="${step}"]`);
    const heading = panel?.querySelector('.wizardStep__question, .wizardStep__heading');
    try {
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
      else panel?.querySelector('input, select, button')?.focus();
    } catch { /* ignore */ }
  }
}

function financeValidateDirectionStep() {
  const value = String($('financeType')?.value || '').trim();
  if (value !== 'income' && value !== 'expense') {
    setFinanceHint('Choose whether this is money received or money spent.');
    return false;
  }
  return true;
}

function financeValidateDetailsStep() {
  financeClearAllFieldErrors();
  let ok = true;
  let focusEl = null;

  const category = String($('financeCategory')?.value || '').trim();
  if (!category) {
    const kind = String($('financeType')?.value || 'income');
    financeSetFieldError('financeCategoryError', kind === 'expense' ? 'Choose what this expense was for.' : 'Choose what the money was received for.');
    focusEl = focusEl || $('financeCategory');
    ok = false;
  }

  const fundId = String($('financeFund')?.value || '').trim();
  if (!fundId) {
    financeSetFieldError('financeFundError', 'Choose which church fund this belongs to.');
    focusEl = focusEl || $('financeFund');
    ok = false;
  }

  const amountRaw = String($('financeAmount')?.value || '').trim();
  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    financeSetFieldError('financeAmountError', 'Enter an amount greater than $0.00.');
    focusEl = focusEl || $('financeAmount');
    ok = false;
  }

  if (!ok && focusEl) { try { focusEl.focus(); } catch { /* ignore */ } }
  return ok;
}

function financeValidatePaymentStep() {
  financeClearAllFieldErrors();
  let ok = true;
  let focusEl = null;

  const method = String($('financeMethod')?.value || '').trim();
  if (!method) {
    financeSetFieldError('financeMethodError', 'Choose a payment method.');
    focusEl = focusEl || $('financeMethod');
    ok = false;
  }

  const kind = String($('financeType')?.value || 'income');
  const party = String($('financeParty')?.value || '').trim();
  if (kind === 'expense' && !party) {
    financeSetFieldError('financePartyError', 'Enter who was paid.');
    focusEl = focusEl || $('financeParty');
    ok = false;
  }

  if (!ok && focusEl) { try { focusEl.focus(); } catch { /* ignore */ } }
  return ok;
}

function financeFormatReviewDate(dateStr) {
  const s = String(dateStr || '');
  if (!s) return '';
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function financeMethodLabel(value) {
  const map = { cash: 'Cash', check: 'Check', card: 'Card', online: 'Online', other: 'Other' };
  return map[String(value || '').trim()] || String(value || '');
}

function financeRenderReviewSummary() {
  const dl = $('financeReviewSummary');
  if (!dl) return;
  const kind = String($('financeType')?.value || 'income');
  const isExpense = kind === 'expense';
  const amount = Number($('financeAmount')?.value || 0) || 0;
  const date = financeFormatReviewDate($('financeDate')?.value);
  const category = String($('financeCategory')?.value || '').trim();
  const fund = financeFundNameById($('financeFund')?.value);
  const method = financeMethodLabel($('financeMethod')?.value);
  const party = String($('financeParty')?.value || '').trim();
  const memo = String($('financeMemo')?.value || '').trim();

  const rows = [];
  rows.push(['', `${formatMoneyCents(Math.round(amount * 100))} ${isExpense ? 'paid' : 'received'} on ${date}`]);
  if (category) rows.push(['Category', category]);
  if (fund) rows.push(['Fund', fund]);
  if (method) rows.push(['Payment method', method]);
  if (party) rows.push([isExpense ? 'Paid to' : 'Received from', party]);
  if (memo) rows.push(['Note', memo]);

  dl.innerHTML = '';
  for (const [label, value] of rows) {
    if (label) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      dl.appendChild(dt);
    }
    const dd = document.createElement('dd');
    dd.className = label ? '' : 'wizardReview__headline';
    dd.textContent = value;
    dl.appendChild(dd);
  }
}

function financeRenderSavedPanel(entry) {
  const summary = $('financeSavedSummary');
  if (!summary || !entry) return;
  const isExpense = String(entry.type) === 'expense';
  const amount = formatMoneyCents(Number(entry.amountCents || 0));
  const date = financeFormatReviewDate(entry.date);
  const category = String(entry.category || '').trim();
  const descriptor = category ? category.toLowerCase() : (isExpense ? 'expense' : 'income');
  summary.textContent = `The ${amount} ${descriptor} ${isExpense ? 'paid' : 'received'} on ${date} was saved.`;
  const heading = $('financeSavedHeading');
  try { heading?.focus(); } catch { /* ignore */ }
}

function financeOpenUnsavedDialog(onDiscard) {
  const dialog = $('financeUnsavedDialog');
  if (!(dialog instanceof HTMLDialogElement)) {
    if (confirmWrite('You have entered information for a new transaction that has not been saved. Discard this entry?')) onDiscard();
    return;
  }
  openManagedDialog(dialog);
  const keepBtn = $('financeUnsavedKeepBtn');
  const discardBtn = $('financeUnsavedDiscardBtn');
  const cleanup = () => {
    keepBtn?.removeEventListener('click', onKeep);
    discardBtn?.removeEventListener('click', onDiscardClick);
  };
  const onKeep = () => { cleanup(); closeManagedDialog(dialog); };
  const onDiscardClick = () => { cleanup(); closeManagedDialog(dialog); onDiscard(); };
  keepBtn?.addEventListener('click', onKeep);
  discardBtn?.addEventListener('click', onDiscardClick);
}

function financeOpenDeleteDialog(entry) {
  const dialog = $('financeDeleteDialog');
  const isExpense = String(entry?.type) === 'expense';
  const body = $('financeDeleteDialogBody');
  const reasonEl = $('financeDeleteReason');
  if (reasonEl) reasonEl.value = '';
  if (body) {
    const amount = formatMoneyCents(Number(entry?.amountCents || 0));
    const category = String(entry?.category || '').trim();
    const descriptor = category ? `${category.toLowerCase()} ${isExpense ? 'expense' : 'income'}` : (isExpense ? 'expense' : 'income');
    const date = financeFormatReviewDate(entry?.date);
    const party = String(entry?.party || '').trim();
    const partyLine = party ? `${isExpense ? 'Paid to' : 'Received from'} ${party}` : '';
    body.innerHTML = '';
    const p1 = document.createElement('p');
    p1.textContent = `${amount} ${descriptor}`;
    const p2 = document.createElement('p');
    p2.textContent = date;
    body.appendChild(p1);
    body.appendChild(p2);
    if (partyLine) {
      const p3 = document.createElement('p');
      p3.textContent = partyLine;
      body.appendChild(p3);
    }
  }

  if (!(dialog instanceof HTMLDialogElement)) {
    if (confirmWrite('Void this transaction? The record stays in history.')) financeDeleteEntry(entry, 'Legacy confirmation flow');
    return;
  }

  openManagedDialog(dialog);
  const confirmBtn = $('financeDeleteConfirmBtn');
  const keepBtn = $('financeDeleteKeepBtn');
  const cleanup = () => {
    confirmBtn?.removeEventListener('click', onConfirm);
    keepBtn?.removeEventListener('click', onKeep);
  };
  const onConfirm = () => {
    const reason = String(reasonEl?.value || '').trim();
    if (!reason) {
      setFinanceHint('Enter a reason to void this transaction.');
      try { reasonEl?.focus(); } catch { /* ignore */ }
      return;
    }
    cleanup();
    closeManagedDialog(dialog);
    financeDeleteEntry(entry, reason);
  };
  const onKeep = () => { cleanup(); closeManagedDialog(dialog); };
  confirmBtn?.addEventListener('click', onConfirm);
  keepBtn?.addEventListener('click', onKeep);
}

async function financeDeleteEntry(entry, reason) {
  if (!entry?.id) return;
  setFinanceHint('Voiding…');
  try {
    const res = await api(`/api/finances/entries/${encodeURIComponent(String(entry.id))}/void`, {
      method: 'POST',
      body: JSON.stringify({ reason: String(reason || '').trim() })
    });
    finances = res.data;
    financeResetForm();
    renderFinances();
    setFinanceHint('Transaction voided.');
  } catch (err) {
    setFinanceHint(err.message);
  }
}

function setFinanceSubTab(panelId) {
  const previous = document.querySelector('#panel-finances-record:not([hidden])');
  if (previous && panelId !== 'panel-finances-record' && financeWizardHasUnsavedChanges()) {
    financeOpenUnsavedDialog(() => {
      financeResetForm();
      setFinanceSubTab(panelId);
    });
    return;
  }

  setSubTab(
    ['subTabBtn-finances-record', 'subTabBtn-finances-review', 'subTabBtn-finances-reports'],
    ['panel-finances-record', 'panel-finances-review', 'panel-finances-reports'],
    panelId
  );

  if (panelId === 'panel-finances-review' || panelId === 'panel-finances-reports') {
    renderFinances();
  }
}

function populateFinancePartyDatalist() {
  const dl = $('financePartiesList');
  if (!dl) return;

  const all = Array.isArray(finances?.entries) ? finances.entries : [];
  const seen = new Set();
  const names = [];

  for (const e of all) {
    const raw = String(e?.party || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(raw);
  }

  names.sort((a, b) => a.localeCompare(b));
  dl.innerHTML = '';
  for (const n of names) {
    const opt = document.createElement('option');
    opt.value = n;
    dl.appendChild(opt);
  }
}

function financeBuildDescription(e) {
  const status = String(e?.status || '').trim().toLowerCase();
  const baseCategory = String(e?.category || '').trim() || (String(e?.type) === 'expense' ? 'Expense' : 'Income');
  const category = status === 'voided' ? `${baseCategory} (Voided)` : (status === 'reversed' ? `${baseCategory} (Reversed)` : baseCategory);
  const parts = [e?.fund, financeMethodLabel(e?.method), e?.party].map((v) => String(v || '').trim()).filter(Boolean);
  return { title: category, subtitle: parts.join(' · ') };
}

function financeBuildDetailFields(e) {
  const isExpense = String(e?.type) === 'expense';
  const fields = [];
  fields.push(['Transaction type', isExpense ? 'Money Spent' : 'Money Received']);
  if (e?.sourceLabel || e?.source) fields.push(['Source', String(e.sourceLabel || e.source || '').replace(/_/g, ' ')]);
  if (e?.status) fields.push(['Status', String(e.status || '').replace(/_/g, ' ')]);
  if (e?.reconciliationStatus) fields.push(['Reconciliation', String(e.reconciliationStatus || '').replace(/_/g, ' ')]);
  if (e?.category) fields.push(['Category', e.category]);
  if (e?.fund) fields.push(['Fund', e.fund]);
  if (e?.accountName) fields.push(['Account', e.accountName]);
  if (e?.checkNumber) fields.push(['Check number', e.checkNumber]);
  if (e?.method) fields.push(['Payment method', financeMethodLabel(e.method)]);
  if (e?.party) fields.push([isExpense ? 'Paid to' : 'Received from', e.party]);
  if (e?.memo) fields.push(['Note', e.memo]);
  if (e?.voidReason) fields.push(['Void reason', e.voidReason]);
  if (e?.createdAt) fields.push(['Created', formatLocalTimestamp(new Date(e.createdAt))]);
  if (e?.updatedAt && e.updatedAt !== e.createdAt) fields.push(['Last edited', formatLocalTimestamp(new Date(e.updatedAt))]);
  return fields;
}

function financeRowActionButtons(e, { onToggle }) {
  const wrap = document.createElement('div');
  wrap.className = 'row__actions financeRowActions';

  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn btn--sm';
  viewBtn.textContent = 'View';
  viewBtn.setAttribute('aria-expanded', 'false');
  viewBtn.addEventListener('click', () => onToggle(viewBtn));

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn--sm';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => financeStartEdit(e));

  const receiptBtn = document.createElement('button');
  receiptBtn.type = 'button';
  receiptBtn.className = 'btn btn--sm';
  receiptBtn.textContent = 'Print Receipt';
  receiptBtn.addEventListener('click', () => financePrintReceipts([e]));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn btn--sm btn--danger';
  delBtn.textContent = 'Void';
  if (String(e?.status || '').toLowerCase() === 'voided' || String(e?.status || '').toLowerCase() === 'reversed') {
    delBtn.disabled = true;
  }
  delBtn.addEventListener('click', () => financeOpenDeleteDialog(e));

  wrap.appendChild(viewBtn);
  wrap.appendChild(editBtn);
  wrap.appendChild(receiptBtn);
  wrap.appendChild(delBtn);
  return wrap;
}

function renderFinances() {
  populateFinanceDatalists();
  populateFinancePartyDatalist();

  const filters = financeCurrentFilters();
  const all = Array.isArray(finances?.entries) ? finances.entries : [];
  const rows = all.filter((e) => financeEntryMatches(e, filters));
  const rangeHint = $('financeDateRangeHint');
  if (rangeHint) rangeHint.textContent = String(filters?.rangeError || '');

  // Totals should reflect the selected date/search filters, but not the
  // quick-kind mini-tabs OR the type checkbox filters.
  // (You may browse "Expense" while still wanting to see income/giving totals.)
  const totalsFilters = { ...filters, kind: '', types: [], type: '' };
  const totalsRows = all.filter((e) => financeEntryMatches(e, totalsFilters));

  let income = 0;
  let expense = 0;
  for (const e of totalsRows) {
    const cents = Number(e?.amountCents || 0);
    const t = financeNormalizeKey(e?.type);
    if (t === 'income') income += cents;
    if (t === 'expense') expense += cents;
  }
  const net = income - expense;

  if ($('financeIncomeTotal')) $('financeIncomeTotal').textContent = formatMoneyCents(income);
  if ($('financeExpenseTotal')) $('financeExpenseTotal').textContent = formatMoneyCents(expense);
  const netEl = $('financeNetTotal');
  if (netEl) {
    netEl.textContent = formatMoneyCents(net);
    netEl.classList.toggle('financeAmt--income', net > 0);
    netEl.classList.toggle('financeAmt--expense', net < 0);
  }

  renderFinancePieChart('financeFlowPie', [
    { label: 'Money Received', value: income, color: '#2f9e44' },
    { label: 'Money Spent', value: expense, color: 'var(--danger)' }
  ], 'No money movement for the selected filters.');

  const meta = $('financePrintMeta');
  if (meta) {
    const range = financeDateRangeLabel(filters);
    meta.textContent = `Printed: ${formatLocalTimestamp()} • Report: Transaction History • ${range} • ${rows.length} entries • Money Received ${formatMoneyCents(income)} • Money Spent ${formatMoneyCents(expense)} • Net Total ${formatMoneyCents(net)}`;
  }

  financeRenderFilterSummary(filters, rows.length);

  const tbody = $('financeTableBody');
  const cardList = $('financeCardList');
  if (tbody) tbody.innerHTML = '';
  if (cardList) cardList.innerHTML = '';

  // Weekly Giving summary is independent of the table/filters.
  renderWeeklyGiving();

  if (!tbody && !cardList) return;

  if (!rows.length) {
    if (tbody) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'No transactions match the current filters.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    if (cardList) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No transactions match the current filters.';
      cardList.appendChild(empty);
    }
    return;
  }

  const sorted = [...rows].sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')));

  for (const e of sorted) {
    const amountCents = Number(e?.amountCents || 0);
    const isExpense = String(e?.type) === 'expense';
    const { title, subtitle } = financeBuildDescription(e);
    const detailFields = financeBuildDetailFields(e);

    // Desktop table row
    if (tbody) {
      const tr = document.createElement('tr');
      const detailRow = document.createElement('tr');
      detailRow.className = 'financeDetailRow';
      detailRow.hidden = true;

      const mkTd = (text) => { const td = document.createElement('td'); td.textContent = String(text || ''); return td; };
      tr.appendChild(mkTd(financeFormatReviewDate(e?.date)));

      const descTd = document.createElement('td');
      descTd.className = 'financeDescCell';
      const titleEl = document.createElement('div');
      titleEl.className = 'financeDescCell__title';
      titleEl.textContent = title;
      descTd.appendChild(titleEl);
      if (subtitle) {
        const subEl = document.createElement('div');
        subEl.className = 'financeDescCell__subtitle';
        subEl.textContent = subtitle;
        descTd.appendChild(subEl);
      }
      tr.appendChild(descTd);

      const inTd = document.createElement('td');
      inTd.className = 'num';
      inTd.textContent = isExpense ? '' : formatMoneyCents(amountCents);
      tr.appendChild(inTd);

      const outTd = document.createElement('td');
      outTd.className = 'num';
      outTd.textContent = isExpense ? formatMoneyCents(amountCents) : '';
      tr.appendChild(outTd);

      const actionsTd = document.createElement('td');
      actionsTd.className = 'noPrint';
      const toggleDetail = (btn) => {
        const expanded = !detailRow.hidden;
        detailRow.hidden = expanded;
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        btn.textContent = expanded ? 'View' : 'Hide';
      };
      actionsTd.appendChild(financeRowActionButtons(e, { onToggle: toggleDetail }));
      tr.appendChild(actionsTd);

      const detailTd = document.createElement('td');
      detailTd.colSpan = 5;
      const dl = document.createElement('dl');
      dl.className = 'wizardReview financeDetailFields';
      for (const [label, value] of detailFields) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        dl.appendChild(dt); dl.appendChild(dd);
      }
      detailTd.appendChild(dl);
      detailRow.appendChild(detailTd);

      tbody.appendChild(tr);
      tbody.appendChild(detailRow);
    }

    // Mobile stacked card
    if (cardList) {
      const card = document.createElement('div');
      card.className = 'financeCard';

      const head = document.createElement('div');
      head.className = 'financeCard__head';
      const dateEl = document.createElement('div');
      dateEl.className = 'financeCard__date';
      dateEl.textContent = financeFormatReviewDate(e?.date);
      const amtEl = document.createElement('div');
      amtEl.className = `financeCard__amount ${isExpense ? 'financeAmt--expense' : 'financeAmt--income'}`;
      amtEl.textContent = `${isExpense ? '-' : ''}${formatMoneyCents(amountCents)}`;
      head.appendChild(dateEl);
      head.appendChild(amtEl);

      const titleEl = document.createElement('div');
      titleEl.className = 'financeCard__title';
      titleEl.textContent = title;
      const subEl = document.createElement('div');
      subEl.className = 'financeCard__subtitle';
      subEl.textContent = subtitle;

      const detailWrap = document.createElement('dl');
      detailWrap.className = 'wizardReview financeDetailFields';
      detailWrap.hidden = true;
      for (const [label, value] of detailFields) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value;
        detailWrap.appendChild(dt); detailWrap.appendChild(dd);
      }

      const toggleDetail = (btn) => {
        const expanded = !detailWrap.hidden;
        detailWrap.hidden = expanded;
        btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        btn.textContent = expanded ? 'View' : 'Hide';
      };
      const actions = financeRowActionButtons(e, { onToggle: toggleDetail });

      card.appendChild(head);
      card.appendChild(titleEl);
      if (subtitle) card.appendChild(subEl);
      card.appendChild(actions);
      card.appendChild(detailWrap);
      cardList.appendChild(card);
    }
  }

  renderWeeklyGiving();
}

async function loadFinances() {
  const [data] = await Promise.all([
    api('/api/finances', { method: 'GET' }),
    loadFinanceFundsRegistry()
  ]);
  finances = data;
  financeResetForm();
  // Hide custom range UI unless the user explicitly opens it.
  if ($('financeCustomRange')) {
    const customToggle = $('financeRangeCustom');
    const wantsCustom = (customToggle instanceof HTMLInputElement) ? !!customToggle.checked : false;
    setFinanceCustomMode(wantsCustom);
  }
  renderFinances();
}

function financeCsvEscape(value) {
  const s = String(value ?? '');
  if (/[\n\r,\"]/g.test(s)) return `"${s.replace(/\"/g, '""')}"`;
  return s;
}

function downloadTextFile(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function isoDateToday() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToIsoDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function startOfMonth(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

function startOfWeekSunday(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function normalizeCategoryKey(value) {
  return String(value || '').trim().toLowerCase();
}

function renderWeeklyGiving() {
  const today = isoDateToday();
  let from = '';
  let to = '';

  if (financeGivingPeriod === 'month') {
    from = startOfMonth(today);
    to = today;
  } else {
    from = startOfWeekSunday(today);
    to = addDaysToIsoDate(from, 6);
  }

  const tithesKey = 'tithes';
  const offeringsKey = 'offerings';

  const entries = Array.isArray(finances?.entries) ? finances.entries : [];
  const inRange = entries.filter((e) => {
    const d = String(e?.date || '');
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  let tithes = 0;
  let offerings = 0;

  for (const e of inRange) {
    if (financeNormalizeKey(e?.type) !== 'income') continue;
    const cat = normalizeCategoryKey(e?.category);
    const cents = Number(e?.amountCents || 0);
    if (!Number.isFinite(cents)) continue;
    if (cat === tithesKey || (tithesKey === 'tithes' && cat.includes('tithe'))) tithes += cents;
    if (cat === offeringsKey || (offeringsKey === 'offerings' && cat.includes('offering'))) offerings += cents;
  }

  const total = tithes + offerings;
  const periodLabel = $('financeGivingPeriodLabel');
  if (periodLabel) periodLabel.textContent = financeGivingPeriod === 'month' ? '(This Month)' : '(This Week)';
  if ($('financeTithesTotal')) $('financeTithesTotal').textContent = formatMoneyCents(tithes);
  if ($('financeOfferingsTotal')) $('financeOfferingsTotal').textContent = formatMoneyCents(offerings);
  if ($('financeGivingTotal')) $('financeGivingTotal').textContent = formatMoneyCents(total);

  renderFinancePieChart('financeGivingPie', [
    { label: 'Tithes', value: tithes, color: 'var(--accent)' },
    { label: 'Offerings', value: offerings, color: '#2f9e44' }
  ], 'No giving entries in the selected period.');
}

function renderFinancePieChart(pieId, slices, emptyLabel) {
  const pie = $(pieId);
  if (!pie) return;

  const normalized = Array.isArray(slices)
    ? slices.map((slice) => ({
      label: String(slice?.label || '').trim(),
      color: String(slice?.color || 'rgba(255,255,255,.2)'),
      value: Math.max(0, Number(slice?.value || 0))
    }))
    : [];

  const total = normalized.reduce((sum, slice) => sum + slice.value, 0);
  if (!(total > 0)) {
    pie.style.background = 'conic-gradient(rgba(255,255,255,.18) 0deg 360deg)';
    pie.setAttribute('aria-label', String(emptyLabel || 'No data available.'));
    return;
  }

  let start = 0;
  const parts = [];
  const labels = [];

  for (const slice of normalized) {
    if (!(slice.value > 0)) continue;
    const degrees = (slice.value / total) * 360;
    const end = start + degrees;
    parts.push(`${slice.color} ${start}deg ${end}deg`);
    const pct = Math.round((slice.value / total) * 1000) / 10;
    labels.push(`${slice.label} ${pct}%`);
    start = end;
  }

  pie.style.background = `conic-gradient(${parts.join(', ')})`;
  pie.setAttribute('aria-label', labels.join(', '));
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

function setSettingsSubTab(panelId) {
  setSubTab(
    ['subTabBtn-settings-social', 'subTabBtn-settings-theme'],
    ['panel-settings-social', 'panel-settings-theme'],
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

let inviteLoadedToken = '';
async function loadInvite(token) {
  if (!token) return;
  if (inviteLoadedToken === token) return;
  inviteLoadedToken = token;

  $('inviteError').hidden = true;
  $('inviteHint').textContent = 'Loading…';

  try {
    const data = await api(`/api/invites/${encodeURIComponent(token)}`, { method: 'GET' });
    $('inviteEmail').textContent = `Setting up: ${data.email}`;
    const qr = $('inviteQr');
    if (qr && data.twoFactor?.qrDataUrl) qr.src = data.twoFactor.qrDataUrl;
    const secret = $('inviteSecret');
    if (secret) secret.textContent = String(data.twoFactor?.secret || '');
    $('inviteHint').textContent = 'Complete the form to finish setup.';
    wirePasswordMeter('inviteNewPassword', 'invitePwMeter', 'invitePwText');
  } catch (err) {
    $('inviteError').textContent = err.message;
    $('inviteError').hidden = false;
    $('inviteHint').textContent = '';
  }
}

// -------- Photo Gallery --------
let galleryItems = [];
let photoArrangeAlbum = '';
let photoSelectedIds = new Set();
let photoFilteredItems = [];
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
  if (editBtn) editBtn.textContent = n === 1 ? 'Edit 1 selected photo' : `Edit ${n} selected photos`;
  if (deleteBtn) deleteBtn.textContent = n === 1 ? 'Delete 1 selected photo' : `Delete ${n} selected photos`;

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
  const total = photoFilteredItems.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (photoCurrentPage > totalPages) photoCurrentPage = totalPages;
  if (photoCurrentPage < 1) photoCurrentPage = 1;

  const showPager = total > pageSize;
  const text = total ? `Page ${photoCurrentPage} of ${totalPages} • ${total} photo(s)` : '';

  if (pagerTop) pagerTop.hidden = !showPager;
  if (infoTop) infoTop.textContent = text;
  if (prevTop) prevTop.disabled = photoCurrentPage <= 1;
  if (nextTop) nextTop.disabled = photoCurrentPage >= totalPages;

  if (pagerBottom) pagerBottom.hidden = !showPager;
  if (infoBottom) infoBottom.textContent = text;
  if (prevBottom) prevBottom.disabled = photoCurrentPage <= 1;
  if (nextBottom) nextBottom.disabled = photoCurrentPage >= totalPages;
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildAlbumList(items) {
  const albums = Array.from(new Set((items || []).map((i) => String(i.album || '').trim()).filter(Boolean)));
  albums.sort((a, b) => a.localeCompare(b));
  return albums;
}

function renderArrangeAlbumOptions() {
  const select = $('photoArrangeAlbum');
  if (!select) return;
  const albums = buildAlbumList(galleryItems);
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

function applyPhotoFilters({ resetPage = true } = {}) {
  const sort = $('photoSort').value;
  const albumFilter = $('photoAlbumFilter').value.trim().toLowerCase();
  const tagFilter = $('photoTagFilter').value.trim().toLowerCase();

  let items = [...galleryItems];
  if (albumFilter) items = items.filter((i) => String(i.album || '').toLowerCase().includes(albumFilter));
  if (tagFilter) items = items.filter((i) => (i.tags || []).some((t) => String(t).toLowerCase().includes(tagFilter)));

  const manualAlbum = String(photoArrangeAlbum || '').trim();
  if (sort === 'manual' && manualAlbum) {
    items = items.filter((i) => String(i.album || '') === manualAlbum);
    items.sort((a, b) => {
      const ap = toNumberOrNull(a.position);
      const bp = toNumberOrNull(b.position);
      if (ap === null && bp === null) return String(b.createdAt).localeCompare(String(a.createdAt));
      if (ap === null) return 1;
      if (bp === null) return -1;
      if (ap !== bp) return ap - bp;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  } else {
    items.sort((a, b) => {
      if (sort === 'name-asc') return String(a.originalName).localeCompare(String(b.originalName));
      if (sort === 'name-desc') return String(b.originalName).localeCompare(String(a.originalName));
      if (sort === 'date-asc') return String(a.createdAt).localeCompare(String(b.createdAt));
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  photoFilteredItems = items;
  if (resetPage) photoCurrentPage = 1;

  const pageSize = photoPageSize();
  const start = (photoCurrentPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  photoUpdatePager();
  renderPhotoGrid(pageItems);
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
    view.textContent = 'View';
    view.addEventListener('click', () => {
      openPhotoViewDialog(item);
    });
    actions.appendChild(view);

    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.type = 'button';
    edit.textContent = 'Edit';
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
    del.textContent = 'Delete';
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
  const data = await api('/api/gallery', { method: 'GET' });
  galleryItems = data.items || [];
  renderArrangeAlbumOptions();
  applyPhotoFilters();
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

function formatBytes(n) {
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
    meta.textContent = `${formatBytes(o.size)}${when}`.trim();

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'r2Row__actions';

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => {
      const key = String(o.key || '');
      if (!key) return;
      window.open(`/cdn/gallery/${encodeURI(key)}`, '_blank');
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn';
    delBtn.textContent = 'Delete';
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

  for (const post of announcementPosts.slice(0, 2)) {
    if (draft && draft.id && String(draft.id) === String(post?.id || '')) continue;
    const created = post?.createdAt ? `Posted: ${formatDate(post.createdAt)}` : '';
    const starts = post?.startsAt ? ` • Starts: ${formatDate(post.startsAt)}` : '';
    const expires = post?.expiresAt ? ` • Expires: ${formatDate(post.expiresAt)}` : ' • Expires: Never';
    rows.push({
      id: post?.id,
      title: post?.title || 'Announcement',
      meta: `${created}${starts}${expires}`.trim(),
      body: post?.body || ''
    });
  }

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
      const t = document.createElement('div');
      t.className = 'row__title';
      t.textContent = post.title;
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const created = post.createdAt ? `Posted: ${formatDate(post.createdAt)}` : '';
      const starts = post.startsAt ? ` • Starts: ${formatDate(post.startsAt)}` : '';
      const expires = post.expiresAt ? ` • Expires: ${formatDate(post.expiresAt)}` : ' • Expires: Never';
      meta.textContent = `${created}${starts}${expires}`.trim();

      const body = document.createElement('div');
      body.className = 'row__meta';
      body.textContent = post.body;

      main.appendChild(t);
      main.appendChild(meta);
      main.appendChild(body);
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
      edit.textContent = 'Edit';
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
    del.textContent = 'Delete';
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
  document.body.dataset.printMode = String(mode || 'finance');
  const body = $('adminPrintBody');
  if (body) body.innerHTML = '';
}

function closeDetailsMenu(id) {
  const el = $(id);
  if (el && el.tagName === 'DETAILS') el.open = false;
}

function setFinancePrintHeader(reportLabel, extraMetaParts = []) {
  const title = $('financePrintTitle');
  if (title) title.textContent = 'Mt. Moriah Missionary Baptist Church — Finance';

  const meta = $('financePrintMeta');
  if (!meta) return;

  const parts = [`Printed: ${formatLocalTimestamp()}`];
  if (reportLabel) parts.push(`Report: ${reportLabel}`);
  for (const p of extraMetaParts) {
    if (p) parts.push(String(p));
  }
  meta.textContent = parts.join(' • ');
}

function financePartyLabelForEntry(entry) {
  const kind = financeDetectKindFromEntry(entry);
  if (kind === 'expense') return 'To';
  if (kind === 'tithes') return 'Giver';
  if (kind === 'offerings') return 'Giver';
  return 'From';
}

function financeReceiptTitleForEntry(entry) {
  const date = String(entry?.date || '').trim();
  const type = financeNormalizeKey(entry?.type);
  const amount = formatMoneyCents(Number(entry?.amountCents || 0));
  const cat = String(entry?.category || '').trim();
  const t = type ? (type[0].toUpperCase() + type.slice(1)) : 'Entry';
  return `${date}${date ? ' • ' : ''}${t}${cat ? ` • ${cat}` : ''} • ${amount}`;
}

function financeReceiptHay(entry) {
  return [
    entry?.id,
    entry?.date,
    entry?.type,
    entry?.category,
    entry?.fund,
    entry?.method,
    entry?.party,
    entry?.memo,
    financeDetectKindFromEntry(entry)
  ].map((v) => String(v || '').toLowerCase()).join(' ');
}

function financeGetReceiptsUniverse() {
  const all = Array.isArray(finances?.entries) ? finances.entries : [];
  // Respect current date/search filters, but not quick tabs or type checkbox filters.
  const base = financeCurrentFilters();
  const filters = { ...base, kind: '', types: [], type: '' };
  return all.filter((e) => financeEntryMatches(e, filters));
}

function financeRenderReceiptsPicker({ keepSelection = true } = {}) {
  const list = $('financeReceiptsList');
  const countEl = $('financeReceiptsCount');
  const searchEl = $('financeReceiptsSearch');
  if (!list || !countEl || !(searchEl instanceof HTMLInputElement)) return;

  const universe = financeGetReceiptsUniverse();
  const q = String(searchEl.value || '').trim().toLowerCase();
  const filtered = q ? universe.filter((e) => financeReceiptHay(e).includes(q)) : universe;

  if (!window.__financeReceiptSelectedIds || !keepSelection) {
    window.__financeReceiptSelectedIds = new Set();
  }
  const selectedIds = window.__financeReceiptSelectedIds;

  // Prune selections that are no longer in scope.
  const availableIds = new Set(filtered.map((e) => String(e?.id || '')));
  for (const id of Array.from(selectedIds)) {
    if (!availableIds.has(id)) selectedIds.delete(id);
  }

  list.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No entries match your filters/search.';
    list.appendChild(empty);
  } else {
    for (const e of filtered) {
      const id = String(e?.id || '');
      const row = document.createElement('div');
      row.className = 'row';

      const main = document.createElement('div');
      main.className = 'row__main';

      const title = document.createElement('div');
      title.className = 'row__title';
      title.textContent = financeReceiptTitleForEntry(e);

      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const kind = financeDetectKindFromEntry(e);
      const partyLabel = financePartyLabelForEntry(e);
      const party = String(e?.party || '').trim();
      const fund = String(e?.fund || '').trim();
      const method = String(e?.method || '').trim();
      meta.textContent = [
        kind ? `Kind: ${kind}` : '',
        fund ? `Fund: ${fund}` : '',
        method ? `Method: ${method}` : '',
        party ? `${partyLabel}: ${party}` : ''
      ].filter(Boolean).join(' • ');

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'row__actions';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'checkbox';
      cb.checked = selectedIds.has(id);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        financeRenderReceiptsCount({ universe, filtered, selectedIds });
      });

      actions.appendChild(cb);
      row.appendChild(main);
      row.appendChild(actions);

      // Clicking the row toggles the checkbox (except when clicking the checkbox).
      row.addEventListener('click', (ev) => {
        if (ev.target === cb) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });

      list.appendChild(row);
    }
  }

  financeRenderReceiptsCount({ universe, filtered, selectedIds });
}

function financeRenderReceiptsCount({ universe, filtered, selectedIds }) {
  const countEl = $('financeReceiptsCount');
  if (!countEl) return;
  const sel = selectedIds ? selectedIds.size : 0;
  countEl.textContent = `${filtered.length} shown • ${universe.length} in current filters • ${sel} selected`;
}

function financeBuildReceiptBlock(entry, { index, total }) {
  const id = String(entry?.id || '').trim();
  const date = String(entry?.date || '').trim();
  const type = financeNormalizeKey(entry?.type);
  const category = String(entry?.category || '').trim();
  const fund = String(entry?.fund || '').trim();
  const method = String(entry?.method || '').trim();
  const party = String(entry?.party || '').trim();
  const memo = String(entry?.memo || '').trim();
  const cents = Number(entry?.amountCents || 0);
  const amount = formatMoneyCents(cents);
  const partyLabel = financePartyLabelForEntry(entry);
  const kind = financeDetectKindFromEntry(entry);

  const churchName = 'Mt. Moriah Missionary Baptist Church';
  const digits = String(entry?.id || '').replace(/\D+/g, '');
  const receiptSuffix = (digits ? digits.slice(-4) : String((Number.isFinite(index) ? index : 0) + 1)).padStart(4, '0');
  const receiptNo = `MMMBC-${receiptSuffix}`;

  const wrap = document.createElement('section');
  wrap.className = 'receipt receipt--page';

  const head = document.createElement('div');
  head.className = 'receipt__head';

  const headLeft = document.createElement('div');
  headLeft.className = 'receipt__headLeft';
  const church = document.createElement('div');
  church.className = 'receipt__church';
  church.textContent = churchName;
  const report = document.createElement('div');
  report.className = 'receipt__report';
  report.textContent = 'Financial Report';
  headLeft.appendChild(church);
  headLeft.appendChild(report);

  const headRight = document.createElement('div');
  headRight.className = 'receipt__headRight';
  const receiptNoEl = document.createElement('div');
  receiptNoEl.className = 'receipt__receiptNo';
  receiptNoEl.textContent = receiptNo;
  headRight.appendChild(receiptNoEl);

  head.appendChild(headLeft);
  head.appendChild(headRight);

  const meta = document.createElement('div');
  meta.className = 'receipt__meta';
  const parts = [
    date ? `Date: ${date}` : '',
    kind ? `Kind: ${kind}` : '',
    (Number.isFinite(index) && Number.isFinite(total)) ? `Item: ${index + 1}/${total}` : ''
  ].filter(Boolean);
  meta.textContent = parts.join(' • ');

  const table = document.createElement('table');
  table.className = 'receipt__table';

  const rows = [
    ['Receipt #', receiptNo],
    ['Type', type || ''],
    ['Category', category],
    ['Fund', fund],
    ['Method', method],
    [partyLabel, party],
    ['Amount', amount],
    ['Memo', memo]
  ].filter(([, v]) => String(v || '').trim());

  const tbody = document.createElement('tbody');
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const tdK = document.createElement('td');
    tdK.className = 'receipt__label';
    tdK.textContent = k;
    const tdV = document.createElement('td');
    tdV.className = 'receipt__value';
    tdV.textContent = String(v);
    tr.appendChild(tdK);
    tr.appendChild(tdV);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const sign = document.createElement('div');
  sign.className = 'receipt__sign';
  sign.innerHTML = '<div class="receipt__line"><span>Signature</span><span class="receipt__blank"></span></div><div class="receipt__line"><span>Date</span><span class="receipt__blank"></span></div>';

  wrap.appendChild(head);
  wrap.appendChild(meta);
  wrap.appendChild(table);
  wrap.appendChild(sign);
  return wrap;
}

function financeReceiptNoForEntry(entry, index) {
  const digits = String(entry?.id || '').replace(/\D+/g, '');
  const receiptSuffix = (digits ? digits.slice(-4) : String((Number.isFinite(index) ? index : 0) + 1)).padStart(4, '0');
  return `MMMBC-${receiptSuffix}`;
}

function financeAppendSignatureLines(root) {
  const sign = document.createElement('div');
  sign.className = 'receipt__sign';
  sign.innerHTML = '<div class="receipt__line"><span>Signature</span><span class="receipt__blank"></span></div><div class="receipt__line"><span>Date</span><span class="receipt__blank"></span></div>';
  root.appendChild(sign);
}

function financeBuildReceiptsTable(entries) {
  const safe = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const table = document.createElement('table');
  table.className = 'printTable';

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Receipt #</th><th>Date</th><th>Kind</th><th>Type</th><th>Category</th><th>Fund</th><th>Method</th><th>Party</th><th>Amount</th><th>Memo</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  safe.forEach((e, idx) => {
    const tr = document.createElement('tr');

    const receiptNo = financeReceiptNoForEntry(e, idx);
    const date = String(e?.date || '').trim();
    const kind = financeDetectKindFromEntry(e);
    const type = financeNormalizeKey(e?.type);
    const category = String(e?.category || '').trim();
    const fund = String(e?.fund || '').trim();
    const method = String(e?.method || '').trim();
    const party = String(e?.party || '').trim();
    const cents = Number(e?.amountCents || 0);
    const amount = formatMoneyCents(cents);
    const memo = String(e?.memo || '').trim();

    const partyLabel = financePartyLabelForEntry(e);
    const partyCell = partyLabel ? `${partyLabel}: ${party}` : party;

    const cols = [
      receiptNo,
      date,
      kind,
      type,
      category,
      fund,
      method,
      partyCell,
      amount,
      memo
    ];

    for (const v of cols) {
      const td = document.createElement('td');
      td.textContent = String(v || '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  return table;
}

function financePrintReceipts(entries, { reportLabel } = {}) {
  const safe = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!safe.length) {
    alert('No entries selected to print.');
    return;
  }

  setPrintMode('receipts');
  setFinancePrintHeader('Mt. Moriah Missionary Baptist Church', ['Financial Report', `${safe.length} item(s)`]);

  const root = $('adminPrintBody');
  if (!root) return;
  root.innerHTML = '';

  if (safe.length === 1) {
    const block = financeBuildReceiptBlock(safe[0], { index: 0, total: 1 });
    block.classList.remove('receipt--page');
    root.appendChild(block);
  } else {
    const h = document.createElement('div');
    h.className = 'printReportTitle';
    h.textContent = reportLabel || 'Receipts';
    root.appendChild(h);

    root.appendChild(financeBuildReceiptsTable(safe));
    financeAppendSignatureLines(root);
  }

  window.print();
}

function refreshEventsPrintOptions() {
  const groupSel = $('printEventsGroupTitle');
  const eventSel = $('printEventId');
  if (!groupSel || !eventSel) return;

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

  groupSel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Choose a title…';
  groupSel.appendChild(opt0);
  for (const t of titles) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    groupSel.appendChild(o);
  }

  eventSel.innerHTML = '';
  const optE0 = document.createElement('option');
  optE0.value = '';
  optE0.textContent = 'Choose an event…';
  eventSel.appendChild(optE0);
  for (const ev of sorted) {
    const o = document.createElement('option');
    o.value = String(ev?.id || '');
    const d = String(ev?.date || '').trim();
    const t = formatEventTime12h(ev?.time);
    const titleText = normalizeTitle(ev?.title) || 'Event';
    o.textContent = `${d}${d ? ' • ' : ''}${t}${t ? ' • ' : ''}${titleText}`.trim();
    eventSel.appendChild(o);
  }
}

function financeBuildLedgerPrintReport() {
  const root = $('adminPrintBody');
  if (!root) return;
  root.innerHTML = '';

  const filters = financeCurrentFilters();
  const all = Array.isArray(finances?.entries) ? finances.entries : [];
  const rows = [...all.filter((e) => financeEntryMatches(e, filters))]
    .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')));

  let income = 0;
  let expense = 0;
  for (const e of rows) {
    const cents = Number(e?.amountCents || 0);
    if (String(e?.type) === 'income') income += cents; else expense += cents;
  }

  setFinancePrintHeader('Mt. Moriah Missionary Baptist Church', [
    'Transaction History',
    financeDateRangeLabel(filters),
    `${rows.length} entries`,
    `Money Received ${formatMoneyCents(income)}`,
    `Money Spent ${formatMoneyCents(expense)}`,
    `Net Total ${formatMoneyCents(income - expense)}`
  ]);

  const h = document.createElement('div');
  h.className = 'printReportTitle';
  h.textContent = 'Transaction History';
  root.appendChild(h);

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'printMuted';
    empty.textContent = 'No transactions match the current filters.';
    root.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'printTable';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th style="width:110px">Date</th><th>Description</th><th style="width:100px">Money In</th><th style="width:100px">Money Out</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const e of rows) {
    const isExpense = String(e?.type) === 'expense';
    const { title, subtitle } = financeBuildDescription(e);
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = financeFormatReviewDate(e?.date);
    const tdDesc = document.createElement('td');
    tdDesc.textContent = subtitle ? `${title} — ${subtitle}` : title;
    const tdIn = document.createElement('td');
    tdIn.textContent = isExpense ? '' : formatMoneyCents(Number(e?.amountCents || 0));
    const tdOut = document.createElement('td');
    tdOut.textContent = isExpense ? formatMoneyCents(Number(e?.amountCents || 0)) : '';
    tr.appendChild(tdDate);
    tr.appendChild(tdDesc);
    tr.appendChild(tdIn);
    tr.appendChild(tdOut);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
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

  for (const ev of events.slice(0, 2)) {
    if (draft && draft.id && String(draft.id) === String(ev?.id || '')) continue;
    rows.push({
      id: ev?.id,
      title: String(ev?.title || '').trim() || 'Event',
      meta: `${String(ev?.date || '')}${ev?.time ? ` • ${formatEventTime12h(ev.time)}` : ''}`
    });
  }

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
      const t = document.createElement('div');
      t.className = 'row__title';
      t.textContent = ev.title;
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      meta.textContent = `${ev.date}${ev.time ? ` • ${ev.time}` : ''}`;

      main.appendChild(t);
      main.appendChild(meta);
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
      edit.textContent = 'Edit';
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
    del.textContent = 'Delete';
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

  for (const b of bulletins.slice(0, 2)) {
    if (draft && draft.id && String(draft.id) === String(b?.id || '')) continue;
    rows.push({
      id: b?.id,
      title: `${String(b?.title || 'Bulletin')}${b?.originalName ? ` • ${String(b.originalName)}` : ''}`,
      meta: `${isActiveBulletin(b) ? 'Active now' : 'Scheduled'} • ${formatPreviewDateTime(b?.startsAt)} → ${formatPreviewDateTime(b?.endsAt)}`
    });
  }

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
      const t = document.createElement('div');
      t.className = 'row__title';
      t.textContent = `${b.title || 'Bulletin'} • ${b.originalName || ''}`.trim();
      const meta = document.createElement('div');
      meta.className = 'row__meta';
      const active = isActiveBulletin(b);
      meta.textContent = `${active ? 'Active now' : ''}${active ? ' • ' : ''}${toLocalDateTimeValue(b.startsAt)} → ${toLocalDateTimeValue(b.endsAt)}`;

      main.appendChild(t);
      main.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const open = document.createElement('a');
    open.className = 'btn';
    open.href = b.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open';

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
      edit.textContent = 'Edit';
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
    del.textContent = 'Delete';
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
      del.textContent = 'Delete';
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

// -------- Livestream --------
let livestream = null;

function getSelectedLivePlatforms() {
  const inputs = Array.from(document.querySelectorAll('input[name="livePlatforms"]'));
  return uniqStringsLower(inputs.filter((i) => i.checked).map((i) => i.value));
}

function setSelectedLivePlatforms(platforms) {
  const set = new Set(uniqStringsLower(platforms));
  const inputs = Array.from(document.querySelectorAll('input[name="livePlatforms"]'));
  for (const el of inputs) el.checked = set.has(String(el.value || '').toLowerCase());
}

function renderLivestream() {
  $('ytEmbed').value = livestream?.embeds?.youtube || '';
  $('fbEmbed').value = livestream?.embeds?.facebook || '';
  $('siteEmbed').value = livestream?.embeds?.website || '';
  $('activePlatform').value = livestream?.active?.platform || 'website';

  const activePlatforms = (livestream?.active?.platforms && Array.isArray(livestream.active.platforms))
    ? livestream.active.platforms
    : [livestream?.active?.platform || 'website'];
  setSelectedLivePlatforms(activePlatforms);

  const isLive = (livestream?.active?.status || 'offline') === 'live';
  const chip = $('liveStatus');
  chip.textContent = isLive ? 'Live' : 'Offline';
  chip.classList.toggle('statusChip--live', isLive);

  const list = $('recurringList');
  list.innerHTML = '';

  for (const r of (livestream?.recurring || [])) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = `${r.label}`;
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    meta.textContent = `${r.day} • ${r.time}`;
    main.appendChild(t);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'row__actions';
    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this recurring stream?')) return;
      livestream.recurring = (livestream.recurring || []).filter((x) => x.id !== r.id);
      await saveLivestream();
    });

    actions.appendChild(del);
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }

  if (!(livestream?.recurring || []).length) {
    list.innerHTML = '<div class="muted">No recurring streams set.</div>';
  }
}

async function loadLivestream() {
  livestream = await api('/api/livestream', { method: 'GET' });
  renderLivestream();
}

async function saveLivestream() {
  const payload = {
    active: livestream.active,
    embeds: {
      youtube: $('ytEmbed').value.trim(),
      facebook: $('fbEmbed').value.trim(),
      website: $('siteEmbed').value.trim()
    },
    recurring: livestream.recurring || []
  };
  const res = await api('/api/livestream', { method: 'PUT', body: JSON.stringify(payload) });
  livestream = res.data;
  renderLivestream();
}

// -------- Settings --------
let settings = null;

async function loadSettings() {
  if (!$('socialForm') || !$('themeForm')) return;
  settings = await api('/api/settings', { method: 'GET' });

  $('socialForm').facebook.value = settings?.social?.facebook || '';
  $('socialForm').youtube.value = settings?.social?.youtube || '';
  $('socialForm').email.value = settings?.social?.email || '';
  $('socialForm').phone.value = settings?.social?.phone || '';
  $('socialForm').address.value = settings?.social?.address || '';

  $('themeForm').accent.value = settings?.theme?.accent || '#c46123';
  $('themeForm').text.value = settings?.theme?.text || '#ffffff';
  $('themeForm').background.value = settings?.theme?.background || '#000000';

  // Sync hex fields
  const a = $('themeForm').accent.value;
  const t = $('themeForm').text.value;
  const b = $('themeForm').background.value;
  if ($('themeAccentHex')) $('themeAccentHex').value = a;
  if ($('themeTextHex')) $('themeTextHex').value = t;
  if ($('themeBackgroundHex')) $('themeBackgroundHex').value = b;

  applyThemePreviewCard({ accent: a, text: t, background: b });
}

async function saveSettingsPatch(patch) {
  const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  settings = res.data;
  await loadSettings();
}

function normalizeHex(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const withHash = v.startsWith('#') ? v : `#${v}`;
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) return withHash.toLowerCase();
  return '';
}

function getThemeFromInputs() {
  const accent = String($('themeForm').accent.value || '#c46123');
  const text = String($('themeForm').text.value || '#ffffff');
  const background = String($('themeForm').background.value || '#000000');
  return { accent, text, background };
}

function applyThemePreviewCard(theme) {
  const card = $('themePreviewCard');
  if (!card) return;
  card.style.setProperty('--mmmbc-accent', theme.accent);
  card.style.setProperty('--mmmbc-text', theme.text);
  card.style.setProperty('--mmmbc-bg', theme.background);
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
      : 'This newsletter will be sent immediately when you choose Send Now.';
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
    opt.textContent = `${detected} (Detected)`;
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
          <button class="btn" type="button" data-action="delete" data-newsletter-record-id="${id}">Delete</button>
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

// -------- Load everything --------
async function loadAll() {
  const results = await Promise.allSettled([
    loadGallery(),
    loadAnnouncements(),
    loadEvents(),
    loadBulletins(),
    loadFinances(),
    loadSubscribers(),
    loadNewsletterRecords(),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') throw r.reason;
  }

  if (window.AdminDashboard && typeof window.AdminDashboard.refresh === 'function') {
    try {
      await window.AdminDashboard.refresh();
    } catch {
      // Dashboard should not block admin boot if overview data is unavailable.
    }
  }
}

function renderStorageHealthStatus(data) {
  const summary = $('adminStorageHealthSummary');
  const details = $('adminStorageHealthDetails');
  if (!summary || !details) return;

  if (!data || typeof data !== 'object') {
    summary.textContent = 'Diagnostics unavailable.';
    details.textContent = '';
    return;
  }

  const degraded = !!data.degraded;
  const storageMode = String(data?.storage?.mode || 'unknown').replace(/_/g, ' ');
  const pgStatus = data?.storage?.postgresConnected ? 'connected' : 'not connected';
  summary.textContent = degraded
    ? `Storage health degraded. Active mode: ${storageMode}.`
    : `Storage health OK. Active mode: ${storageMode}.`;
  details.textContent = `Postgres: ${pgStatus}. Finance storage: ${String(data?.storage?.financeStorage || 'unknown')}. Gallery storage: ${String(data?.storage?.galleryStorage || 'unknown')}.`;
}

async function loadAdminStorageHealth() {
  const card = $('adminStorageHealthCard');
  const summary = $('adminStorageHealthSummary');
  const details = $('adminStorageHealthDetails');
  if (!card || !summary || !details) return;

  summary.textContent = 'Checking storage health…';
  details.textContent = '';

  try {
    const data = await api('/api/admin/storage-health', { method: 'GET' });
    renderStorageHealthStatus(data);
  } catch (err) {
    summary.textContent = err instanceof Error ? err.message : 'Storage diagnostics failed.';
    details.textContent = '';
  }
}

// -------- Wire UI --------
document.addEventListener('DOMContentLoaded', async () => {
  updateHeaderBumper();
  updateLayoutMetrics();
  window.addEventListener('resize', () => {
    try { updateLayoutMetrics(); } catch { /* ignore */ }
  });

  resetTransientUiState();

  applyAppearancePreference(getAppearancePreference());
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

  // Default print mode (prints are initiated from Finances).
  setPrintMode('finance');
  window.addEventListener('afterprint', () => {
    try { setPrintMode('finance'); } catch { /* ignore */ }
  });

  setAdminDrawerOpen(false, { restoreFocus: false });
  if ($('navDrawerToggle')) {
    $('navDrawerToggle').addEventListener('click', () => {
      setAdminDrawerOpen(!adminDrawerOpen, { restoreFocus: false });
    });
  }
  if ($('adminDrawerBackdrop')) {
    $('adminDrawerBackdrop').addEventListener('click', () => {
      setAdminDrawerOpen(false, { restoreFocus: true });
    });
  }
  if ($('adminSideNav')) {
    $('adminSideNav').addEventListener('click', (e) => {
      const trigger = e.target?.closest?.('.tab--nav,[data-section-target]');
      if (!trigger) return;

      if (trigger.classList.contains('tab--nav')) {
        const target = String(trigger.getAttribute('aria-controls') || '').trim();
        if (target) {
          e.preventDefault();
          activateMainSection(target, {
            subTabId: target === 'tab-photos' ? 'panel-photos-manage' : (target === 'tab-content' ? 'panel-content-announcements' : '')
          });
          setAdminDrawerOpen(false, { restoreFocus: true });
          return;
        }
      }

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

  // Tabs
  if ($('tabBtn-home')) $('tabBtn-home').addEventListener('click', () => activateMainSection('tab-home'));
  if ($('tabBtn-photos')) $('tabBtn-photos').addEventListener('click', () => activateMainSection('tab-photos', { subTabId: 'panel-photos-manage' }));
  if ($('tabBtn-events')) $('tabBtn-events').addEventListener('click', () => activateMainSection('tab-events'));
  if ($('tabBtn-content')) $('tabBtn-content').addEventListener('click', () => activateMainSection('tab-content', { subTabId: 'panel-content-announcements' }));
  if ($('tabBtn-finances')) $('tabBtn-finances').addEventListener('click', () => activateMainSection('tab-finances'));
  if ($('tabBtn-directory')) $('tabBtn-directory').addEventListener('click', () => activateMainSection('tab-directory', { subTabId: 'panel-directory-contacts' }));
  if ($('tabBtn-newsletter')) $('tabBtn-newsletter').addEventListener('click', () => activateMainSection('tab-newsletter'));
  if ($('tabBtn-support')) $('tabBtn-support').addEventListener('click', () => activateMainSection('tab-support'));

  for (const trigger of Array.from(document.querySelectorAll('[data-section-target]'))) {
    trigger.addEventListener('click', (e) => {
      const target = String(trigger.getAttribute('data-section-target') || '').trim();
      const subTab = String(trigger.getAttribute('data-subtab-target') || '').trim();
      if (!target) return;
      e.preventDefault();
      activateMainSection(target, { subTabId: subTab });
    });
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
  if ($('subTabBtn-settings-social')) {
    $('subTabBtn-settings-social').addEventListener('click', () => setSettingsSubTab('panel-settings-social'));
  }
  if ($('subTabBtn-settings-theme')) {
    $('subTabBtn-settings-theme').addEventListener('click', () => setSettingsSubTab('panel-settings-theme'));
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
    'financeEntryForm',
    'newsletterForm',
    'photoUploadForm',
    'supportForm',
    'directoryContactForm'
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

  // Finances
  if ($('financeEntryForm')) {
    const forceDatePickerOpen = (inputId) => {
      const input = $(inputId);
      if (!(input instanceof HTMLInputElement)) return;
      if (String(input.type || '') !== 'date') return;
      const open = () => {
        try { input.focus(); } catch { /* ignore */ }
        const sp = input.showPicker;
        if (typeof sp === 'function') {
          try { sp.call(input); } catch { /* ignore */ }
        }
      };

      // Clicking the label/container should also open the picker.
      const label = input.closest('label');
      if (label) {
        label.addEventListener('click', (e) => {
          if (e.target === input) return;
          open();
        });
      }

      // Clicking in the input should open it too (consistent behavior).
      input.addEventListener('click', () => open());
    };

    forceDatePickerOpen('financeDate');
    forceDatePickerOpen('financeFrom');
    forceDatePickerOpen('financeTo');

    $('financeEntryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (financeWizard.saving) return;
      setFinanceHint('');

      const id = String($('financeEditId').value || '');
      const payload = {
        date: String($('financeDate').value || ''),
        type: String($('financeType').value || ''),
        category: String($('financeCategory').value || ''),
        fund: '',
        fundId: String($('financeFund').value || ''),
        method: String($('financeMethod').value || ''),
        amount: String($('financeAmount').value || ''),
        party: String($('financeParty').value || ''),
        memo: String($('financeMemo').value || '')
      };

      financeWizard.saving = true;
      const saveBtn = $('financeSaveBtn');
      if (saveBtn) saveBtn.disabled = true;
      setFinanceHint(id ? 'Saving…' : 'Adding…');

      try {
        const res = await api(id
          ? `/api/finances/entries/${encodeURIComponent(id)}`
          : '/api/finances/entries',
        {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(payload)
        });
        finances = res.data;
        const savedEntry = Array.isArray(finances?.entries)
          ? (finances.entries.find((x) => String(x.id) === String(id)) || finances.entries[finances.entries.length - 1])
          : null;
        financeWizard.dirty = false;
        try { resetUnsavedBaseline($('financeEntryForm')); } catch { /* ignore */ }
        setFinanceHint('');
        financeRenderSavedPanel(savedEntry);
        financeWizard.lastSavedId = savedEntry ? String(savedEntry.id || '') : '';
        financeGoToStep('saved');
        renderFinances();
      } catch (err) {
        setFinanceHint(err.message);
      } finally {
        financeWizard.saving = false;
        if (saveBtn) saveBtn.disabled = false;
      }
    });

    // “Create … / Delete …” option handling for Category and Fund dropdowns.
    // Funds use the real fund registry APIs, while categories use finance meta.
    if ($('financeCategory')) {
      $('financeCategory').addEventListener('change', () => financeHandleCreateSelect('category'));
    }
    if ($('financeFund')) {
      $('financeFund').addEventListener('change', () => financeHandleCreateSelect('fund'));
    }

    // Mark the wizard dirty on any field change so unsaved-change prompts fire correctly.
    $('financeEntryForm').addEventListener('input', financeMarkDirty);
    $('financeEntryForm').addEventListener('change', financeMarkDirty);

    // Step 1: Money direction
    const chooseDirection = (direction) => {
      financeApplyKindToForm(direction);
      financeMarkDirty();
    };
    if ($('financeChoiceIncomeBtn')) {
      $('financeChoiceIncomeBtn').addEventListener('click', () => chooseDirection('income'));
    }
    if ($('financeChoiceExpenseBtn')) {
      $('financeChoiceExpenseBtn').addEventListener('click', () => chooseDirection('expense'));
    }
    if ($('financeStepDirectionContinueBtn')) {
      $('financeStepDirectionContinueBtn').addEventListener('click', () => {
        if (financeValidateDirectionStep()) financeGoToStep('details');
      });
    }

    // Step 2: Details
    if ($('financeStepDetailsContinueBtn')) {
      $('financeStepDetailsContinueBtn').addEventListener('click', () => {
        if (financeValidateDetailsStep()) financeGoToStep('payment');
      });
    }

    // Step 3: Payment
    if ($('financeStepPaymentContinueBtn')) {
      $('financeStepPaymentContinueBtn').addEventListener('click', () => {
        if (financeValidatePaymentStep()) financeGoToStep('review');
      });
    }

    // Back buttons
    for (const btn of document.querySelectorAll('[data-wizard-back]')) {
      btn.addEventListener('click', () => financeGoToStep(btn.getAttribute('data-wizard-back')));
    }

    // Progress indicator: jump to any previously-reached step
    if ($('financeWizardProgress')) {
      for (const btn of $('financeWizardProgress').querySelectorAll('[data-wizard-goto]')) {
        btn.addEventListener('click', () => financeGoToStep(btn.getAttribute('data-wizard-goto')));
      }
    }

    // Saved panel actions
    if ($('financeSavedAddAnotherBtn')) {
      $('financeSavedAddAnotherBtn').addEventListener('click', () => financeResetForm());
    }
    if ($('financeSavedViewBtn')) {
      $('financeSavedViewBtn').addEventListener('click', () => {
        const savedId = financeWizard.lastSavedId;
        financeResetForm();
        setFinanceSubTab('panel-finances-review');
        const search = $('financeSearch');
        const entry = Array.isArray(finances?.entries) ? finances.entries.find((x) => String(x.id) === savedId) : null;
        if (search instanceof HTMLInputElement && entry) {
          search.value = String(entry.party || entry.category || '');
          renderFinances();
        }
      });
    }
    if ($('financeSavedReviewAllBtn')) {
      $('financeSavedReviewAllBtn').addEventListener('click', () => {
        financeResetForm();
        setFinanceSubTab('panel-finances-review');
      });
    }

    if ($('financeCancelEditBtn')) {
      $('financeCancelEditBtn').addEventListener('click', () => {
        if (financeWizardHasUnsavedChanges()) {
          financeOpenUnsavedDialog(() => {
            financeResetForm();
            setFinanceHint('');
          });
          return;
        }
        financeResetForm();
        setFinanceHint('');
      });
    }
  }

  // Main Finance sub-tab navigation
  for (const id of ['subTabBtn-finances-record', 'subTabBtn-finances-review', 'subTabBtn-finances-reports']) {
    const btn = $(id);
    if (!btn) continue;
    btn.addEventListener('click', () => setFinanceSubTab(btn.getAttribute('aria-controls')));
  }

  if ($('financeViewSummaryBtn')) {
    $('financeViewSummaryBtn').addEventListener('click', () => {
      const totals = $('financeReportsTotals');
      const btn = $('financeViewSummaryBtn');
      try { totals?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch { /* ignore */ }
      btn?.setAttribute('aria-expanded', 'true');
      try { totals?.setAttribute('tabindex', '-1'); totals?.focus(); } catch { /* ignore */ }
    });
  }

  for (const id of ['financeFrom', 'financeTo', 'financeSearch']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', () => renderFinances());
    el.addEventListener('change', () => renderFinances());
  }

  for (const id of ['financeTypeIncome', 'financeTypeExpense']) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => renderFinances());
  }

  // Finance quick tabs (Money Received / Money Spent)
  if ($('financeQuickTabs')) {
    const wrap = $('financeQuickTabs');
    const btns = Array.from(wrap.querySelectorAll('[data-fin-kind]'));
    for (const b of btns) {
      b.addEventListener('click', () => {
        const kind = b.getAttribute('data-fin-kind');
        financeSetQuickKind(kind, { toggle: true });
      });
    }
  }

  const setGivingPeriod = (period) => {
    financeGivingPeriod = (period === 'month') ? 'month' : 'week';
    const wk = $('financePeriodWeekBtn');
    const mon = $('financePeriodMonthBtn');
    if (wk) wk.setAttribute('aria-selected', financeGivingPeriod === 'week' ? 'true' : 'false');
    if (mon) mon.setAttribute('aria-selected', financeGivingPeriod === 'month' ? 'true' : 'false');
    renderWeeklyGiving();
  };

  if ($('financePeriodWeekBtn')) {
    $('financePeriodWeekBtn').addEventListener('click', () => setGivingPeriod('week'));
  }
  if ($('financePeriodMonthBtn')) {
    $('financePeriodMonthBtn').addEventListener('click', () => setGivingPeriod('month'));
  }

  // Default to current week in the giving chips.
  setGivingPeriod(financeGivingPeriod);

  // Default quick view: show all transactions until the user picks a filter.

  if ($('financeSearchForm')) {
    $('financeSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      renderFinances();
      const menu = $('financeFilterMenu');
      if (menu && menu.open) menu.open = false;
    });
  }

  // Filter dropdown (single-choice date range + independent type toggles)
  if ($('financeFilterMenu')) {
    const menu = $('financeFilterMenu');
    const rangeInputs = Array.from(menu.querySelectorAll('input[name="financeDateRange"]'))
      .filter((el) => el instanceof HTMLInputElement);

    const syncDateRangeUi = () => {
      const selection = financeDateRangeSelection();
      setFinanceCustomMode(selection === 'custom');
      if (selection !== 'custom' && $('financeDateRangeHint')) $('financeDateRangeHint').textContent = '';
    };

    for (const el of rangeInputs) {
      el.addEventListener('change', () => {
        syncDateRangeUi();
        if (String(el.value || '') === 'custom' && el.checked) return;
        renderFinances();
      });
    }

    syncDateRangeUi();
  }

  if ($('financeApplyCustomRangeBtn')) {
    $('financeApplyCustomRangeBtn').addEventListener('click', () => {
      const selection = financeDateRangeSelection();
      if (selection !== 'custom') {
        const customRadio = $('financeRangeCustom');
        if (customRadio instanceof HTMLInputElement) customRadio.checked = true;
      }

      const check = financeCustomRangeValidation();
      const hint = $('financeDateRangeHint');
      if (!check.ok) {
        if (hint) hint.textContent = check.message;
        renderFinances();
        return;
      }

      if (hint) hint.textContent = '';
      renderFinances();
      const menu = $('financeFilterMenu');
      if (menu) menu.open = false;
    });
  }

  if ($('financeClearRangeBtn')) {
    $('financeClearRangeBtn').addEventListener('click', () => {
      const allDates = $('financeRangeAll');
      if (allDates instanceof HTMLInputElement) allDates.checked = true;
      if ($('financeFrom')) $('financeFrom').value = '';
      if ($('financeTo')) $('financeTo').value = '';
      if ($('financeSearch')) $('financeSearch').value = '';
      if ($('financeTypeIncome') instanceof HTMLInputElement) $('financeTypeIncome').checked = true;
      if ($('financeTypeExpense') instanceof HTMLInputElement) $('financeTypeExpense').checked = true;
      if ($('financeDateRangeHint')) $('financeDateRangeHint').textContent = '';
      setFinanceCustomMode(false);
      renderFinances();
      const menu = $('financeFilterMenu');
      if (menu) menu.open = false;
    });
  }

  if ($('financeExportCsvBtn')) {
    $('financeExportCsvBtn').addEventListener('click', () => {
      const filters = financeCurrentFilters();
      const rows = (finances?.entries || []).filter((en) => financeEntryMatches(en, filters));
      const header = ['Date', 'Type', 'Category', 'Fund', 'Method', 'FromTo', 'Memo', 'Amount'];
      const lines = [header.map(financeCsvEscape).join(',')];
      for (const r of rows) {
        const amount = (Number(r.amountCents || 0) / 100).toFixed(2);
        lines.push([
          r.date,
          r.type,
          r.category,
          r.fund,
          r.method,
          r.party,
          r.memo,
          amount
        ].map(financeCsvEscape).join(','));
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadTextFile(`finances_${stamp}.csv`, lines.join('\n'), 'text/csv');
    });
  }

  if ($('printFinanceLedgerBtn')) {
    $('printFinanceLedgerBtn').addEventListener('click', () => {
      setPrintMode('finance');
      financeBuildLedgerPrintReport();
      window.print();
    });
  }

  if ($('printFinanceReceiptsBtn')) {
    $('printFinanceReceiptsBtn').addEventListener('click', () => {
      const dlg = $('financeReceiptsDialog');
      if (!dlg) return;

      openManagedDialog(dlg, { initialFocusId: 'financeReceiptsSearch' });

      // Render the picker list using current filters.
      financeRenderReceiptsPicker({ keepSelection: true });
    });
  }

  if ($('financeReceiptsDialog')) {
    const dlg = $('financeReceiptsDialog');
    const closeDlg = () => closeManagedDialog(dlg);
    wireDialogDismissBehavior(dlg, { onClose: closeDlg });

    if ($('financeReceiptsSearch') instanceof HTMLInputElement) {
      $('financeReceiptsSearch').addEventListener('input', () => financeRenderReceiptsPicker({ keepSelection: true }));
    }
    if ($('financeReceiptsSearchClear')) {
      $('financeReceiptsSearchClear').addEventListener('click', () => {
        const s = $('financeReceiptsSearch');
        if (s instanceof HTMLInputElement) s.value = '';
        financeRenderReceiptsPicker({ keepSelection: true });
        try { $('financeReceiptsSearch')?.focus(); } catch { /* ignore */ }
      });
    }

    if ($('financeReceiptsSelectAllBtn')) {
      $('financeReceiptsSelectAllBtn').addEventListener('click', () => {
        const universe = financeGetReceiptsUniverse();
        const s = $('financeReceiptsSearch');
        const q = (s instanceof HTMLInputElement) ? String(s.value || '').trim().toLowerCase() : '';
        const filtered = q ? universe.filter((e) => financeReceiptHay(e).includes(q)) : universe;
        if (!window.__financeReceiptSelectedIds) window.__financeReceiptSelectedIds = new Set();
        for (const e of filtered) {
          const id = String(e?.id || '');
          if (id) window.__financeReceiptSelectedIds.add(id);
        }
        financeRenderReceiptsPicker({ keepSelection: true });
      });
    }

    if ($('financeReceiptsClearBtn')) {
      $('financeReceiptsClearBtn').addEventListener('click', () => {
        if (window.__financeReceiptSelectedIds) window.__financeReceiptSelectedIds.clear();
        financeRenderReceiptsPicker({ keepSelection: true });
      });
    }

    if ($('financeReceiptsPrintSelectedBtn')) {
      $('financeReceiptsPrintSelectedBtn').addEventListener('click', () => {
        const selectedIds = window.__financeReceiptSelectedIds || new Set();
        const universe = financeGetReceiptsUniverse();
        const picked = universe.filter((e) => selectedIds.has(String(e?.id || '')));
        closeDlg();
        financePrintReceipts(picked, { reportLabel: 'Receipts (selected entries)' });
      });
    }

    if ($('financeReceiptsPrintAllBtn')) {
      $('financeReceiptsPrintAllBtn').addEventListener('click', () => {
        const universe = financeGetReceiptsUniverse();
        closeDlg();
        financePrintReceipts(universe, { reportLabel: 'Receipts (all entries in current filters)' });
      });
    }

    if ($('financeReceiptsCloseBtn')) {
      $('financeReceiptsCloseBtn').addEventListener('click', () => closeDlg());
    }
  }

  if ($('financeUnsavedDialog')) {
    wireDialogDismissBehavior($('financeUnsavedDialog'));
  }
  if ($('financeDeleteDialog')) {
    wireDialogDismissBehavior($('financeDeleteDialog'));
  }

  if ($('printEventsAllBtn')) {
    $('printEventsAllBtn').addEventListener('click', async () => {
      closeDetailsMenu('eventsPrintMenu');
      if (!Array.isArray(events) || !events.length) {
        try { await loadEvents(); } catch { /* ignore */ }
      }
      setPrintMode('events');
      setFinancePrintHeader('Events report', [`All events (${events.length})`]);
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
      setFinancePrintHeader('Events report', [`Group: ${title}`, `${rows.length} event(s)`]);
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
      setFinancePrintHeader('Events report', [`Single: ${label}`, `${rows.length} event(s)`]);
      renderEventsPrintReport(rows, 'Events Report — Single Event');
      window.print();
    });
  }

  // Password peek + meters
  wirePeekButtons();
  wirePasswordMeter('recoverNewPassword', 'recoverPwMeter', 'recoverPwText');
  wirePasswordMeter('newPassword', 'accountPwMeter', 'accountPwText');
  // Optional: user creation temp password uses policy checks; meter not shown in UI.

  // Login
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginError').hidden = true;

    const fd = new FormData(e.currentTarget);
    try {
      await login(String(fd.get('email')), String(fd.get('password')));
      await refreshAuthUI();
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').hidden = false;
    }
  });

  await loadAuthProviders();
  initGoogleSignInButton();

  // Invite onboarding
  if ($('copySecretBtn') && $('inviteSecret')) {
    $('copySecretBtn').addEventListener('click', async () => {
      const text = String($('inviteSecret').textContent || '');
      try {
        await navigator.clipboard.writeText(text);
        $('inviteHint').textContent = 'Copied.';
      } catch {
        $('inviteHint').textContent = 'Copy failed. You can select and copy manually.';
      }
    });
  }

  $('inviteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('inviteError').hidden = true;
    const token = getInviteTokenFromHash();
    if (!token) {
      $('inviteError').textContent = 'Missing invite token.';
      $('inviteError').hidden = false;
      return;
    }

    const hint = $('inviteHint');
    hint.textContent = '';
    const fd = new FormData(e.currentTarget);
    const newPassword = String(fd.get('newPassword') || '');
    const confirmPassword = String(fd.get('confirmPassword') || '');
    if (newPassword !== confirmPassword) {
      hint.textContent = 'Passwords do not match.';
      return;
    }
    const policyErr = passwordPolicyError(newPassword);
    if (policyErr) {
      hint.textContent = policyErr;
      return;
    }

    hint.textContent = 'Completing setup…';
    try {
      await api(`/api/invites/${encodeURIComponent(token)}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          name: String(fd.get('name') || ''),
          newPassword
        })
      });
      window.location.hash = '';
      inviteLoadedToken = '';
      await refreshAuthUI();
    } catch (err) {
      $('inviteError').textContent = err.message;
      $('inviteError').hidden = false;
      hint.textContent = '';
    }
  });

  // Invite admin (header modal)
  const inviteAdminDialog = $('inviteAdminDialog');
  const openInviteAdminDialog = () => {
    if (!(inviteAdminDialog instanceof HTMLDialogElement)) return;
    const err = $('inviteAdminError');
    const hint = $('inviteAdminHint');
    if (err) {
      err.hidden = true;
      err.textContent = '';
    }
    if (hint) hint.textContent = '';
    openManagedDialog(inviteAdminDialog, { initialFocusId: 'inviteAdminEmail' });
  };
  const closeInviteAdminDialog = () => {
    if (!(inviteAdminDialog instanceof HTMLDialogElement)) return;
    closeManagedDialog(inviteAdminDialog);
  };

  if ($('inviteAdminBtn')) {
    $('inviteAdminBtn').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openInviteAdminDialog();
    });
  }
  if ($('inviteAdminCloseBtn')) {
    $('inviteAdminCloseBtn').addEventListener('click', () => closeInviteAdminDialog());
  }
  if (inviteAdminDialog instanceof HTMLDialogElement) {
    wireDialogDismissBehavior(inviteAdminDialog, { onClose: closeInviteAdminDialog });
  }

  if ($('inviteAdminForm')) {
    $('inviteAdminForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const err = $('inviteAdminError');
      const hint = $('inviteAdminHint');
      const sendBtn = $('inviteAdminSendBtn');
      if (err) {
        err.hidden = true;
        err.textContent = '';
      }
      if (hint) hint.textContent = 'Sending invite…';
      if (sendBtn) sendBtn.disabled = true;

      try {
        const fd = new FormData(form);
        const email = String(fd.get('email') || '').trim().toLowerCase();
        const role = String(fd.get('role') || 'website_editor').trim();
        const out = await api('/api/users/invite', {
          method: 'POST',
          body: JSON.stringify({ email, role })
        });

        if (hint) {
          hint.textContent = out?.emailSent
            ? 'Invite email sent successfully.'
            : 'Invite created, but email sending is unavailable. Share the invite link manually.';
          if (!out?.emailSent && out?.emailError) {
            hint.textContent += ` (${String(out.emailError)})`;
          }
        }

        if (!out?.emailSent && out?.inviteLink) {
          try {
            await navigator.clipboard.writeText(String(out.inviteLink));
            if (hint) hint.textContent += ' Invite link copied to clipboard.';
          } catch {
            // ignore clipboard issues
          }
        }

        showToast(
          out?.emailSent ? 'Invite sent.' : 'Invite created. Email not sent; copied link if possible.',
          { variant: out?.emailSent ? 'success' : 'danger' }
        );

        if (form instanceof HTMLFormElement) form.reset();
        setTimeout(() => closeInviteAdminDialog(), 250);
      } catch (error) {
        if (err) {
          err.textContent = String(error?.message || 'Unable to send invite.');
          err.hidden = false;
        }
        if (hint) hint.textContent = '';
      } finally {
        if (sendBtn) sendBtn.disabled = false;
      }
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
        if (hint) hint.textContent = out?.disabled ? 'Sending is disabled on this server.' : `Sent to ${Number(out?.sent || 0)} recipient(s).`;
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

  // Forgot login (recovery)
  $('forgotToggle').addEventListener('click', () => {
    const panel = $('forgotPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const emailEl = panel.querySelector('input[name="email"]');
      if (emailEl) emailEl.focus();
    }
  });

  $('recoverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('recoverHint');
    hint.textContent = '';
    const fd = new FormData(e.currentTarget);
    const newPassword = String(fd.get('newPassword') || '');
    const confirmPassword = String(fd.get('confirmPassword') || '');
    if (newPassword !== confirmPassword) {
      hint.textContent = 'Passwords do not match.';
      return;
    }
    const policyErr = passwordPolicyError(newPassword);
    if (policyErr) {
      hint.textContent = policyErr;
      return;
    }
    hint.textContent = 'Resetting…';
    try {
      await api('/api/auth/recover', {
        method: 'POST',
        body: JSON.stringify({
          email: String(fd.get('email') || ''),
          recoveryCode: String(fd.get('recoveryCode') || ''),
          newPassword
        })
      });
      hint.textContent = 'Password updated. You can sign in now.';
      safeResetForm(e);
      $('forgotPanel').hidden = true;
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  const logoutBtn = $('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logout();
      await refreshAuthUI();
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

  // Account password (optional UI)
  const passwordForm = $('passwordForm');
  if (passwordForm) {
    passwordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('passwordHint');
      if (hint) hint.textContent = '';
      const fd = new FormData(e.currentTarget);
      const newPassword = String(fd.get('newPassword') || '');
      const confirmPassword = String(fd.get('confirmPassword') || '');
      if (newPassword !== confirmPassword) {
        if (hint) hint.textContent = 'Passwords do not match.';
        return;
      }
      const policyErr = passwordPolicyError(newPassword);
      if (policyErr) {
        if (hint) hint.textContent = policyErr;
        return;
      }

      if (!confirmWrite('Update your password?')) return;

      if (hint) hint.textContent = 'Updating…';
      try {
        await api('/api/account/password', {
          method: 'PUT',
          body: JSON.stringify({
            currentPassword: String(fd.get('currentPassword') || ''),
            newPassword
          })
        });
        if (hint) hint.textContent = 'Password updated.';
        safeResetForm(e);
        wirePasswordMeter('newPassword', 'accountPwMeter', 'accountPwText');
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
      const prevText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Editing…';
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
          btn.textContent = prevText || 'Edit selected';
        }
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
      const prevText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Deleting…';
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
          btn.textContent = prevText || 'Delete selected';
        }
      }
    });
  }

  $('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    const prevText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing…';
    }

    // Failsafe: never leave the UI stuck forever.
    const watchdog = window.setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText || 'Refresh Website Gallery';
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
        btn.textContent = prevText || 'Refresh Website Gallery';
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
    refreshAuthUI().catch(() => {});
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

  // Livestream controls
  if ($('goLiveBtn')) {
    $('goLiveBtn').addEventListener('click', async () => {
      if (!confirmWrite('Set livestream status to LIVE now?')) return;
      const platform = $('activePlatform').value;
      const platforms = getSelectedLivePlatforms();
      const nextPlatforms = platforms.length ? platforms : [platform];
      if (!nextPlatforms.includes(platform)) nextPlatforms.unshift(platform);
      livestream.active = { platform, platforms: nextPlatforms, status: 'live' };
      await saveLivestream();
    });
  }
  if ($('goOfflineBtn')) {
    $('goOfflineBtn').addEventListener('click', async () => {
      if (!confirmWrite('Set livestream status to OFFLINE now?')) return;
      const platform = $('activePlatform').value;
      const platforms = getSelectedLivePlatforms();
      const nextPlatforms = platforms.length ? platforms : [platform];
      if (!nextPlatforms.includes(platform)) nextPlatforms.unshift(platform);
      livestream.active = { platform, platforms: nextPlatforms, status: 'offline' };
      await saveLivestream();
    });
  }
  if ($('saveLivestreamBtn')) {
    $('saveLivestreamBtn').addEventListener('click', async () => {
      if (!confirmWrite('Save livestream settings?')) return;
      const platform = $('activePlatform').value;
      const platforms = getSelectedLivePlatforms();
      const nextPlatforms = platforms.length ? platforms : [platform];
      if (!nextPlatforms.includes(platform)) nextPlatforms.unshift(platform);
      livestream.active = { platform, platforms: nextPlatforms, status: livestream.active?.status || 'offline' };
      await saveLivestream();
      alert('Saved livestream settings.');
    });
  }

  if ($('recurringForm')) {
    $('recurringForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!confirmWrite('Add this recurring stream?')) return;

      const fd = new FormData(e.currentTarget);
      const item = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
        day: String(fd.get('day')),
        time: String(fd.get('time')),
        label: String(fd.get('label'))
      };
      livestream.recurring = [...(livestream.recurring || []), item];
      await saveLivestream();
      safeResetForm(e);
    });
  }

  // Social settings
  if ($('socialForm')) {
    $('socialForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('socialHint');

      if (!confirmWrite('Save social links?')) return;

      hint.textContent = 'Saving…';
      const fd = new FormData(e.currentTarget);
      await saveSettingsPatch({
        social: {
          facebook: String(fd.get('facebook') || ''),
          youtube: String(fd.get('youtube') || ''),
          email: String(fd.get('email') || ''),
          phone: String(fd.get('phone') || ''),
          address: String(fd.get('address') || '')
        }
      });
      hint.textContent = 'Saved.';
    });
  }

  // Theme settings
  if ($('themeForm')) {
    $('themeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('themeHint');

      if (!confirmWrite('Save theme settings?')) return;

      hint.textContent = 'Saving…';
      const fd = new FormData(e.currentTarget);
      await saveSettingsPatch({
        theme: {
          accent: String(fd.get('accent') || '#c46123'),
          text: String(fd.get('text') || '#ffffff'),
          background: String(fd.get('background') || '#000000')
        }
      });
      hint.textContent = 'Saved (theme.css updated if exports enabled).';
    });
  }

  // Theme: hex input syncing
  const syncHex = (colorInputId, hexInputId) => {
    const colorEl = $(colorInputId);
    const hexEl = $(hexInputId);
    if (!colorEl || !hexEl) return;

    const pushToHex = () => {
      hexEl.value = String(colorEl.value || '').toLowerCase();
      applyThemePreviewCard(getThemeFromInputs());
    };

    const pushToColor = () => {
      const normalized = normalizeHex(hexEl.value);
      if (!normalized) return;
      colorEl.value = normalized;
      applyThemePreviewCard(getThemeFromInputs());
    };

    colorEl.addEventListener('input', pushToHex);
    hexEl.addEventListener('input', () => {
      // live preview only when valid hex
      const normalized = normalizeHex(hexEl.value);
      if (normalized) {
        colorEl.value = normalized;
        applyThemePreviewCard(getThemeFromInputs());
      }
    });
    hexEl.addEventListener('change', pushToColor);

    pushToHex();
  };

  syncHex('themeAccent', 'themeAccentHex');

  // Time pickers
  if ($('recurringTimePicker') && $('recurringTime')) initTimePicker('recurringTimePicker', 'recurringTime', { required: true, defaultValue: '10:00' });
  if ($('eventTimePicker') && $('eventTime')) initTimePicker('eventTimePicker', 'eventTime', { required: false });
  syncHex('themeText', 'themeTextHex');
  syncHex('themeBackground', 'themeBackgroundHex');

  // Theme: Preview before saving
  const previewBtn = $('previewThemeBtn');
  const clearBtn = $('clearThemePreviewBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      const hint = $('themeHint');
      hint.textContent = 'Enabling preview…';
      const theme = getThemeFromInputs();
      applyThemePreviewCard(theme);
      await api('/api/theme/preview', { method: 'POST', body: JSON.stringify({ theme }) });
      hint.textContent = 'Preview enabled. A new tab will open with your preview.';
      window.open('/', '_blank');
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const hint = $('themeHint');
      hint.textContent = 'Clearing preview…';
      await api('/api/theme/preview/clear', { method: 'POST', body: '{}' });
      hint.textContent = 'Preview cleared.';
    });
  }

  const exportAllBtn = $('exportAllBtn');
  if (exportAllBtn) {
    exportAllBtn.addEventListener('click', async () => {
      if (!confirmWrite('Export current content to website files now?')) return;
      await api('/api/export', { method: 'POST', body: '{}' });
      alert('Exported to website files.');
    });
  }

  // Initial
  refreshAuthUI().catch((err) => {
    $('authStatus').textContent = 'Admin server not running.';
    $('loginError').textContent = err.message;
    $('loginError').hidden = false;
  });
});
