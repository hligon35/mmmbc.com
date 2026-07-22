let csrfToken = '';
let csrfReady = Promise.resolve();
let authProviders = { google: { enabled: false, clientId: '' } };
let googleInitializedClientId = '';
let googleRenderedClientId = '';
let googleInitRetryCount = 0;
let googleInitRetryTimer = null;

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/csrf', { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) return '';
    const data = await res.json();
    csrfToken = String(data?.csrfToken || '');
    return csrfToken;
  } catch {
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

  if (needsCsrf) {
    await csrfReady;
    // If the page hasn't fetched a token yet (or it was cleared), fetch now.
    if (!csrfToken) {
      csrfReady = fetchCsrfToken();
      await csrfReady;
    }
  }

  const headers = {
    ...(options.headers || {}),
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' })
  };
  if (needsCsrf && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const doRequest = async () => {
    const res = await fetch(url, {
      headers,
      credentials: 'same-origin',
      ...options
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json() : null;
    return { res, data };
  };

  let out = await doRequest();

  // If the session rotated, CSRF tokens can become invalid. Refresh once and retry.
  if (needsCsrf && !out.res.ok && out.res.status === 403) {
    const errMsg = String(out.data?.error || '');
    if (/csrf/i.test(errMsg)) {
      csrfReady = fetchCsrfToken();
      await csrfReady;
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      out = await doRequest();
    }
  }

  if (!out.res.ok) {
    const msg = out.data?.error || `Request failed: ${out.res.status}`;
    throw new Error(msg);
  }

  return out.data;
}

function $(id) { return document.getElementById(id); }

let syncProgressHideTimer = null;

function updateHeaderBumper() {
  const header = document.querySelector?.('.header');
  if (!header) return;
  try {
    const h = Math.max(0, Math.round(header.getBoundingClientRect().height || 0));
    document.documentElement.style.setProperty('--header-bumper', `${h}px`);
  } catch {
    // ignore
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
  if (form && typeof form.reset === 'function') form.reset();
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
    panel.hidden = true;
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
    $('tabBtn-photos'),
    $('tabBtn-events'),
    $('tabBtn-content'),
    $('tabBtn-finances'),
    $('tabBtn-support')
  ];
  const panels = [
    $('tab-photos'),
    $('tab-events'),
    $('tab-content'),
    $('tab-finances'),
    $('tab-support')
  ];

  tabButtons.forEach((b) => {
    const isActive = b.getAttribute('aria-controls') === activeId;
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  panels.forEach((p) => {
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

  const financeTopBar = $('financeTopBar');
  if (financeTopBar) financeTopBar.hidden = false;
}

async function refreshAuthUI() {
  let me = { user: null };
  try {
    me = await api('/api/me', { method: 'GET' });
  } catch {
    me = { user: null };
  }
  const loggedIn = !!me.user;

  const inviteToken = getInviteTokenFromHash();
  const inInviteFlow = !!inviteToken;

  $('inviteCard').hidden = !inInviteFlow;
  $('loginCard').hidden = loggedIn || inInviteFlow;
  $('dashboardCard').hidden = !loggedIn || inInviteFlow;
  $('logoutBtn').hidden = !loggedIn;

  if (!loggedIn && !inInviteFlow) {
    const form = $('loginForm');
    const forgotToggle = $('forgotToggle');
    const forgotPanel = $('forgotPanel');
    if (form) form.hidden = false;
    if (forgotToggle) forgotToggle.hidden = false;
    if (forgotPanel) forgotPanel.hidden = true;
    initGoogleSignInButton();
  }

  $('authStatus').textContent = loggedIn ? `Signed in as ${me.user.email}` : 'Sign in required';

  if (loggedIn) {
    $('salutation').textContent = `Welcome, ${me.user.name || me.user.email}`;
    const avatarText = $('avatarText');
    if (avatarText) avatarText.textContent = getInitials(me.user);
    const financeTopBar = $('financeTopBar');
    if (financeTopBar) financeTopBar.hidden = false;
  }

  if (loggedIn) {
    csrfReady = fetchCsrfToken();
    await csrfReady;
    await loadAll();
    applyHashNavigation();
  }

  if (inInviteFlow) {
    await loadInvite(inviteToken);
  }
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
  if (!h) return;

  if (/invite=/.test(h)) return;

  if (h === 'photos') setTab('tab-photos');
  if (h === 'events') setTab('tab-events');
  if (h === 'content') {
    setTab('tab-content');
    setContentSubTab('panel-content-announcements');
  }
  if (h === 'finances' || h === 'finance') setTab('tab-finances');
  if (h === 'support') setTab('tab-support');

  if (h === 'announcements') {
    setTab('tab-content');
    setContentSubTab('panel-content-announcements');
  }

  if (h === 'bulletins') {
    setTab('tab-content');
    setContentSubTab('panel-content-bulletins');
  }
}

// -------- Finances --------
let finances = { entries: [], meta: { categories: [], funds: [] } };
let financeQuickKind = 'income';
let financeGivingPeriod = 'week';

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
  const catEl = $('financeCategory');
  const isEditing = !!String($('financeEditId')?.value || '').trim();

  const ensureSelectOption = (sel, value) => {
    if (!(sel instanceof HTMLSelectElement)) return;
    const v = String(value || '').trim();
    if (!v) return;
    if (Array.from(sel.options).some((o) => String(o.value) === v)) return;
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    // Insert after the leading blank option if present.
    const first = sel.options?.[0];
    if (first) sel.insertBefore(opt, first.nextSibling);
    else sel.appendChild(opt);
  };

  const typeLabel = $('financeTypeLabelText');
  if (typeLabel) typeLabel.textContent = 'Type';

  const catLabel = $('financeCategoryLabelText');
  if (catLabel) {
    if (kind === 'tithes') catLabel.textContent = 'Tithes';
    else if (kind === 'offerings') catLabel.textContent = 'Offering';
    else catLabel.textContent = 'Category';
  }

  if (typeEl) {
    typeEl.disabled = true;
    typeEl.value = (kind === 'expense') ? 'expense' : 'income';
  }

  if (catEl) {
    if (kind === 'tithes') {
      ensureSelectOption(catEl, 'Tithes');
      if (!isEditing) catEl.value = 'Tithes';
      catEl.disabled = true;
    } else if (kind === 'offerings') {
      ensureSelectOption(catEl, 'Offerings');
      if (!isEditing) catEl.value = 'Offerings';
      catEl.disabled = true;
    } else {
      catEl.disabled = false;
      if (!isEditing) {
        // Only clear on add-mode; keep category when editing.
        if (kind === 'income' && !String(catEl.value || '').trim()) catEl.value = '';
        if (kind === 'expense' && !String(catEl.value || '').trim()) catEl.value = '';
      }
    }
  }

  const partyLabel = $('financePartyLabel');
  const partyInput = $('financeParty');
  if (partyLabel) {
    if (kind === 'expense') partyLabel.textContent = 'To (optional)';
    else if (kind === 'tithes') partyLabel.textContent = 'Giver (required)';
    else if (kind === 'offerings') partyLabel.textContent = 'Giver (optional)';
    else partyLabel.textContent = 'From (optional)';
  }
  if (partyInput instanceof HTMLInputElement) {
    partyInput.required = (kind === 'tithes');
  }
}

function financeSetQuickKind(kind, { render = true } = {}) {
  const k = financeNormalizeKey(kind);
  if (!k) return;
  financeQuickKind = k;

  // Sync the mini-tabs UI
  const tabs = $('financeQuickTabs');
  if (tabs) {
    const btns = Array.from(tabs.querySelectorAll('[data-fin-kind]'));
    for (const b of btns) {
      const v = String(b.getAttribute('data-fin-kind') || '');
      b.setAttribute('aria-selected', v === financeQuickKind ? 'true' : 'false');
    }
  }

  // Sync the type checkboxes in the filter menu.
  const incomeCb = $('financeTypeIncome');
  const expenseCb = $('financeTypeExpense');
  if (incomeCb instanceof HTMLInputElement && expenseCb instanceof HTMLInputElement) {
    if (financeQuickKind === 'expense') {
      incomeCb.checked = false;
      expenseCb.checked = true;
    } else {
      incomeCb.checked = true;
      expenseCb.checked = false;
    }
  }

  financeApplyKindToForm(financeQuickKind);
  if (render) renderFinances();
}

function financeReadCheckedRangeDays(menuEl) {
  if (!menuEl) return [];
  const inputs = Array.from(menuEl.querySelectorAll('input[data-fin-range]'));
  const days = [];
  for (const el of inputs) {
    if (!(el instanceof HTMLInputElement)) continue;
    if (!el.checked) continue;
    const v = String(el.getAttribute('data-fin-range') || '').trim();
    if (/^\d+$/.test(v)) days.push(Number(v));
  }
  return days;
}

function financeCurrentFilters() {
  const selectedTypes = financeSelectedTypes();
  return {
    from: String($('financeFrom')?.value || ''),
    to: String($('financeTo')?.value || ''),
    type: String($('financeTypeFilter')?.value || ''),
    types: selectedTypes,
    kind: String(financeQuickKind || ''),
    search: String($('financeSearch')?.value || '').trim().toLowerCase()
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

  const setOptions = (sel, values, { required = false } = {}) => {
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
    if (current && !unique.includes(current) && current !== FIN_CREATE_VALUE) unique.unshift(current);

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

    if (current && Array.from(sel.options).some((o) => o.value === current)) sel.value = current;
  };

  setOptions(catSel, categories, { required: true });
  setOptions(fundSel, funds, { required: false });
}

function normalizeFinanceName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

async function financeHandleCreateSelect(kind) {
  const sel = kind === 'fund' ? $('financeFund') : $('financeCategory');
  if (!(sel instanceof HTMLSelectElement)) return;
  if (String(sel.value || '') !== FIN_CREATE_VALUE) return;

  // Reset immediately so cancel doesn't leave it stuck on the sentinel.
  sel.value = '';

  const label = kind === 'fund' ? 'fund' : 'category';
  const next = normalizeFinanceName(prompt(`Create new ${label} name`));
  if (!next) return;

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
  const cancelBtn = $('financeCancelEditBtn');
  const saveBtn = $('financeSaveBtn');
  if (cancelBtn) cancelBtn.hidden = !isEditing;
  if (saveBtn) saveBtn.textContent = isEditing ? 'Save Changes' : 'Add Entry';
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

  // Ensure the form reflects the selected quick tab.
  financeApplyKindToForm(financeQuickKind);
}

function financeStartEdit(entry) {
  if (!entry) return;
  financeSetQuickKind(financeDetectKindFromEntry(entry), { render: false });
  $('financeEditId').value = String(entry.id || '');
  $('financeDate').value = String(entry.date || '');
  $('financeType').value = String(entry.type || 'income');
  $('financeCategory').value = String(entry.category || '');
  $('financeFund').value = String(entry.fund || '');
  $('financeMethod').value = String(entry.method || '');
  $('financeAmount').value = (Number(entry.amountCents || 0) / 100).toFixed(2);
  $('financeParty').value = String(entry.party || '');
  $('financeMemo').value = String(entry.memo || '');
  financeSetEditMode(true);
  try { $('financeCategory').focus(); } catch { /* ignore */ }
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

function renderFinances() {
  populateFinanceDatalists();
  populateFinancePartyDatalist();

  const filters = financeCurrentFilters();
  const all = Array.isArray(finances?.entries) ? finances.entries : [];
  const rows = all.filter((e) => financeEntryMatches(e, filters));

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

  if ($('financeIncomeTotal')) $('financeIncomeTotal').textContent = `${formatMoneyCents(income)} income`;
  if ($('financeExpenseTotal')) $('financeExpenseTotal').textContent = `${formatMoneyCents(expense)} expense`;
  if ($('financeNetTotal')) $('financeNetTotal').textContent = `${formatMoneyCents(net)} net`;

  const meta = $('financePrintMeta');
  if (meta) {
    const range = filters.from || filters.to ? `${filters.from || '…'} to ${filters.to || '…'}` : 'All dates';
    meta.textContent = `Printed: ${formatLocalTimestamp()} • Report: Finance ledger • ${range} • ${rows.length} entries • Income ${formatMoneyCents(income)} • Expense ${formatMoneyCents(expense)} • Net ${formatMoneyCents(net)}`;
  }

  const tbody = $('financeTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Weekly Giving summary is independent of the table/filters.
  renderWeeklyGiving();

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.textContent = 'No entries match the current filters.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const e of rows) {
    const tr = document.createElement('tr');

    const amountCents = Number(e?.amountCents || 0);
    const amtTd = document.createElement('td');
    amtTd.className = `num ${String(e?.type) === 'income' ? 'financeAmt--income' : 'financeAmt--expense'}`;
    const sign = String(e?.type) === 'expense' ? '-' : '';
    amtTd.textContent = `${sign}${formatMoneyCents(amountCents)}`;

    const mkTd = (text) => {
      const td = document.createElement('td');
      td.textContent = String(text || '');
      return td;
    };

    tr.appendChild(mkTd(e?.date));
    tr.appendChild(mkTd(e?.type));
    tr.appendChild(mkTd(e?.category));
    tr.appendChild(mkTd(e?.fund));
    tr.appendChild(mkTd(e?.method));
    tr.appendChild(mkTd(e?.party));
    tr.appendChild(mkTd(e?.memo));
    tr.appendChild(amtTd);

    const actions = document.createElement('td');
    actions.className = 'noPrint';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn--sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => financeStartEdit(e));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--sm';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', async () => {
      if (!confirmWrite('Delete this finance entry? This cannot be undone.')) return;
      setFinanceHint('Deleting…');
      try {
        const res = await api(`/api/finances/entries/${encodeURIComponent(String(e.id))}`, { method: 'DELETE' });
        finances = res.data;
        financeResetForm();
        renderFinances();
        setFinanceHint('Deleted.');
      } catch (err) {
        setFinanceHint(err.message);
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    actions.style.display = 'flex';
    actions.style.gap = '8px';

    tr.appendChild(actions);
    tbody.appendChild(tr);
  }

  renderWeeklyGiving();
}

async function loadFinances() {
  const data = await api('/api/finances', { method: 'GET' });
  finances = data;
  if ($('financeDate') && !$('financeDate').value) $('financeDate').value = isoDateToday();
  // Hide custom range UI unless the user explicitly opens it.
  if ($('financeCustomRange')) {
    const customToggle = $('financeCustomToggle');
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
  if ($('financeTithesTotal')) $('financeTithesTotal').textContent = `${formatMoneyCents(tithes)} tithes`;
  if ($('financeOfferingsTotal')) $('financeOfferingsTotal').textContent = `${formatMoneyCents(offerings)} offerings`;
  if ($('financeGivingTotal')) $('financeGivingTotal').textContent = `${formatMoneyCents(total)} total`;
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

  if (panelId === 'panel-photos-bucket') {
    // Lazy refresh when switching to the bucket browser.
    // Do not fetch before login (would spam 401s and confuse the login flow).
    const dashboard = $('dashboardCard');
    const loggedIn = dashboard && dashboard.hidden === false;
    if (loggedIn) loadR2Tree(r2Prefix).catch(() => {});
  }
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
const PHOTO_ROWS_PER_PAGE = 6;

const FIN_CREATE_VALUE = '__CREATE__';

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

function photoUpdateBulkBar() {
  const bar = $('photoBulkBar');
  const count = $('photoBulkCount');
  if (!bar) return;
  const n = photoSelectedIds.size;
  bar.hidden = n === 0;
  if (count) count.textContent = n ? `${n} selected` : '';

  // For the nav bulk bar, CSS handles sticky using the header bumper.
  if (bar.classList.contains('photoBulkBar--nav')) return;

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

    const label = document.createElement('div');
    label.className = 'thumb__label';
    label.textContent = item.label || item.album || 'Photo';

    const small = document.createElement('div');
    small.className = 'thumb__small';
    small.textContent = `${item.album || 'General'} • ${formatDate(item.createdAt)}`;

    const tags = document.createElement('div');
    tags.className = 'thumb__small';
    tags.textContent = (item.tags || []).length ? `Tags: ${(item.tags || []).join(', ')}` : '';

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const view = document.createElement('a');
    view.className = 'btn';
    view.href = item.file || item.thumb || '#';
    view.target = '_blank';
    view.rel = 'noopener noreferrer';
    view.textContent = 'View';
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

    if (isManualMode()) {
      const up = document.createElement('button');
      up.className = 'btn';
      up.type = 'button';
      up.textContent = 'Up';

      const down = document.createElement('button');
      down.className = 'btn';
      down.type = 'button';
      down.textContent = 'Down';

      up.addEventListener('click', async () => {
        const album = String(photoArrangeAlbum || '').trim();
        if (!album) return;
        const ordered = items.map((x) => String(x.id));
        const idx = ordered.indexOf(String(item.id));
        if (idx <= 0) return;
        [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
        await saveManualOrder(album, ordered);
        applyPhotoFilters();
      });

      down.addEventListener('click', async () => {
        const album = String(photoArrangeAlbum || '').trim();
        if (!album) return;
        const ordered = items.map((x) => String(x.id));
        const idx = ordered.indexOf(String(item.id));
        if (idx === -1 || idx >= ordered.length - 1) return;
        [ordered[idx + 1], ordered[idx]] = [ordered[idx], ordered[idx + 1]];
        await saveManualOrder(album, ordered);
        applyPhotoFilters();
      });

      actions.appendChild(up);
      actions.appendChild(down);
    }

    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this photo?')) return;
      await api(`/api/gallery/${item.id}`, { method: 'DELETE' });
      await loadGallery();
    });

    actions.appendChild(del);

    meta.appendChild(label);
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
      if (!confirmWrite(`Delete this object from R2?\n\n${key}`)) return;
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
    setR2Status(data?.truncated ? 'Showing first page (use narrower prefix for faster browsing).' : '');
  } catch (e) {
    const msg = String(e?.message || e || 'Unable to load bucket listing.');
    setR2Status(msg);
    showToast(msg, { variant: 'danger' });
    throw e;
  }
}

async function syncFromR2(prefix, { confirm: shouldConfirm = true } = {}) {
  const p = normalizeR2Prefix(prefix);
  if (shouldConfirm) {
    const ok = confirmWrite(`Sync D1 gallery records from R2 under:\n\n${p}\n\nThis updates what the public Photo Gallery shows.`);
    if (!ok) {
      setR2Status('Sync canceled.');
      return { ok: false, canceled: true };
    }
  }

  setR2UiBusy(true);
  setR2Status('Syncing…');

  if (syncProgressHideTimer) {
    try { window.clearTimeout(syncProgressHideTimer); } catch { /* ignore */ }
    syncProgressHideTimer = null;
  }

  setSyncProgress({ visible: true, indeterminate: true, text: 'Starting sync…' });

  let cursor = null;
  const seenCursors = new Set();
  let loops = 0;
  let totalAdded = 0;
  let totalExisting = 0;
  let totalProcessed = 0;

  try {
    while (true) {
      loops += 1;
      if (loops > 500) throw new Error('Sync aborted: too many pages (possible cursor loop).');

      setSyncProgress({
        visible: true,
        indeterminate: false,
        max: 500,
        value: loops,
        text: `Syncing… page ${loops} • processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`
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
      setR2Status(`Syncing… processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`);

      setSyncProgress({
        visible: true,
        indeterminate: false,
        max: 500,
        value: loops,
        text: `Syncing… page ${loops} • processed ${totalProcessed} (added ${totalAdded}, existing ${totalExisting})`
      });
      cursor = res.nextCursor;
      if (!cursor) break;
      if (seenCursors.has(String(cursor))) throw new Error('Sync aborted: pagination cursor repeated (possible server cursor bug).');
      seenCursors.add(String(cursor));
    }
    setR2Status(`Sync complete. Added ${totalAdded} item(s).`);
    setSyncProgress({ visible: true, indeterminate: false, max: 500, value: Math.min(500, loops), text: `Sync complete. Added ${totalAdded} item(s).` });
    showToast(`Gallery synced. Added ${totalAdded} item(s).`, { variant: 'success' });
    await loadGallery();
    await loadR2Tree(p);
    return { ok: true, added: totalAdded, existing: totalExisting, processed: totalProcessed };
  } catch (e) {
    setR2Status(e.message);
    setSyncProgress({ visible: true, indeterminate: false, max: 500, value: Math.min(500, loops || 0), text: `Sync failed: ${String(e?.message || e || 'Unknown error')}` });
    showToast(`Gallery sync failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
    return { ok: false, error: String(e?.message || e || 'Unknown error') };
  } finally {
    setR2UiBusy(false);
  }
}

// -------- Announcements --------
let announcementPosts = [];

function renderAnnouncements() {
  const root = $('announceList');
  root.innerHTML = '';

  for (const post of announcementPosts) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = post.title;
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    const created = post.createdAt ? `Posted: ${formatDate(post.createdAt)}` : '';
    const expires = post.expiresAt ? ` • Expires: ${formatDate(post.expiresAt)}` : ' • Expires: Never';
    meta.textContent = `${created}${expires}`.trim();

    const body = document.createElement('div');
    body.className = 'row__meta';
    body.textContent = post.body;

    main.appendChild(t);
    main.appendChild(meta);
    main.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'row__actions';
    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this announcement?')) return;
      await api(`/api/announcements/${post.id}`, { method: 'DELETE' });
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

function renderEvents() {
  const root = $('eventList');
  root.innerHTML = '';

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
        editingEventId = null;
        await loadEvents();
      });

      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
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
  }
  renderEvents();
  refreshEventsPrintOptions();
}

// -------- Bulletins --------
let bulletins = [];

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

function renderBulletins() {
  const root = $('bulletinList');
  root.innerHTML = '';

  for (const b of bulletins) {
    const row = document.createElement('div');
    row.className = 'row';

    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = `${b.title || 'Bulletin'} • ${b.originalName || ''}`.trim();
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    const active = isActiveBulletin(b);
    meta.textContent = `${active ? 'Active now' : ''}${active ? ' • ' : ''}${toLocalDateTimeValue(b.startsAt)} → ${toLocalDateTimeValue(b.endsAt)}`;

    main.appendChild(t);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'row__actions';

    const open = document.createElement('a');
    open.className = 'btn';
    open.href = b.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open';

    const del = document.createElement('button');
    del.className = 'btn';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this bulletin?')) return;
      await api(`/api/bulletins/${b.id}`, { method: 'DELETE' });
      await loadBulletins();
    });

    actions.appendChild(open);
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

// -------- Load everything --------
async function loadAll() {
  const results = await Promise.allSettled([
    loadGallery(),
    loadAnnouncements(),
    loadEvents(),
    loadBulletins(),
    loadFinances(),
  ]);

  // Keep bucket browsing non-blocking so a missing endpoint can't break login.
  try {
    await loadR2Tree(r2Prefix);
  } catch {
    // loadR2Tree reports status in the UI.
  }

  for (const r of results) {
    if (r.status === 'rejected') throw r.reason;
  }
}

// -------- Wire UI --------
document.addEventListener('DOMContentLoaded', async () => {
  updateHeaderBumper();
  window.addEventListener('resize', () => {
    try { updateHeaderBumper(); } catch { /* ignore */ }
  });

  resetTransientUiState();

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

  // Tabs
  $('tabBtn-photos').addEventListener('click', () => setTab('tab-photos'));
  $('tabBtn-events').addEventListener('click', () => setTab('tab-events'));
  $('tabBtn-content').addEventListener('click', () => {
    setTab('tab-content');
    setContentSubTab('panel-content-announcements');
  });
  $('tabBtn-finances').addEventListener('click', () => setTab('tab-finances'));
  if ($('tabBtn-support')) $('tabBtn-support').addEventListener('click', () => setTab('tab-support'));

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
  if ($('subTabBtn-photos-bucket')) {
    $('subTabBtn-photos-bucket').addEventListener('click', () => setPhotosSubTab('panel-photos-bucket'));
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
      setFinanceHint('');

      const id = String($('financeEditId').value || '');
      const payload = {
        date: String($('financeDate').value || ''),
        type: String($('financeType').value || ''),
        category: String($('financeCategory').value || ''),
        fund: String($('financeFund').value || ''),
        method: String($('financeMethod').value || ''),
        amount: String($('financeAmount').value || ''),
        party: String($('financeParty').value || ''),
        memo: String($('financeMemo').value || '')
      };

      if (!confirmWrite(id ? 'Save changes to this entry?' : 'Add this finance entry?')) return;
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
        financeResetForm();
        renderFinances();
        setFinanceHint(id ? 'Saved.' : 'Added.');
      } catch (err) {
        setFinanceHint(err.message);
      }
    });

    // “Create …” option handling for Category/Fund dropdowns
    if ($('financeCategory')) {
      $('financeCategory').addEventListener('change', () => financeHandleCreateSelect('category'));
    }
    if ($('financeFund')) {
      $('financeFund').addEventListener('change', () => financeHandleCreateSelect('fund'));
    }
  }

  if ($('financeCancelEditBtn')) {
    $('financeCancelEditBtn').addEventListener('click', () => {
      financeResetForm();
      renderFinances();
      setFinanceHint('');
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

  // Finance quick tabs (Income / Expense / Tithes / Offerings)
  if ($('financeQuickTabs')) {
    const wrap = $('financeQuickTabs');
    const btns = Array.from(wrap.querySelectorAll('[data-fin-kind]'));
    for (const b of btns) {
      b.addEventListener('click', () => {
        const kind = b.getAttribute('data-fin-kind');
        financeSetQuickKind(kind);
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

  // Default quick view
  financeSetQuickKind(financeQuickKind, { render: false });

  if ($('financeSearchForm')) {
    $('financeSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      renderFinances();
      const menu = $('financeFilterMenu');
      if (menu && menu.open) menu.open = false;
    });
  }

  // Filter dropdown (multi-select presets + custom)
  if ($('financeFilterMenu')) {
    const menu = $('financeFilterMenu');
    const rangeInputs = Array.from(menu.querySelectorAll('input[data-fin-range]'))
      .filter((el) => el instanceof HTMLInputElement);
    const customToggle = $('financeCustomToggle');

    const uncheckNumericRanges = () => {
      for (const el of rangeInputs) {
        const v = String(el.getAttribute('data-fin-range') || '').trim();
        if (/^\d+$/.test(v)) el.checked = false;
      }
    };

    const applyCheckedPresets = () => {
      const days = financeReadCheckedRangeDays(menu);
      if (days.length > 0) {
        setFinanceCustomMode(false);
        if (customToggle instanceof HTMLInputElement) customToggle.checked = false;
        setFinanceRangePreset(Math.max(...days));
        return true;
      }
      return false;
    };

    for (const el of rangeInputs) {
      el.addEventListener('change', () => {
        const v = String(el.getAttribute('data-fin-range') || '').trim();

        if (v === 'custom') {
          const isOn = !!el.checked;
          setFinanceCustomMode(isOn);
          if (isOn) uncheckNumericRanges();
          renderFinances();
          return;
        }

        // Numeric preset changed
        setFinanceCustomMode(false);
        if (customToggle instanceof HTMLInputElement) customToggle.checked = false;

        const applied = applyCheckedPresets();
        if (!applied) {
          if ($('financeFrom')) $('financeFrom').value = '';
          if ($('financeTo')) $('financeTo').value = '';
        }
        renderFinances();
      });
    }
  }

  if ($('financeApplyCustomRangeBtn')) {
    $('financeApplyCustomRangeBtn').addEventListener('click', () => {
      setFinanceCustomMode(true);
      if ($('financeCustomToggle') instanceof HTMLInputElement) $('financeCustomToggle').checked = true;
      renderFinances();
      const menu = $('financeFilterMenu');
      if (menu) menu.open = false;
    });
  }

  if ($('financeClearRangeBtn')) {
    $('financeClearRangeBtn').addEventListener('click', () => {
      if ($('financeFrom')) $('financeFrom').value = '';
      if ($('financeTo')) $('financeTo').value = '';
      if ($('financeCustomToggle') instanceof HTMLInputElement) $('financeCustomToggle').checked = false;
      if ($('financeFilterMenu')) {
        const menu = $('financeFilterMenu');
        const rangeInputs = Array.from(menu.querySelectorAll('input[data-fin-range]'))
          .filter((el) => el instanceof HTMLInputElement);
        for (const el of rangeInputs) {
          const v = String(el.getAttribute('data-fin-range') || '').trim();
          if (/^\d+$/.test(v)) el.checked = false;
        }
      }
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
      closeDetailsMenu('financePrintMenu');
      setPrintMode('finance');
      renderFinances();
      window.print();
    });
  }

  if ($('printFinanceReceiptsBtn')) {
    $('printFinanceReceiptsBtn').addEventListener('click', () => {
      closeDetailsMenu('financePrintMenu');

      const dlg = $('financeReceiptsDialog');
      if (!dlg) return;

      // Open dialog (robust fallback)
      if (typeof dlg.showModal === 'function') {
        try { dlg.showModal(); }
        catch { dlg.setAttribute('open', ''); }
      } else {
        dlg.setAttribute('open', '');
      }

      // Render the picker list using current filters.
      financeRenderReceiptsPicker({ keepSelection: true });
      try { $('financeReceiptsSearch')?.focus(); } catch { /* ignore */ }
    });
  }

  if ($('financeReceiptsDialog')) {
    const dlg = $('financeReceiptsDialog');
    const closeDlg = () => {
      try {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
      } catch {
        dlg.removeAttribute('open');
      }
    };

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) closeDlg();
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeDlg();
    });

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

  if ($('printEventsAllBtn')) {
    $('printEventsAllBtn').addEventListener('click', async () => {
      closeDetailsMenu('financePrintMenu');
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
      closeDetailsMenu('financePrintMenu');
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
      closeDetailsMenu('financePrintMenu');
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

    if (!confirmWrite('Upload selected photo(s)?')) return;

    hint.textContent = 'Uploading…';

    const fd = new FormData(form);
    await csrfReady;
    const res = await fetch('/api/gallery/upload', {
      method: 'POST',
      body: fd,
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      credentials: 'same-origin'
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      hint.textContent = data.error || 'Upload failed.';
      return;
    }

    hint.textContent = `Uploaded ${data.added?.length || 0} photo(s).`;
    if (form && typeof form.reset === 'function') form.reset();
    await loadGallery();
  });

  $('photoSort').addEventListener('change', applyPhotoFilters);
  $('photoAlbumFilter').addEventListener('input', applyPhotoFilters);
  $('photoTagFilter').addEventListener('input', applyPhotoFilters);

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

      if (!confirmWrite(`Apply changes to ${ids.length} selected photo(s)?`)) return;

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
        showToast(`Updated ${ok} photo(s).`, { variant: 'success' });
      } catch (e) {
        showToast(`Bulk edit failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
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
      if (!confirmWrite(`Delete ${ids.length} selected photo(s)?\n\nThis cannot be undone.`)) return;

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
        showToast(`Deleted ${ok} photo(s).`, { variant: 'success' });
      } catch (e) {
        showToast(`Bulk delete failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
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
      btn.textContent = 'Syncing…';
    }

    // Failsafe: never leave the UI stuck forever.
    const watchdog = window.setTimeout(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText || 'Sync Gallery';
      }
      setR2UiBusy(false);
      setR2Status('Sync timed out.');
      showToast('Gallery sync timed out. Please try again.', { variant: 'danger' });
    }, 120_000);

    try {
      // Avoid confirm() here: some embedded browsers/policies block dialogs,
      // which makes the button appear to do nothing.
      const out = await syncFromR2('gallery/', { confirm: false });
      if (out?.canceled) showToast('Gallery sync canceled.', { variant: 'success' });
    } catch (e) {
      showToast(`Gallery sync failed: ${String(e?.message || e || 'Unknown error')}`, { variant: 'danger' });
    } finally {
      window.clearTimeout(watchdog);
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText || 'Sync Gallery';
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
    const openDlg = () => {
      if (typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
          return;
        } catch {
          // Some environments expose showModal but still throw.
        }
      }
      dlg.setAttribute('open', '');
    };
    const closeDlg = () => {
      try {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
      } catch {
        dlg.removeAttribute('open');
      }
    };

    if (!window.__mmmbcPhotoHelpDelegated) {
      window.__mmmbcPhotoHelpDelegated = true;
      const handler = (e) => {
        const btn = e.target?.closest ? e.target.closest('#photoHelpBtn') : null;
        if (!btn) return;
        e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        openDlg();
      };
      document.addEventListener('click', handler, true);
      document.addEventListener('pointerup', handler, true);
      document.addEventListener('mouseup', handler, true);
    }

    if ($('photoHelpBtn')) {
      $('photoHelpBtn').addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
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
    dlg.addEventListener('click', (e) => {
      // Close when clicking the backdrop
      if (e.target === dlg) closeDlg();
    });

    // Escape key / cancel
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeDlg();
    });

    if (!window.__mmmbcPhotoHelpEscBound) {
      window.__mmmbcPhotoHelpEscBound = true;
      document.addEventListener('keydown', (e) => {
        const k = String(e.key || '').toLowerCase();
        if (k !== 'escape') return;
        if (!dlg.hasAttribute('open')) return;
        e.preventDefault();
        closeDlg();
      }, true);
    }
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

  // Announcements
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
    hint.textContent = 'Posted.';
    await loadAnnouncements();
  });

  // Hash navigation (e.g. /admin/#announcements)
  window.addEventListener('hashchange', () => {
    refreshAuthUI().catch(() => {});
  });

  // Events
  $('eventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('eventHint');

    if (!confirmWrite('Save this event?')) return;

    hint.textContent = 'Saving…';

    const fd = new FormData(e.currentTarget);
    await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({ title: fd.get('title'), date: fd.get('date'), time: fd.get('time') })
    });

    safeResetForm(e);
    hint.textContent = 'Saved.';
    await loadEvents();
  });

  // Bulletins (multipart)
  $('bulletinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = $('bulletinHint');

    if (!confirmWrite('Upload and schedule this bulletin?')) return;

    hint.textContent = 'Uploading…';

    const fd = new FormData(e.currentTarget);
    const createAnnouncement = fd.get('createAnnouncement') === 'on';
    fd.set('createAnnouncement', createAnnouncement ? 'true' : 'false');

    await csrfReady;
    const res = await fetch('/api/bulletins/upload', {
      method: 'POST',
      body: fd,
      headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
      credentials: 'same-origin'
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      hint.textContent = data.error || 'Upload failed.';
      return;
    }

    hint.textContent = 'Scheduled.';
    safeResetForm(e);
    await loadBulletins();
  });

  // Users (Settings/User accounts removed from UI)
  if ($('userForm')) {
    $('userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = $('userHint');

      if (!confirmWrite('Create an admin invite link for this email?')) return;

      hint.textContent = 'Creating invite…';

      const fd = new FormData(e.currentTarget);
      const res = await api('/api/users/invite', {
        method: 'POST',
        body: JSON.stringify({ email: String(fd.get('email') || '') })
      });

      safeResetForm(e);
      hint.textContent = `Invite link (expires ${new Date(res.expiresAt).toLocaleString()}): ${res.inviteLink}`;
      await loadUsers();
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
