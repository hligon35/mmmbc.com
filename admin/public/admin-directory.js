(function () {
  const MODULE_KEY = 'mmmbc_directory_module_initialized_v1';
  if (window[MODULE_KEY]) return;
  window[MODULE_KEY] = true;

  const SUBTAB_STORAGE_KEY = 'mmmbc_directory_subtab_v1';
  const CONTACTS_PAGE_SIZE = 25;
  const SUBSCRIBERS_PAGE_SIZE = 25;
  const SEARCH_DEBOUNCE_MS = 260;

  function $(id) {
    return document.getElementById(id);
  }

  function announce(message) {
    const live = $('directoryLiveRegion');
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => {
      live.textContent = String(message || '');
    }, 20);
  }

  function toast(message, variant) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, { variant: variant || 'info' });
      return;
    }
    announce(message);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function maybeText(value, fallback) {
    const out = String(value || '').trim();
    return out || String(fallback || '');
  }

  function normalizePhone(value) {
    const digits = String(value || '').replace(/\D+/g, '');
    if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
    return digits;
  }

  function formatPhone(value) {
    const digits = normalizePhone(value);
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return maybeText(value, 'Not set');
  }

  function formatDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Not set';
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return raw;
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(t));
    } catch {
      return new Date(t).toISOString();
    }
  }

  function formatDateOnly(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'Not set';
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return raw;
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(t));
    } catch {
      return new Date(t).toISOString().slice(0, 10);
    }
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return (...args) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    };
  }

  function promptText(message, defaultValue) {
    const raw = window.prompt(String(message || ''), String(defaultValue || ''));
    if (raw === null) return null;
    const value = String(raw || '').trim();
    return value;
  }

  function csvEscape(value) {
    const raw = String(value == null ? '' : value);
    if (!/[",\n\r]/.test(raw)) return raw;
    return `"${raw.replace(/"/g, '""')}"`;
  }

  function parseCsv(text) {
    const rows = [];
    const input = String(text || '');
    let row = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      const next = input[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cell += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch === '\r') {
        // ignore CR; LF handles line ends
      } else {
        cell += ch;
      }
    }

    if (cell.length || row.length) {
      row.push(cell);
      rows.push(row);
    }

    return rows;
  }

  function triggerFileDownload(filename, content, mimeType) {
    const blob = new Blob([String(content || '')], {
      type: mimeType || 'text/plain;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(filename || 'download.txt');
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function slugifyFilenamePart(value, fallback) {
    const base = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || String(fallback || 'export');
  }

  function normalizeHeaderKey(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  async function api(path, options) {
    if (typeof window.api === 'function') {
      return window.api(path, options || {});
    }

    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(options || {})
    });

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

    if (!res.ok) {
      const msg = String(payload?.error || `Request failed (${res.status})`);
      throw new Error(msg);
    }

    return payload;
  }

  function openDialog(dialogEl, initialFocusId) {
    if (!(dialogEl instanceof HTMLElement)) return;
    if (typeof window.openManagedDialog === 'function') {
      window.openManagedDialog(dialogEl, { initialFocusId: initialFocusId || '' });
      return;
    }
    if (dialogEl instanceof HTMLDialogElement && typeof dialogEl.showModal === 'function') {
      if (!dialogEl.open) dialogEl.showModal();
    } else {
      dialogEl.setAttribute('open', '');
    }
  }

  function closeDialog(dialogEl) {
    if (!(dialogEl instanceof HTMLElement)) return;
    if (typeof window.closeManagedDialog === 'function') {
      window.closeManagedDialog(dialogEl);
      return;
    }
    if (dialogEl instanceof HTMLDialogElement && typeof dialogEl.close === 'function') {
      if (dialogEl.open) dialogEl.close();
    } else {
      dialogEl.removeAttribute('open');
    }
  }

  function wireDialogDismiss(dialogEl, closeFn) {
    if (!(dialogEl instanceof HTMLElement)) return;
    if (typeof window.wireDialogDismissBehavior === 'function') {
      window.wireDialogDismissBehavior(dialogEl, { onClose: closeFn });
      return;
    }
    dialogEl.addEventListener('click', (event) => {
      if (event.target !== dialogEl) return;
      event.preventDefault();
      closeFn();
    });
  }

  const state = {
    booted: false,
    loadingOverview: false,
    contacts: {
      page: 1,
      pageSize: CONTACTS_PAGE_SIZE,
      total: 0,
      totalPages: 1,
      items: [],
      loading: false,
      error: '',
      filters: {
        q: '',
        status: 'all',
        type: 'all',
        group: 'all',
        newsletter: 'all',
        missing: 'all'
      }
    },
    subscribers: {
      page: 1,
      pageSize: SUBSCRIBERS_PAGE_SIZE,
      total: 0,
      totalPages: 1,
      items: [],
      loading: false,
      error: '',
      filters: {
        q: '',
        status: 'all',
        source: 'all',
        list: 'all'
      }
    },
    groups: {
      groups: [],
      lists: []
    },
    permissions: {
      canReadBasic: false,
      canReadPrivate: false,
      canManageContacts: false,
      canArchiveContacts: false,
      canManageSubscribers: false,
      canManageGroups: false,
      canImportExport: false
    },
    selectedContactId: '',
    editingContactId: ''
  };

  function buildContactsParams(page, pageSize, filters) {
    const f = filters || {};
    const q = new URLSearchParams();
    q.set('page', String(page));
    q.set('pageSize', String(pageSize));
    if (f.q) q.set('q', f.q);
    if (f.status && f.status !== 'all') q.set('status', f.status);
    if (f.type && f.type !== 'all') q.set('contactType', f.type);
    if (f.group && f.group !== 'all') q.set('groupId', f.group);
    if (f.newsletter && f.newsletter !== 'all') q.set('newsletterStatus', f.newsletter);
    if (f.missing && f.missing !== 'all') q.set('missing', f.missing);
    return q.toString();
  }

  function buildSubscribersParams(page, pageSize, filters) {
    const f = filters || {};
    const q = new URLSearchParams();
    q.set('page', String(page));
    q.set('pageSize', String(pageSize));
    if (f.q) q.set('q', f.q);
    if (f.status && f.status !== 'all') q.set('status', f.status);
    if (f.source && f.source !== 'all') q.set('source', f.source);
    if (f.list && f.list !== 'all') q.set('listId', f.list);
    return q.toString();
  }

  async function fetchAllContacts(filters) {
    const out = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;
    while (page <= totalPages) {
      const res = await api(`/api/directory/contacts?${buildContactsParams(page, pageSize, filters)}`, { method: 'GET' });
      const items = Array.isArray(res?.items) ? res.items : [];
      out.push(...items);
      totalPages = Math.max(1, Number(res?.pagination?.totalPages || 1));
      page += 1;
    }
    return out;
  }

  async function fetchAllSubscribers(filters) {
    const out = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;
    while (page <= totalPages) {
      const res = await api(`/api/directory/subscribers?${buildSubscribersParams(page, pageSize, filters)}`, { method: 'GET' });
      const items = Array.isArray(res?.items) ? res.items : [];
      out.push(...items);
      totalPages = Math.max(1, Number(res?.pagination?.totalPages || 1));
      page += 1;
    }
    return out;
  }

  async function ensureListsLoaded() {
    if (Array.isArray(state.groups.lists) && state.groups.lists.length) return;
    await loadGroupsAndLists();
  }

  function pickListByPrompt(candidates, title) {
    const options = (Array.isArray(candidates) ? candidates : []).filter((row) => row && row.id && row.name);
    if (!options.length) return { cancelled: false, item: null, error: 'No email lists are available.' };

    const menu = options.map((item, index) => `${index + 1}. ${item.name}`).join('\n');
    const raw = promptText(`${title}\n\n${menu}\n\nType the number or exact list name:`);
    if (raw === null) return { cancelled: true, item: null, error: '' };
    if (!raw) return { cancelled: false, item: null, error: 'No list was selected.' };

    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return { cancelled: false, item: options[index - 1], error: '' };
    }

    const normalized = raw.toLowerCase();
    const match = options.find((item) => String(item.name || '').trim().toLowerCase() === normalized);
    if (!match) return { cancelled: false, item: null, error: 'List not found. Use the list number or exact name.' };
    return { cancelled: false, item: match, error: '' };
  }

  function csvFromContacts(items) {
    const headers = [
      'id', 'first_name', 'last_name', 'preferred_name', 'contact_type', 'status',
      'account_number',
      'primary_email', 'secondary_email', 'mobile_phone', 'home_phone', 'preferred_contact_method',
      'membership_status', 'member_since', 'ministry', 'leadership_role', 'newsletter_status',
      'newsletter_email', 'consent_source', 'consent_date', 'updated_at'
    ];
    const lines = [headers.join(',')];
    for (const item of (Array.isArray(items) ? items : [])) {
      const values = [
        item?.id,
        item?.firstName,
        item?.lastName,
        item?.preferredName,
        item?.contactType,
        item?.status,
        item?.accountNumber,
        item?.primaryEmail,
        item?.secondaryEmail,
        item?.mobilePhone,
        item?.homePhone,
        item?.preferredContactMethod,
        item?.membershipStatus,
        item?.memberSince,
        item?.ministry,
        item?.leadershipRole,
        item?.newsletter?.status || item?.newsletterStatus,
        item?.newsletter?.email,
        item?.newsletter?.consentSource,
        item?.newsletter?.consentDate,
        item?.updatedAt
      ].map(csvEscape);
      lines.push(values.join(','));
    }
    return lines.join('\n');
  }

  function csvFromSubscribers(items) {
    const headers = [
      'id', 'contact_id', 'email', 'status', 'consent_source', 'consent_date',
      'confirmed_at', 'unsubscribed_at', 'suppression_reason', 'lists', 'updated_at'
    ];
    const lines = [headers.join(',')];
    for (const item of (Array.isArray(items) ? items : [])) {
      const values = [
        item?.id,
        item?.contactId,
        item?.email,
        item?.status,
        item?.consentSource,
        item?.consentDate,
        item?.confirmedAt,
        item?.unsubscribedAt,
        item?.suppressionReason,
        Array.isArray(item?.listNames) ? item.listNames.join('; ') : '',
        item?.updatedAt
      ].map(csvEscape);
      lines.push(values.join(','));
    }
    return lines.join('\n');
  }

  function getImportCell(rowObj, candidates) {
    for (const key of candidates) {
      const normalized = normalizeHeaderKey(key);
      if (normalized in rowObj) {
        const value = String(rowObj[normalized] || '').trim();
        if (value) return value;
      }
    }
    return '';
  }

  function mapImportRowToContactPayload(rowObj) {
    let firstName = getImportCell(rowObj, ['first_name', 'firstname', 'first name']);
    let lastName = getImportCell(rowObj, ['last_name', 'lastname', 'last name']);
    const fullName = getImportCell(rowObj, ['full_name', 'fullname', 'name']);
    if ((!firstName || !lastName) && fullName) {
      const parts = fullName.split(/\s+/).filter(Boolean);
      if (!firstName && parts.length) firstName = parts[0];
      if (!lastName && parts.length > 1) lastName = parts.slice(1).join(' ');
    }

    const newsletterStatusRaw = getImportCell(rowObj, ['newsletter_status', 'subscriber_status', 'subscription_status']).toLowerCase();
    const newsletterStatus = ['subscribed', 'pending', 'unsubscribed', 'not_subscribed'].includes(newsletterStatusRaw)
      ? newsletterStatusRaw
      : 'not_subscribed';

    return {
      firstName,
      lastName,
      preferredName: getImportCell(rowObj, ['preferred_name', 'nickname']),
      accountNumber: getImportCell(rowObj, ['account_number', 'account_id', 'member_number', 'donor_number']),
      contactType: getImportCell(rowObj, ['contact_type', 'type']).toLowerCase() || 'member',
      status: getImportCell(rowObj, ['status']).toLowerCase() || 'active',
      primaryEmail: getImportCell(rowObj, ['primary_email', 'email']).toLowerCase(),
      secondaryEmail: getImportCell(rowObj, ['secondary_email']).toLowerCase(),
      mobilePhone: getImportCell(rowObj, ['mobile_phone', 'phone', 'cell_phone']),
      homePhone: getImportCell(rowObj, ['home_phone']),
      preferredContactMethod: getImportCell(rowObj, ['preferred_contact_method', 'contact_method']).toLowerCase(),
      membershipStatus: getImportCell(rowObj, ['membership_status']),
      memberSince: getImportCell(rowObj, ['member_since']),
      addressLine1: getImportCell(rowObj, ['address_line_1', 'address1', 'street']),
      addressLine2: getImportCell(rowObj, ['address_line_2', 'address2']),
      city: getImportCell(rowObj, ['city']),
      state: getImportCell(rowObj, ['state']),
      postalCode: getImportCell(rowObj, ['postal_code', 'zipcode', 'zip']),
      birthMonth: getImportCell(rowObj, ['birth_month']),
      birthDay: getImportCell(rowObj, ['birth_day']),
      anniversaryMonth: getImportCell(rowObj, ['anniversary_month']),
      anniversaryDay: getImportCell(rowObj, ['anniversary_day']),
      notes: getImportCell(rowObj, ['notes', 'note']),
      newsletter: {
        status: newsletterStatus,
        consentSource: getImportCell(rowObj, ['consent_source']) || (newsletterStatus === 'subscribed' ? 'imported_documented_consent' : ''),
        consentDate: getImportCell(rowObj, ['consent_date'])
      }
    };
  }

  function statusChip(status) {
    const value = String(status || '').trim().toLowerCase();
    if (['active', 'subscribed'].includes(value)) {
      return '<span class="directoryChip directoryChip--ok">Active</span>';
    }
    if (['pending'].includes(value)) {
      return '<span class="directoryChip directoryChip--warn">Pending</span>';
    }
    if (['unsubscribed', 'suppressed', 'complained', 'bounced', 'archived', 'inactive'].includes(value)) {
      return `<span class="directoryChip directoryChip--danger">${escapeHtml(value.replace(/_/g, ' '))}</span>`;
    }
    return `<span class="directoryChip">${escapeHtml(value || 'unknown')}</span>`;
  }

  function initialsOf(item) {
    const first = String(item?.firstName || item?.first_name || '').trim();
    const last = String(item?.lastName || item?.last_name || '').trim();
    const name = [first, last].filter(Boolean).join(' ').trim();
    if (!name) return '--';
    const parts = name.split(/\s+/).filter(Boolean);
    return `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase() || '--';
  }

  function contactDisplayName(item) {
    const first = maybeText(item?.firstName || item?.first_name, '');
    const last = maybeText(item?.lastName || item?.last_name, '');
    const full = `${first} ${last}`.trim();
    return full || 'Unnamed contact';
  }

  function preferredLabel(item) {
    const preferred = maybeText(item?.preferredName || item?.preferred_name, '');
    return preferred ? `Preferred: ${preferred}` : '';
  }

  function wireActionButtons(scopeRoot, selector, action) {
    if (!(scopeRoot instanceof HTMLElement)) return;
    scopeRoot.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!(target instanceof HTMLElement)) return;
      action(target, event);
    });
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value || '');
  }

  function setHidden(id, hidden) {
    const el = $(id);
    if (el) el.hidden = !!hidden;
  }

  function setError(id, message) {
    const el = $(id);
    if (!el) return;
    const text = String(message || '').trim();
    el.textContent = text;
    el.hidden = !text;
  }

  function syncSelectOptions(idA, idB, options) {
    const a = $(idA);
    const b = $(idB);
    const list = Array.isArray(options) ? options : [];
    const apply = (el) => {
      if (!(el instanceof HTMLSelectElement)) return;
      const current = String(el.value || 'all');
      el.innerHTML = '';
      for (const option of list) {
        const opt = document.createElement('option');
        opt.value = String(option.value || '');
        opt.textContent = String(option.label || option.value || '');
        el.appendChild(opt);
      }
      el.value = list.some((item) => String(item.value) === current) ? current : 'all';
    };
    apply(a);
    apply(b);
  }

  function formatTypeLabel(value) {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase()) || 'Other';
  }

  function ensureSelectValueExists(selectId, value, fallbackLabel) {
    const select = $(selectId);
    const nextValue = String(value || '').trim();
    if (!(select instanceof HTMLSelectElement) || !nextValue) return;
    const exists = Array.from(select.options).some((option) => String(option.value) === nextValue);
    if (!exists) {
      const option = document.createElement('option');
      option.value = nextValue;
      option.textContent = fallbackLabel || formatTypeLabel(nextValue);
      select.appendChild(option);
    }
  }

  function syncContactTypeOptions(types) {
    const normalized = Array.isArray(types)
      ? types.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const uniqueTypes = Array.from(new Set(normalized));
    if (!uniqueTypes.length) return;

    const filterOptions = [{ value: 'all', label: 'All' }, ...uniqueTypes.map((value) => ({ value, label: formatTypeLabel(value) }))];
    syncSelectOptions('directoryContactsTypeDesktop', 'directoryContactsType', filterOptions);

    const contactTypeSelect = $('directoryContactType');
    if (contactTypeSelect instanceof HTMLSelectElement) {
      const current = String(contactTypeSelect.value || 'member').trim().toLowerCase();
      contactTypeSelect.innerHTML = '';
      for (const typeValue of uniqueTypes) {
        const opt = document.createElement('option');
        opt.value = typeValue;
        opt.textContent = formatTypeLabel(typeValue);
        contactTypeSelect.appendChild(opt);
      }
      const fallback = uniqueTypes.includes('member') ? 'member' : uniqueTypes[0];
      contactTypeSelect.value = uniqueTypes.includes(current) ? current : fallback;
    }
  }

  function activeDirectorySubTab() {
    const selected = document.querySelector('#tab-directory .tab--sub[aria-selected="true"]');
    return String(selected?.getAttribute('aria-controls') || '').trim() || 'panel-directory-contacts';
  }

  function saveSubTab(panelId) {
    try {
      window.localStorage.setItem(SUBTAB_STORAGE_KEY, String(panelId || 'panel-directory-contacts'));
    } catch {
      // ignore storage errors
    }
  }

  function restoreSubTab() {
    try {
      const saved = String(window.localStorage.getItem(SUBTAB_STORAGE_KEY) || '').trim();
      if (!saved) return 'panel-directory-contacts';
      return saved;
    } catch {
      return 'panel-directory-contacts';
    }
  }

  function openImportDialog() {
    openDialog($('directoryImportDialog'), 'directoryImportFile');
  }

  function openExportDialog() {
    openDialog($('directoryExportDialog'), 'directoryExportGenerateBtn');
  }

  function openContactFormDialog(contact) {
    state.editingContactId = String(contact?.id || '');
    setText('directoryContactDialogTitle', state.editingContactId ? 'Edit Contact' : 'Add Contact');
    const form = $('directoryContactForm');
    if (!(form instanceof HTMLFormElement)) return;

    const write = (id, value) => {
      const el = $(id);
      if (!el) return;
      el.value = String(value || '');
    };

    write('directoryContactId', contact?.id || '');
    write('directoryContactFirstName', contact?.firstName || contact?.first_name || '');
    write('directoryContactLastName', contact?.lastName || contact?.last_name || '');
    write('directoryContactPreferredName', contact?.preferredName || contact?.preferred_name || '');
    write('directoryContactAccountNumber', contact?.accountNumber || contact?.account_number || '');
    ensureSelectValueExists('directoryContactType', contact?.contactType || contact?.contact_type || 'member');
    write('directoryContactType', contact?.contactType || contact?.contact_type || 'member');
    write('directoryContactStatus', contact?.status || 'active');
    write('directoryContactPrimaryEmail', contact?.primaryEmail || contact?.primary_email || '');
    write('directoryContactSecondaryEmail', contact?.secondaryEmail || contact?.secondary_email || '');
    write('directoryContactMobilePhone', contact?.mobilePhone || contact?.mobile_phone || '');
    write('directoryContactHomePhone', contact?.homePhone || contact?.home_phone || '');
    write('directoryContactPreferredMethod', contact?.preferredContactMethod || contact?.preferred_contact_method || '');
    write('directoryContactMembershipStatus', contact?.membershipStatus || contact?.membership_status || '');
    write('directoryContactMemberSince', contact?.memberSince || contact?.member_since || '');
    write('directoryContactMinistry', contact?.ministry || contact?.ministry_assignment || '');
    write('directoryContactRole', contact?.leadershipRole || contact?.leadership_role || '');
    write('directoryContactAddress1', contact?.addressLine1 || contact?.address_line_1 || '');
    write('directoryContactAddress2', contact?.addressLine2 || contact?.address_line_2 || '');
    write('directoryContactCity', contact?.city || '');
    write('directoryContactState', contact?.state || '');
    write('directoryContactPostalCode', contact?.postalCode || contact?.postal_code || '');
    write('directoryContactBirthMonth', contact?.birthMonth || contact?.birth_month || '');
    write('directoryContactBirthDay', contact?.birthDay || contact?.birth_day || '');
    write('directoryContactAnniversaryMonth', contact?.anniversaryMonth || contact?.anniversary_month || '');
    write('directoryContactAnniversaryDay', contact?.anniversaryDay || contact?.anniversary_day || '');
    write('directoryContactNotes', contact?.notes || '');

    const newsletterStatus = String(contact?.newsletter?.status || contact?.newsletterStatus || 'not_subscribed');
    write('directoryContactNewsletterStatus', newsletterStatus);
    write('directoryContactConsentSource', contact?.newsletter?.consentSource || contact?.consentSource || '');
    write('directoryContactConsentDate', contact?.newsletter?.consentDate || contact?.consentDate || '');

    setText('directoryContactFormHint', '');
    setError('directoryContactFormError', '');
    setHidden('directoryDuplicateBox', true);
    setText('directoryDuplicateList', '');

    openDialog($('directoryContactDialog'), 'directoryContactFirstName');
  }

  function closeContactFormDialog() {
    closeDialog($('directoryContactDialog'));
  }

  function validateContactFormPayload(payload) {
    const firstName = String(payload.firstName || '').trim();
    const lastName = String(payload.lastName || '').trim();
    const contactType = String(payload.contactType || '').trim().toLowerCase();
    const status = String(payload.status || '').trim().toLowerCase();

    if (!firstName) return 'First name is required.';
    if (!lastName) return 'Last name is required.';
    if (!contactType) return 'Contact type is required.';
    if (!status) return 'Status is required.';

    const newsletterStatus = String(payload.newsletter?.status || 'not_subscribed').trim().toLowerCase();
    if (newsletterStatus === 'subscribed') {
      const email = String(payload.primaryEmail || '').trim().toLowerCase();
      const consentSource = String(payload.newsletter?.consentSource || '').trim();
      const consentDate = String(payload.newsletter?.consentDate || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return 'Subscribed with recorded consent requires a valid primary email.';
      }
      if (!consentSource) return 'Consent source is required for subscribed contacts.';
      if (!consentDate) return 'Consent date is required for subscribed contacts.';
    }

    return '';
  }

  function readContactFormPayload() {
    const get = (id) => String($(id)?.value || '').trim();

    return {
      id: get('directoryContactId'),
      firstName: get('directoryContactFirstName'),
      lastName: get('directoryContactLastName'),
      preferredName: get('directoryContactPreferredName'),
      accountNumber: get('directoryContactAccountNumber'),
      contactType: get('directoryContactType').toLowerCase(),
      status: get('directoryContactStatus').toLowerCase(),
      primaryEmail: get('directoryContactPrimaryEmail').toLowerCase(),
      secondaryEmail: get('directoryContactSecondaryEmail').toLowerCase(),
      mobilePhone: get('directoryContactMobilePhone'),
      homePhone: get('directoryContactHomePhone'),
      preferredContactMethod: get('directoryContactPreferredMethod'),
      membershipStatus: get('directoryContactMembershipStatus'),
      memberSince: get('directoryContactMemberSince'),
      ministry: get('directoryContactMinistry'),
      leadershipRole: get('directoryContactRole'),
      addressLine1: get('directoryContactAddress1'),
      addressLine2: get('directoryContactAddress2'),
      city: get('directoryContactCity'),
      state: get('directoryContactState'),
      postalCode: get('directoryContactPostalCode'),
      birthMonth: get('directoryContactBirthMonth'),
      birthDay: get('directoryContactBirthDay'),
      anniversaryMonth: get('directoryContactAnniversaryMonth'),
      anniversaryDay: get('directoryContactAnniversaryDay'),
      notes: get('directoryContactNotes'),
      newsletter: {
        status: get('directoryContactNewsletterStatus').toLowerCase(),
        consentSource: get('directoryContactConsentSource'),
        consentDate: get('directoryContactConsentDate')
      }
    };
  }

  function buildDuplicateListHtml(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return '';
    return list.map((item) => {
      const reasons = Array.isArray(item?.reasons) ? item.reasons.join(', ') : '';
      return `<div class="row"><div class="row__main"><div class="row__title">${escapeHtml(item.displayName || 'Possible duplicate')}</div><div class="row__meta">${escapeHtml(item.primaryEmail || item.mobilePhone || '')}</div><div class="row__meta">${escapeHtml(reasons)}</div></div></div>`;
    }).join('');
  }

  async function checkDuplicates(payload) {
    try {
      const response = await api('/api/directory/contacts/check-duplicates', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const items = Array.isArray(response?.items) ? response.items : [];
      setHidden('directoryDuplicateBox', items.length === 0);
      setText('directoryDuplicateList', '');
      const list = $('directoryDuplicateList');
      if (list) list.innerHTML = buildDuplicateListHtml(items);
      return items;
    } catch {
      setHidden('directoryDuplicateBox', true);
      return [];
    }
  }

  async function submitContactForm(event) {
    event.preventDefault();
    const payload = readContactFormPayload();
    const validationError = validateContactFormPayload(payload);
    if (validationError) {
      setError('directoryContactFormError', validationError);
      return;
    }

    setError('directoryContactFormError', '');
    setText('directoryContactFormHint', payload.id ? 'Saving contact...' : 'Checking for duplicates...');

    if (!payload.id) {
      const matches = await checkDuplicates(payload);
      if (matches.length) {
        const proceed = typeof window.confirmWrite === 'function'
          ? window.confirmWrite('Possible duplicates were found. Create this contact anyway?')
          : window.confirm('Possible duplicates were found. Create this contact anyway?');
        if (!proceed) {
          setText('directoryContactFormHint', 'Review duplicates before saving.');
          return;
        }
      }
    }

    try {
      if (payload.id) {
        await api(`/api/directory/contacts/${encodeURIComponent(payload.id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        await api('/api/directory/contacts', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      setText('directoryContactFormHint', 'Saved.');
      closeContactFormDialog();
      announce('Contact saved.');
      await Promise.all([loadOverview(), loadContacts(), loadSubscribers(), loadGroupsAndLists()]);
    } catch (error) {
      setError('directoryContactFormError', String(error?.message || 'Unable to save contact.'));
      setText('directoryContactFormHint', '');
    }
  }

  function contactFiltersFromDom() {
    const read = (a, b) => String($(a)?.value || $(b)?.value || '').trim();
    return {
      q: read('directoryContactsSearchDesktop', 'directoryContactsSearch'),
      status: read('directoryContactsStatusDesktop', 'directoryContactsStatus') || 'all',
      type: read('directoryContactsTypeDesktop', 'directoryContactsType') || 'all',
      group: read('directoryContactsGroupDesktop', 'directoryContactsGroup') || 'all',
      newsletter: read('directoryContactsNewsletterDesktop', 'directoryContactsNewsletter') || 'all',
      missing: read('directoryContactsMissingDesktop', 'directoryContactsMissing') || 'all'
    };
  }

  function applyContactFiltersToDom(filters) {
    const write = (id, value) => {
      const el = $(id);
      if (el) el.value = String(value || 'all');
    };

    write('directoryContactsSearchDesktop', filters.q || '');
    write('directoryContactsSearch', filters.q || '');
    write('directoryContactsStatusDesktop', filters.status || 'all');
    write('directoryContactsStatus', filters.status || 'all');
    write('directoryContactsTypeDesktop', filters.type || 'all');
    write('directoryContactsType', filters.type || 'all');
    write('directoryContactsGroupDesktop', filters.group || 'all');
    write('directoryContactsGroup', filters.group || 'all');
    write('directoryContactsNewsletterDesktop', filters.newsletter || 'all');
    write('directoryContactsNewsletter', filters.newsletter || 'all');
    write('directoryContactsMissingDesktop', filters.missing || 'all');
    write('directoryContactsMissing', filters.missing || 'all');
  }

  function subscriberFiltersFromDom() {
    return {
      q: String($('directorySubscribersSearch')?.value || '').trim(),
      status: String($('directorySubscribersStatus')?.value || 'all').trim(),
      source: String($('directorySubscribersSource')?.value || 'all').trim(),
      list: String($('directorySubscribersList')?.value || 'all').trim()
    };
  }

  function renderContacts() {
    const tbody = $('directoryContactsTableBody');
    const cardList = $('directoryContactsCardList');
    if (!tbody || !cardList) return;

    const items = Array.isArray(state.contacts.items) ? state.contacts.items : [];

    tbody.innerHTML = items.map((item) => {
      const name = contactDisplayName(item);
      const pref = preferredLabel(item);
      const email = maybeText(item.primaryEmail, 'Not set');
      const phone = formatPhone(item.mobilePhone || item.homePhone);
      const accountNumber = maybeText(item.accountNumber, 'Not set');
      const newsletter = String(item.newsletterStatus || 'not_subscribed').replace(/_/g, ' ');
      return `
        <tr>
          <td><input type="checkbox" class="checkbox directoryContactSelect" data-contact-id="${escapeHtml(item.id)}" /></td>
          <td>
            <div class="directoryPersonCell">
              <div class="directoryAvatar">${escapeHtml(initialsOf(item))}</div>
              <div class="directoryPersonText">
                <p class="directoryPersonName">${escapeHtml(name)}</p>
                <p class="directoryPersonMeta">${escapeHtml(pref)}</p>
              </div>
            </div>
          </td>
          <td>
            <div class="directoryInfoStack">
              <span>${escapeHtml(accountNumber)}</span>
              <span>${escapeHtml(email)}</span>
              <span class="directoryMuted">${escapeHtml(phone)}</span>
            </div>
          </td>
          <td>${escapeHtml(String(item.contactType || '').replace(/_/g, ' ') || 'Not set')}</td>
          <td>${escapeHtml(maybeText(item.ministry || item.leadershipRole, 'Not set'))}</td>
          <td>${statusChip(newsletter)}</td>
          <td>${statusChip(item.status)}</td>
          <td>${escapeHtml(formatDateTime(item.updatedAt))}</td>
          <td>
            <div class="directoryActionGroup">
              <button class="btn btn--sm" type="button" data-contact-view="${escapeHtml(item.id)}">View</button>
              <button class="btn btn--sm" type="button" data-contact-edit="${escapeHtml(item.id)}">Edit</button>
              <button class="btn btn--sm btn--danger" type="button" data-contact-archive="${escapeHtml(item.id)}">Archive</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    cardList.innerHTML = items.map((item) => {
      const name = contactDisplayName(item);
      const pref = preferredLabel(item);
      const accountNumber = maybeText(item.accountNumber, 'Not set');
      return `
        <article class="directoryCard">
          <div class="directoryPersonCell">
            <div class="directoryAvatar">${escapeHtml(initialsOf(item))}</div>
            <div class="directoryPersonText">
              <p class="directoryPersonName">${escapeHtml(name)}</p>
              <p class="directoryPersonMeta">${escapeHtml(pref)}</p>
            </div>
          </div>
          <div class="directoryInfoStack">
            <span>${escapeHtml(accountNumber)}</span>
            <span>${escapeHtml(maybeText(item.primaryEmail, 'Not set'))}</span>
            <span class="directoryMuted">${escapeHtml(formatPhone(item.mobilePhone || item.homePhone))}</span>
            <span>${statusChip(item.newsletterStatus || 'not_subscribed')} ${statusChip(item.status)}</span>
          </div>
          <div class="directoryActionGroup">
            <button class="btn btn--sm" type="button" data-contact-view="${escapeHtml(item.id)}">View</button>
            <button class="btn btn--sm" type="button" data-contact-edit="${escapeHtml(item.id)}">Edit</button>
            <button class="btn btn--sm btn--danger" type="button" data-contact-archive="${escapeHtml(item.id)}">Archive</button>
          </div>
        </article>
      `;
    }).join('');

    const pageInfo = `Page ${state.contacts.page} of ${Math.max(1, state.contacts.totalPages)}`;
    setText('directoryContactsPageInfo', pageInfo);
    setText('directoryContactsResultCount', `${state.contacts.total} contact${state.contacts.total === 1 ? '' : 's'}`);

    const prevBtn = $('directoryContactsPrevBtn');
    const nextBtn = $('directoryContactsNextBtn');
    if (prevBtn) prevBtn.disabled = state.contacts.page <= 1;
    if (nextBtn) nextBtn.disabled = state.contacts.page >= state.contacts.totalPages;

    setHidden('directoryContactsLoading', !state.contacts.loading);
    setHidden('directoryContactsEmpty', state.contacts.loading || state.contacts.error || state.contacts.total > 0);
    setHidden('directoryContactsError', !state.contacts.error);
    setText('directoryContactsError', state.contacts.error || '');

    if (!state.contacts.loading) {
      announce(`${state.contacts.total} contacts found.`);
    }
  }

  function renderSubscribers() {
    const tbody = $('directorySubscribersTableBody');
    const cards = $('directorySubscribersCardList');
    if (!tbody || !cards) return;

    const items = Array.isArray(state.subscribers.items) ? state.subscribers.items : [];

    tbody.innerHTML = items.map((item) => {
      const lists = Array.isArray(item.listNames) && item.listNames.length ? item.listNames.join(', ') : 'None';
      return `
        <tr>
          <td><input type="checkbox" class="checkbox" data-subscriber-id="${escapeHtml(item.id)}" /></td>
          <td>${escapeHtml(item.email)}${item.displayName ? `<div class="directoryMuted">${escapeHtml(item.displayName)}</div>` : ''}</td>
          <td>${statusChip(item.status)}</td>
          <td>${escapeHtml(maybeText(item.consentSource, 'Not set'))}</td>
          <td>${escapeHtml(lists)}</td>
          <td>${escapeHtml(formatDateOnly(item.consentDate))}</td>
          <td>${escapeHtml(formatDateTime(item.lastEmailedAt))}</td>
          <td>
            <div class="directoryActionGroup">
              <button class="btn btn--sm" type="button" data-subscriber-view="${escapeHtml(item.id)}">View</button>
              <button class="btn btn--sm" type="button" data-subscriber-resend="${escapeHtml(item.id)}">Resend Confirmation</button>
              <button class="btn btn--sm" type="button" data-subscriber-unsubscribe="${escapeHtml(item.id)}">Unsubscribe</button>
              <button class="btn btn--sm" type="button" data-subscriber-add-list="${escapeHtml(item.id)}">Add to List</button>
              <button class="btn btn--sm" type="button" data-subscriber-remove-list="${escapeHtml(item.id)}">Remove from List</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    cards.innerHTML = items.map((item) => {
      const lists = Array.isArray(item.listNames) && item.listNames.length ? item.listNames.join(', ') : 'None';
      return `
        <article class="directoryCard">
          <p class="directoryPersonName">${escapeHtml(item.email)}</p>
          <p class="directoryMuted">${escapeHtml(item.displayName || '')}</p>
          <p>${statusChip(item.status)}</p>
          <p class="directoryMuted">Source: ${escapeHtml(maybeText(item.consentSource, 'Not set'))}</p>
          <p class="directoryMuted">Lists: ${escapeHtml(lists)}</p>
          <div class="directoryActionGroup">
            <button class="btn btn--sm" type="button" data-subscriber-view="${escapeHtml(item.id)}">View</button>
            <button class="btn btn--sm" type="button" data-subscriber-resend="${escapeHtml(item.id)}">Resend Confirmation</button>
            <button class="btn btn--sm" type="button" data-subscriber-unsubscribe="${escapeHtml(item.id)}">Unsubscribe</button>
            <button class="btn btn--sm" type="button" data-subscriber-add-list="${escapeHtml(item.id)}">Add to List</button>
            <button class="btn btn--sm" type="button" data-subscriber-remove-list="${escapeHtml(item.id)}">Remove from List</button>
          </div>
        </article>
      `;
    }).join('');

    setText('directorySubscribersPageInfo', `Page ${state.subscribers.page} of ${Math.max(1, state.subscribers.totalPages)}`);
    setText('directorySubscribersResultCount', `${state.subscribers.total} subscriber${state.subscribers.total === 1 ? '' : 's'}`);

    const prevBtn = $('directorySubscribersPrevBtn');
    const nextBtn = $('directorySubscribersNextBtn');
    if (prevBtn) prevBtn.disabled = state.subscribers.page <= 1;
    if (nextBtn) nextBtn.disabled = state.subscribers.page >= state.subscribers.totalPages;

    setHidden('directorySubscribersLoading', !state.subscribers.loading);
    setHidden('directorySubscribersEmpty', state.subscribers.loading || state.subscribers.error || state.subscribers.total > 0);
    setHidden('directorySubscribersError', !state.subscribers.error);
    setText('directorySubscribersError', state.subscribers.error || '');
  }

  function renderGroupsAndLists() {
    const groupsEl = $('directoryGroupsList');
    const listsEl = $('directoryListsList');
    if (!groupsEl || !listsEl) return;

    groupsEl.innerHTML = (state.groups.groups || []).map((group) => {
      return `
        <div class="row">
          <div class="row__main">
            <div class="row__title">${escapeHtml(group.name)}</div>
            <div class="row__meta">${escapeHtml(maybeText(group.category, 'General'))} | ${escapeHtml(maybeText(group.description, 'No description'))}</div>
            <div class="row__meta">${escapeHtml(String(group.activeMemberCount || 0))} active members</div>
          </div>
          <div class="row__actions">
            ${statusChip(group.status || 'active')}
            <button class="btn btn--sm" type="button" data-group-edit="${escapeHtml(group.id)}">Edit</button>
          </div>
        </div>
      `;
    }).join('');

    listsEl.innerHTML = (state.groups.lists || []).map((list) => {
      return `
        <div class="row">
          <div class="row__main">
            <div class="row__title">${escapeHtml(list.name)}</div>
            <div class="row__meta">${escapeHtml(maybeText(list.description, 'No description'))}</div>
          </div>
          <div class="row__actions">
            ${statusChip(list.status || 'active')}
            <button class="btn btn--sm" type="button" data-list-edit="${escapeHtml(list.id)}">Edit</button>
          </div>
        </div>
      `;
    }).join('');

    setHidden('directoryGroupsEmpty', (state.groups.groups || []).length !== 0);
    setHidden('directoryListsEmpty', (state.groups.lists || []).length !== 0);
  }

  function renderOverview(overview) {
    const summary = overview?.summary || {};
    setText('directorySummaryContacts', Number(summary.activeContacts || 0));
    setText('directorySummarySubscribers', Number(summary.activeSubscribers || 0));
    setText('directorySummaryMissing', Number(summary.missingInfo || 0));
    setText('directorySummaryNew', Number(summary.newContactsThisMonth || 0));

    const permissions = overview?.permissions || {};
    state.permissions = {
      canReadBasic: !!permissions.canReadBasic,
      canReadPrivate: !!permissions.canReadPrivate,
      canManageContacts: !!permissions.canManageContacts,
      canArchiveContacts: !!permissions.canArchiveContacts,
      canManageSubscribers: !!permissions.canManageSubscribers,
      canManageGroups: !!permissions.canManageGroups,
      canImportExport: !!permissions.canImportExport
    };

    const canManageContacts = state.permissions.canManageContacts;
    const canManageSubscribers = state.permissions.canManageSubscribers;
    const canManageGroups = state.permissions.canManageGroups;
    const canImportExport = state.permissions.canImportExport;

    const addBtn = $('directoryAddContactBtn');
    if (addBtn) addBtn.disabled = !canManageContacts;
    const importBtn = $('directoryImportBtn');
    if (importBtn) importBtn.disabled = !canImportExport;
    const exportBtn = $('directoryExportBtn');
    if (exportBtn) exportBtn.disabled = !canImportExport;

    const subscribersTab = $('subTabBtn-directory-subscribers');
    if (subscribersTab) subscribersTab.disabled = !canManageSubscribers && !state.permissions.canReadBasic;

    const groupsTab = $('subTabBtn-directory-groups');
    if (groupsTab) groupsTab.disabled = !canManageGroups && !state.permissions.canReadBasic;
  }

  async function loadOverview() {
    if (state.loadingOverview) return;
    state.loadingOverview = true;
    try {
      const overview = await api('/api/directory/overview', { method: 'GET' });
      renderOverview(overview || {});
    } catch (error) {
      toast(String(error?.message || 'Unable to load directory overview.'), 'danger');
    } finally {
      state.loadingOverview = false;
    }
  }

  function contactsQueryString() {
    const f = state.contacts.filters;
    const q = new URLSearchParams();
    q.set('page', String(state.contacts.page));
    q.set('pageSize', String(state.contacts.pageSize));
    if (f.q) q.set('q', f.q);
    if (f.status && f.status !== 'all') q.set('status', f.status);
    if (f.type && f.type !== 'all') q.set('contactType', f.type);
    if (f.group && f.group !== 'all') q.set('groupId', f.group);
    if (f.newsletter && f.newsletter !== 'all') q.set('newsletterStatus', f.newsletter);
    if (f.missing && f.missing !== 'all') q.set('missing', f.missing);
    return q.toString();
  }

  async function loadContacts() {
    state.contacts.loading = true;
    state.contacts.error = '';
    renderContacts();
    setText('directoryContactsStatusText', 'Loading contacts...');

    try {
      const data = await api(`/api/directory/contacts?${contactsQueryString()}`, { method: 'GET' });
      state.contacts.items = Array.isArray(data?.items) ? data.items : [];
      state.contacts.total = Number(data?.pagination?.total || 0);
      state.contacts.totalPages = Math.max(1, Number(data?.pagination?.totalPages || 1));

      const groups = Array.isArray(data?.filters?.groups)
        ? data.filters.groups.map((item) => ({ value: String(item?.id || ''), label: String(item?.name || '') })).filter((item) => item.value)
        : [];
      const options = [{ value: 'all', label: 'All' }, ...groups];
      syncSelectOptions('directoryContactsGroupDesktop', 'directoryContactsGroup', options);
      syncContactTypeOptions(data?.filters?.types);

      setText('directoryContactsStatusText', 'Contacts loaded.');
    } catch (error) {
      state.contacts.items = [];
      state.contacts.total = 0;
      state.contacts.totalPages = 1;
      state.contacts.error = String(error?.message || 'Unable to load contacts.');
      setText('directoryContactsStatusText', 'Unable to load contacts.');
    } finally {
      state.contacts.loading = false;
      renderContacts();
    }
  }

  function subscribersQueryString() {
    const f = state.subscribers.filters;
    const q = new URLSearchParams();
    q.set('page', String(state.subscribers.page));
    q.set('pageSize', String(state.subscribers.pageSize));
    if (f.q) q.set('q', f.q);
    if (f.status && f.status !== 'all') q.set('status', f.status);
    if (f.source && f.source !== 'all') q.set('source', f.source);
    if (f.list && f.list !== 'all') q.set('listId', f.list);
    return q.toString();
  }

  async function loadSubscribers() {
    state.subscribers.loading = true;
    state.subscribers.error = '';
    renderSubscribers();
    setText('directorySubscribersStatusText', 'Loading subscribers...');

    try {
      const data = await api(`/api/directory/subscribers?${subscribersQueryString()}`, { method: 'GET' });
      state.subscribers.items = Array.isArray(data?.items) ? data.items : [];
      state.subscribers.total = Number(data?.pagination?.total || 0);
      state.subscribers.totalPages = Math.max(1, Number(data?.pagination?.totalPages || 1));

      const counters = data?.counters || {};
      setText('directorySubscribersCountActive', Number(counters.active || 0));
      setText('directorySubscribersCountPending', Number(counters.pending || 0));
      setText('directorySubscribersCountUnsubscribed', Number(counters.unsubscribed || 0));
      setText('directorySubscribersCountSuppressed', Number(counters.suppressedOrBounced || 0));

      const lists = Array.isArray(data?.filters?.lists)
        ? data.filters.lists.map((item) => ({ value: String(item?.id || ''), label: String(item?.name || '') })).filter((item) => item.value)
        : [];
      const options = [{ value: 'all', label: 'All' }, ...lists];
      const select = $('directorySubscribersList');
      if (select instanceof HTMLSelectElement) {
        const current = select.value;
        select.innerHTML = '';
        for (const option of options) {
          const el = document.createElement('option');
          el.value = option.value;
          el.textContent = option.label;
          select.appendChild(el);
        }
        select.value = options.some((item) => item.value === current) ? current : 'all';
      }

      setText('directorySubscribersStatusText', 'Subscribers loaded.');
    } catch (error) {
      state.subscribers.items = [];
      state.subscribers.total = 0;
      state.subscribers.totalPages = 1;
      state.subscribers.error = String(error?.message || 'Unable to load subscribers.');
      setText('directorySubscribersStatusText', 'Unable to load subscribers.');
    } finally {
      state.subscribers.loading = false;
      renderSubscribers();
    }
  }

  async function loadGroupsAndLists() {
    try {
      const [groupsRes, listsRes] = await Promise.all([
        api('/api/directory/groups', { method: 'GET' }),
        api('/api/directory/lists', { method: 'GET' })
      ]);
      state.groups.groups = Array.isArray(groupsRes?.items) ? groupsRes.items : [];
      state.groups.lists = Array.isArray(listsRes?.items) ? listsRes.items : [];
      renderGroupsAndLists();
    } catch {
      state.groups.groups = [];
      state.groups.lists = [];
      renderGroupsAndLists();
    }
  }

  async function openContactDrawer(contactId) {
    const id = String(contactId || '').trim();
    if (!id) return;
    setText('directoryDrawerName', 'Loading...');
    setText('directoryDrawerTypeStatus', 'Loading contact details...');

    const clearList = (idValue) => {
      const el = $(idValue);
      if (el) el.innerHTML = '';
    };

    clearList('directoryDrawerPersonal');
    clearList('directoryDrawerContactInfo');
    clearList('directoryDrawerChurchInfo');
    clearList('directoryDrawerCommPrefs');
    clearList('directoryDrawerRecentActivity');

    openDialog($('directoryContactDrawer'), 'directoryContactDrawerCloseBtn');

    try {
      const data = await api(`/api/directory/contacts/${encodeURIComponent(id)}`, { method: 'GET' });
      const item = data?.item || {};

      setText('directoryDrawerAvatar', initialsOf(item));
      setText('directoryDrawerName', contactDisplayName(item));
      setText('directoryDrawerTypeStatus', `${maybeText(item.contactType, 'Contact')} | ${maybeText(item.status, 'active')}`);

      const dl = (pairs) => pairs.map((pair) => `<dt>${escapeHtml(pair[0])}</dt><dd>${escapeHtml(pair[1])}</dd>`).join('');

      const personal = [
        ['Preferred name', maybeText(item.preferredName, 'Not set')],
        ['Birth month/day', item.birthMonth && item.birthDay ? `${item.birthMonth}/${item.birthDay}` : 'Not set'],
        ['Anniversary month/day', item.anniversaryMonth && item.anniversaryDay ? `${item.anniversaryMonth}/${item.anniversaryDay}` : 'Not set']
      ];

      const contactInfo = [
        ['Primary email', maybeText(item.primaryEmail, 'Not set')],
        ['Secondary email', maybeText(item.secondaryEmail, 'Not set')],
        ['Mobile phone', formatPhone(item.mobilePhone)],
        ['Home phone', formatPhone(item.homePhone)],
        ['Preferred contact method', maybeText(item.preferredContactMethod, 'Not set')],
        ['Address', maybeText(item.address, 'Not set')]
      ];

      const church = [
        ['Account number', maybeText(item.accountNumber, 'Not set')],
        ['Membership status', maybeText(item.membershipStatus, 'Not set')],
        ['Member since', formatDateOnly(item.memberSince)],
        ['Ministry assignments', maybeText(item.ministry, 'Not set')],
        ['Leadership role', maybeText(item.leadershipRole, 'Not set')],
        ['Household', maybeText(item.householdName, 'Not set')],
        ['Internal notes', maybeText(item.notes, 'Not set')]
      ];

      const comms = [
        ['Newsletter status', maybeText(item.newsletter?.status, 'Not subscribed')],
        ['Subscriber email', maybeText(item.newsletter?.email, 'Not set')],
        ['Consent source', maybeText(item.newsletter?.consentSource, 'Not set')],
        ['Consent date', formatDateOnly(item.newsletter?.consentDate)],
        ['Confirmed date', formatDateOnly(item.newsletter?.confirmedAt)],
        ['Unsubscribed date', formatDateOnly(item.newsletter?.unsubscribedAt)]
      ];

      const setDlHtml = (idValue, html) => {
        const el = $(idValue);
        if (el) el.innerHTML = html;
      };

      setDlHtml('directoryDrawerPersonal', dl(personal));
      setDlHtml('directoryDrawerContactInfo', dl(contactInfo));
      setDlHtml('directoryDrawerChurchInfo', dl(church));
      setDlHtml('directoryDrawerCommPrefs', dl(comms));

      const activity = $('directoryDrawerRecentActivity');
      if (activity) {
        const rows = Array.isArray(item.recentActivity) ? item.recentActivity : [];
        activity.innerHTML = rows.length
          ? rows.map((row) => `<div class="row"><div class="row__main"><div class="row__title">${escapeHtml(row.title || 'Update')}</div><div class="row__meta">${escapeHtml(formatDateTime(row.at))}</div></div></div>`).join('')
          : '<div class="muted">No recent changes recorded.</div>';
      }

      state.selectedContactId = id;
    } catch (error) {
      setText('directoryDrawerName', 'Unable to load contact');
      setText('directoryDrawerTypeStatus', String(error?.message || 'Unknown error'));
      state.selectedContactId = '';
    }
  }

  async function archiveContact(contactId) {
    if (!state.permissions.canArchiveContacts) {
      toast('You do not have permission to archive contacts.', 'danger');
      return;
    }

    const ok = typeof window.confirmWrite === 'function'
      ? window.confirmWrite('Archive this contact?')
      : window.confirm('Archive this contact?');
    if (!ok) return;

    try {
      await api(`/api/directory/contacts/${encodeURIComponent(contactId)}`, { method: 'DELETE' });
      announce('Contact archived.');
      await Promise.all([loadOverview(), loadContacts()]);
    } catch (error) {
      toast(String(error?.message || 'Unable to archive contact.'), 'danger');
    }
  }

  async function withSubscriberAction(subscriberId, endpoint, body, messageOnSuccess) {
    if (!state.permissions.canManageSubscribers) {
      toast('You do not have permission to update subscribers.', 'danger');
      return;
    }
    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(body || {})
      });
      announce(messageOnSuccess);
      await loadSubscribers();
    } catch (error) {
      toast(String(error?.message || 'Subscriber update failed.'), 'danger');
    }
  }

  async function updateSubscriberLists(subscriberId, mode) {
    if (!state.permissions.canManageSubscribers) {
      toast('You do not have permission to update subscribers.', 'danger');
      return;
    }

    await ensureListsLoaded();
    const subscriberRes = await api(`/api/directory/subscribers/${encodeURIComponent(subscriberId)}`, { method: 'GET' });
    const item = subscriberRes?.item || {};
    const currentListIds = new Set(Array.isArray(item.listIds) ? item.listIds : []);

    let candidates = state.groups.lists || [];
    if (mode === 'add') {
      candidates = candidates.filter((row) => !currentListIds.has(String(row.id)));
    } else {
      candidates = candidates.filter((row) => currentListIds.has(String(row.id)));
    }

    const choice = pickListByPrompt(candidates, mode === 'add' ? 'Choose a list to add:' : 'Choose a list to remove:');
    if (choice.cancelled) return;
    if (!choice.item) {
      if (choice.error) toast(choice.error, 'info');
      return;
    }

    const selectedId = String(choice.item.id);
    if (mode === 'add') currentListIds.add(selectedId);
    else currentListIds.delete(selectedId);

    await api(`/api/directory/subscribers/${encodeURIComponent(subscriberId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        contactId: item.contactId || null,
        email: item.email || '',
        status: item.status || 'pending',
        consentSource: item.consentSource || '',
        consentDate: item.consentDate || '',
        suppressionReason: item.suppressionReason || '',
        listIds: Array.from(currentListIds)
      })
    });

    toast(mode === 'add' ? 'Subscriber added to list.' : 'Subscriber removed from list.', 'success');
    await loadSubscribers();
    await loadGroupsAndLists();
  }

  async function promptAndSaveGroup(existingGroup) {
    if (!state.permissions.canManageGroups) {
      toast('You do not have permission to manage groups.', 'danger');
      return;
    }

    const isEdit = Boolean(existingGroup?.id);
    const name = promptText('Directory group name:', existingGroup?.name || '');
    if (name === null) return;
    if (!name) {
      toast('Group name is required.', 'danger');
      return;
    }

    const category = promptText('Group category:', existingGroup?.category || 'ministry');
    if (category === null) return;
    const description = promptText('Group description (optional):', existingGroup?.description || '');
    if (description === null) return;
    const status = promptText('Group status (active, inactive, archived):', existingGroup?.status || 'active');
    if (status === null) return;

    const payload = {
      name,
      category: category || 'ministry',
      description: description || '',
      status: (status || 'active').toLowerCase()
    };

    if (isEdit) {
      await api(`/api/directory/groups/${encodeURIComponent(existingGroup.id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      toast('Directory group updated.', 'success');
    } else {
      await api('/api/directory/groups', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      toast('Directory group created.', 'success');
    }

    await loadGroupsAndLists();
    await loadContacts();
  }

  async function promptAndSaveList(existingList) {
    if (!state.permissions.canManageGroups) {
      toast('You do not have permission to manage lists.', 'danger');
      return;
    }

    const isEdit = Boolean(existingList?.id);
    const name = promptText('Email list name:', existingList?.name || '');
    if (name === null) return;
    if (!name) {
      toast('List name is required.', 'danger');
      return;
    }

    const description = promptText('Email list description (optional):', existingList?.description || '');
    if (description === null) return;
    const status = promptText('List status (active, inactive, archived):', existingList?.status || 'active');
    if (status === null) return;

    const payload = {
      name,
      description: description || '',
      status: (status || 'active').toLowerCase()
    };

    if (isEdit) {
      await api(`/api/directory/lists/${encodeURIComponent(existingList.id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      toast('Email list updated.', 'success');
    } else {
      await api('/api/directory/lists', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      toast('Email list created.', 'success');
    }

    await loadGroupsAndLists();
    await loadSubscribers();
  }

  async function runDirectoryExport() {
    try {
      const selectedScope = document.querySelector('input[name="scope"]:checked');
      const scope = String(selectedScope?.value || 'all_contacts');
      let rows = [];
      let filename = `directory-${slugifyFilenamePart(scope, 'export')}-${new Date().toISOString().slice(0, 10)}.csv`;
      let content = '';

      if (scope === 'subscribers_only') {
        rows = await fetchAllSubscribers(state.subscribers.filters);
        content = csvFromSubscribers(rows);
      } else if (scope === 'selected_contacts') {
        const selectedIds = Array.from(document.querySelectorAll('.directoryContactSelect:checked'))
          .map((el) => String(el.getAttribute('data-contact-id') || '').trim())
          .filter(Boolean);
        if (!selectedIds.length) {
          setText('directoryExportHint', 'Select at least one contact before exporting selected contacts.');
          return;
        }
        const map = new Map((state.contacts.items || []).map((item) => [String(item.id), item]));
        rows = selectedIds.map((id) => map.get(id)).filter(Boolean);
        content = csvFromContacts(rows);
      } else if (scope === 'filtered_contacts') {
        rows = await fetchAllContacts(state.contacts.filters);
        content = csvFromContacts(rows);
      } else {
        rows = await fetchAllContacts({
          q: '', status: 'all', type: 'all', group: 'all', newsletter: 'all', missing: 'all'
        });
        content = csvFromContacts(rows);
      }

      triggerFileDownload(filename, content, 'text/csv;charset=utf-8');
      setText('directoryExportHint', `Exported ${rows.length} record(s).`);
      toast(`Exported ${rows.length} record(s).`, 'success');
    } catch (error) {
      setText('directoryExportHint', String(error?.message || 'Export failed.'));
      toast(String(error?.message || 'Export failed.'), 'danger');
    }
  }

  async function runDirectoryImportFromFile(file) {
    if (!state.permissions.canManageContacts) {
      setText('directoryImportHint', 'You do not have permission to import contacts.');
      return;
    }
    if (!file) {
      setText('directoryImportHint', 'Choose a CSV file to import.');
      return;
    }

    const name = String(file.name || '').toLowerCase();
    if (!name.endsWith('.csv')) {
      setText('directoryImportHint', 'Only CSV imports are currently supported.');
      return;
    }

    const text = await file.text();
    const matrix = parseCsv(text);
    if (matrix.length < 2) {
      setText('directoryImportHint', 'No data rows found in the file.');
      return;
    }

    const headers = (matrix[0] || []).map((h) => normalizeHeaderKey(h));
    const dataRows = matrix.slice(1);
    const limit = 500;
    const targetRows = dataRows.slice(0, limit);
    const results = { created: 0, skipped: 0, failed: 0, duplicate: 0 };

    for (const dataRow of targetRows) {
      const rowObj = {};
      headers.forEach((h, i) => {
        if (!h) return;
        rowObj[h] = String(dataRow[i] || '').trim();
      });

      const payload = mapImportRowToContactPayload(rowObj);
      if (!payload.firstName || !payload.lastName) {
        results.skipped += 1;
        continue;
      }

      try {
        const dup = await api('/api/directory/contacts/duplicate-check', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        const duplicates = Array.isArray(dup?.items) ? dup.items : [];
        if (duplicates.length) {
          results.duplicate += 1;
          continue;
        }

        await api('/api/directory/contacts', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        results.created += 1;
      } catch {
        results.failed += 1;
      }
    }

    const summary = `Import finished. Created ${results.created}, duplicates ${results.duplicate}, skipped ${results.skipped}, failed ${results.failed}.`;
    setText('directoryImportHint', summary);
    toast(summary, results.failed ? 'warning' : 'success');
    await Promise.all([loadOverview(), loadContacts(), loadSubscribers(), loadGroupsAndLists()]);
  }

  function bindContactsEvents() {
    const debouncedSearch = debounce(() => {
      state.contacts.page = 1;
      state.contacts.filters = contactFiltersFromDom();
      loadContacts();
    }, SEARCH_DEBOUNCE_MS);

    const immediateFilter = () => {
      state.contacts.page = 1;
      state.contacts.filters = contactFiltersFromDom();
      applyContactFiltersToDom(state.contacts.filters);
      loadContacts();
    };

    const searchIds = ['directoryContactsSearchDesktop', 'directoryContactsSearch'];
    for (const id of searchIds) {
      const el = $(id);
      if (el) el.addEventListener('input', debouncedSearch);
    }

    const filterIds = [
      'directoryContactsStatusDesktop',
      'directoryContactsStatus',
      'directoryContactsTypeDesktop',
      'directoryContactsType',
      'directoryContactsGroupDesktop',
      'directoryContactsGroup',
      'directoryContactsNewsletterDesktop',
      'directoryContactsNewsletter',
      'directoryContactsMissingDesktop',
      'directoryContactsMissing'
    ];

    for (const id of filterIds) {
      const el = $(id);
      if (el) el.addEventListener('change', immediateFilter);
    }

    const clear = () => {
      state.contacts.filters = {
        q: '',
        status: 'all',
        type: 'all',
        group: 'all',
        newsletter: 'all',
        missing: 'all'
      };
      state.contacts.page = 1;
      applyContactFiltersToDom(state.contacts.filters);
      loadContacts();
    };

    const clearIds = ['directoryContactsClearFiltersBtn', 'directoryContactsClearFiltersBtnDesktop'];
    for (const id of clearIds) {
      const el = $(id);
      if (el) el.addEventListener('click', clear);
    }

    const prev = $('directoryContactsPrevBtn');
    if (prev) {
      prev.addEventListener('click', () => {
        state.contacts.page = Math.max(1, state.contacts.page - 1);
        loadContacts();
      });
    }

    const next = $('directoryContactsNextBtn');
    if (next) {
      next.addEventListener('click', () => {
        state.contacts.page = Math.min(state.contacts.totalPages, state.contacts.page + 1);
        loadContacts();
      });
    }

    const tableWrap = $('directoryContactsTableWrap');
    const cardWrap = $('directoryContactsCardList');

    wireActionButtons(tableWrap, '[data-contact-view]', (target) => {
      openContactDrawer(target.getAttribute('data-contact-view'));
    });
    wireActionButtons(cardWrap, '[data-contact-view]', (target) => {
      openContactDrawer(target.getAttribute('data-contact-view'));
    });

    wireActionButtons(tableWrap, '[data-contact-edit]', async (target) => {
      const id = String(target.getAttribute('data-contact-edit') || '').trim();
      if (!id) return;
      try {
        const res = await api(`/api/directory/contacts/${encodeURIComponent(id)}`, { method: 'GET' });
        openContactFormDialog(res?.item || {});
      } catch (error) {
        toast(String(error?.message || 'Unable to load contact.'), 'danger');
      }
    });
    wireActionButtons(cardWrap, '[data-contact-edit]', async (target) => {
      const id = String(target.getAttribute('data-contact-edit') || '').trim();
      if (!id) return;
      try {
        const res = await api(`/api/directory/contacts/${encodeURIComponent(id)}`, { method: 'GET' });
        openContactFormDialog(res?.item || {});
      } catch (error) {
        toast(String(error?.message || 'Unable to load contact.'), 'danger');
      }
    });

    wireActionButtons(tableWrap, '[data-contact-archive]', (target) => {
      archiveContact(target.getAttribute('data-contact-archive'));
    });
    wireActionButtons(cardWrap, '[data-contact-archive]', (target) => {
      archiveContact(target.getAttribute('data-contact-archive'));
    });
  }

  function bindSubscribersEvents() {
    const debounced = debounce(() => {
      state.subscribers.page = 1;
      state.subscribers.filters = subscriberFiltersFromDom();
      loadSubscribers();
    }, SEARCH_DEBOUNCE_MS);

    const search = $('directorySubscribersSearch');
    if (search) search.addEventListener('input', debounced);

    for (const id of ['directorySubscribersStatus', 'directorySubscribersSource', 'directorySubscribersList']) {
      const el = $(id);
      if (el) {
        el.addEventListener('change', () => {
          state.subscribers.page = 1;
          state.subscribers.filters = subscriberFiltersFromDom();
          loadSubscribers();
        });
      }
    }

    const clear = $('directorySubscribersClearFiltersBtn');
    if (clear) {
      clear.addEventListener('click', () => {
        state.subscribers.filters = { q: '', status: 'all', source: 'all', list: 'all' };
        state.subscribers.page = 1;
        const ids = ['directorySubscribersSearch', 'directorySubscribersStatus', 'directorySubscribersSource', 'directorySubscribersList'];
        for (const id of ids) {
          const el = $(id);
          if (!el) continue;
          el.value = id === 'directorySubscribersSearch' ? '' : 'all';
        }
        loadSubscribers();
      });
    }

    const prev = $('directorySubscribersPrevBtn');
    if (prev) {
      prev.addEventListener('click', () => {
        state.subscribers.page = Math.max(1, state.subscribers.page - 1);
        loadSubscribers();
      });
    }

    const next = $('directorySubscribersNextBtn');
    if (next) {
      next.addEventListener('click', () => {
        state.subscribers.page = Math.min(state.subscribers.totalPages, state.subscribers.page + 1);
        loadSubscribers();
      });
    }

    const table = $('directorySubscribersTableBody');
    const cards = $('directorySubscribersCardList');

    wireActionButtons(table, '[data-subscriber-view]', async (target) => {
      const id = String(target.getAttribute('data-subscriber-view') || '').trim();
      if (!id) return;
      try {
        const res = await api(`/api/directory/subscribers/${encodeURIComponent(id)}`, { method: 'GET' });
        const contactId = String(res?.item?.contactId || '').trim();
        if (contactId) {
          openContactDrawer(contactId);
        } else {
          toast('This subscriber is not linked to a directory contact yet.', 'info');
        }
      } catch (error) {
        toast(String(error?.message || 'Unable to load subscriber details.'), 'danger');
      }
    });
    wireActionButtons(cards, '[data-subscriber-view]', async (target) => {
      const id = String(target.getAttribute('data-subscriber-view') || '').trim();
      if (!id) return;
      try {
        const res = await api(`/api/directory/subscribers/${encodeURIComponent(id)}`, { method: 'GET' });
        const contactId = String(res?.item?.contactId || '').trim();
        if (contactId) openContactDrawer(contactId);
        else toast('This subscriber is not linked to a directory contact yet.', 'info');
      } catch (error) {
        toast(String(error?.message || 'Unable to load subscriber details.'), 'danger');
      }
    });

    const resendAction = (target) => {
      const id = String(target.getAttribute('data-subscriber-resend') || '').trim();
      if (!id) return;
      withSubscriberAction(id, `/api/directory/subscribers/${encodeURIComponent(id)}/resend-confirmation`, {}, 'Confirmation resent.');
    };

    wireActionButtons(table, '[data-subscriber-resend]', resendAction);
    wireActionButtons(cards, '[data-subscriber-resend]', resendAction);

    const unsubscribeAction = (target) => {
      const id = String(target.getAttribute('data-subscriber-unsubscribe') || '').trim();
      if (!id) return;
      const ok = typeof window.confirmWrite === 'function'
        ? window.confirmWrite('Unsubscribe this record?')
        : window.confirm('Unsubscribe this record?');
      if (!ok) return;
      withSubscriberAction(id, `/api/directory/subscribers/${encodeURIComponent(id)}/unsubscribe`, {}, 'Subscriber unsubscribed.');
    };

    wireActionButtons(table, '[data-subscriber-unsubscribe]', unsubscribeAction);
    wireActionButtons(cards, '[data-subscriber-unsubscribe]', unsubscribeAction);

    wireActionButtons(table, '[data-subscriber-add-list]', (target) => {
      const id = String(target.getAttribute('data-subscriber-add-list') || '').trim();
      if (!id) return;
      updateSubscriberLists(id, 'add').catch((error) => {
        toast(String(error?.message || 'Unable to add subscriber to list.'), 'danger');
      });
    });
    wireActionButtons(table, '[data-subscriber-remove-list]', (target) => {
      const id = String(target.getAttribute('data-subscriber-remove-list') || '').trim();
      if (!id) return;
      updateSubscriberLists(id, 'remove').catch((error) => {
        toast(String(error?.message || 'Unable to remove subscriber from list.'), 'danger');
      });
    });
    wireActionButtons(cards, '[data-subscriber-add-list]', (target) => {
      const id = String(target.getAttribute('data-subscriber-add-list') || '').trim();
      if (!id) return;
      updateSubscriberLists(id, 'add').catch((error) => {
        toast(String(error?.message || 'Unable to add subscriber to list.'), 'danger');
      });
    });
    wireActionButtons(cards, '[data-subscriber-remove-list]', (target) => {
      const id = String(target.getAttribute('data-subscriber-remove-list') || '').trim();
      if (!id) return;
      updateSubscriberLists(id, 'remove').catch((error) => {
        toast(String(error?.message || 'Unable to remove subscriber from list.'), 'danger');
      });
    });
  }

  function bindGroupsEvents() {
    const addGroup = $('directoryAddGroupBtn');
    if (addGroup) {
      addGroup.addEventListener('click', () => {
        promptAndSaveGroup(null).catch((error) => {
          toast(String(error?.message || 'Unable to create group.'), 'danger');
        });
      });
    }
    const addList = $('directoryAddListBtn');
    if (addList) {
      addList.addEventListener('click', () => {
        promptAndSaveList(null).catch((error) => {
          toast(String(error?.message || 'Unable to create list.'), 'danger');
        });
      });
    }

    wireActionButtons($('directoryGroupsList'), '[data-group-edit]', (target) => {
      const id = String(target.getAttribute('data-group-edit') || '').trim();
      const group = (state.groups.groups || []).find((item) => String(item.id) === id);
      if (!group) return;
      promptAndSaveGroup(group).catch((error) => {
        toast(String(error?.message || 'Unable to update group.'), 'danger');
      });
    });
    wireActionButtons($('directoryListsList'), '[data-list-edit]', (target) => {
      const id = String(target.getAttribute('data-list-edit') || '').trim();
      const list = (state.groups.lists || []).find((item) => String(item.id) === id);
      if (!list) return;
      promptAndSaveList(list).catch((error) => {
        toast(String(error?.message || 'Unable to update list.'), 'danger');
      });
    });
  }

  function bindDialogs() {
    const importDialog = $('directoryImportDialog');
    const exportDialog = $('directoryExportDialog');
    const drawer = $('directoryContactDrawer');
    const contactDialog = $('directoryContactDialog');

    if ($('directoryImportBtn')) {
      $('directoryImportBtn').addEventListener('click', openImportDialog);
    }
    if ($('directoryExportBtn')) {
      $('directoryExportBtn').addEventListener('click', openExportDialog);
    }
    if ($('directoryAddContactBtn')) {
      $('directoryAddContactBtn').addEventListener('click', () => openContactFormDialog(null));
    }

    if ($('directoryImportCloseBtn')) {
      $('directoryImportCloseBtn').addEventListener('click', () => closeDialog(importDialog));
    }
    if ($('directoryExportCloseBtn')) {
      $('directoryExportCloseBtn').addEventListener('click', () => closeDialog(exportDialog));
    }
    if ($('directoryContactDrawerCloseBtn')) {
      $('directoryContactDrawerCloseBtn').addEventListener('click', () => closeDialog(drawer));
    }
    if ($('directoryContactDialogCloseBtn')) {
      $('directoryContactDialogCloseBtn').addEventListener('click', closeContactFormDialog);
    }
    if ($('directoryContactCancelBtn')) {
      $('directoryContactCancelBtn').addEventListener('click', closeContactFormDialog);
    }
    if ($('directoryDrawerEditBtn')) {
      $('directoryDrawerEditBtn').addEventListener('click', async () => {
        const id = String(state.selectedContactId || '').trim();
        if (!id) return;
        try {
          const res = await api(`/api/directory/contacts/${encodeURIComponent(id)}`, { method: 'GET' });
          openContactFormDialog(res?.item || {});
        } catch (error) {
          toast(String(error?.message || 'Unable to load contact for edit.'), 'danger');
        }
      });
    }

    if ($('directoryExportGenerateBtn')) {
      $('directoryExportGenerateBtn').addEventListener('click', () => {
        runDirectoryExport().catch((error) => {
          setText('directoryExportHint', String(error?.message || 'Export failed.'));
        });
      });
    }
    if ($('directoryImportFile')) {
      $('directoryImportFile').addEventListener('change', (event) => {
        const input = event.target;
        const file = input && input.files && input.files[0] ? input.files[0] : null;
        runDirectoryImportFromFile(file).catch((error) => {
          setText('directoryImportHint', String(error?.message || 'Import failed.'));
        });
      });
    }

    if ($('directoryContactForm')) {
      $('directoryContactForm').addEventListener('submit', submitContactForm);
    }

    wireDialogDismiss(importDialog, () => closeDialog(importDialog));
    wireDialogDismiss(exportDialog, () => closeDialog(exportDialog));
    wireDialogDismiss(drawer, () => closeDialog(drawer));
    wireDialogDismiss(contactDialog, closeContactFormDialog);
  }

  function bindDirectorySubTabs() {
    const map = [
      ['subTabBtn-directory-contacts', 'panel-directory-contacts'],
      ['subTabBtn-directory-subscribers', 'panel-directory-subscribers'],
      ['subTabBtn-directory-groups', 'panel-directory-groups']
    ];

    for (const [buttonId, panelId] of map) {
      const btn = $(buttonId);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        saveSubTab(panelId);
        refreshActiveSubTab();
      });
    }
  }

  async function refreshActiveSubTab() {
    const panel = activeDirectorySubTab();
    if (panel === 'panel-directory-contacts') {
      await loadContacts();
      return;
    }
    if (panel === 'panel-directory-subscribers') {
      await loadSubscribers();
      return;
    }
    if (panel === 'panel-directory-groups') {
      await loadGroupsAndLists();
    }
  }

  async function onDirectoryActivated(detail) {
    const subTabId = String(detail?.subTabId || '').trim() || restoreSubTab();
    if (typeof window.setDirectorySubTab === 'function') {
      window.setDirectorySubTab(subTabId);
    }
    saveSubTab(activeDirectorySubTab());
    await loadOverview();
    await refreshActiveSubTab();
  }

  function bindSectionActivation() {
    window.addEventListener('admin:section-activated', (event) => {
      const sectionId = String(event?.detail?.sectionId || '').trim();
      if (sectionId !== 'tab-directory') return;
      onDirectoryActivated(event?.detail || {}).catch(() => {});
    });
  }

  function bindRootButtons() {
    const toContacts = () => {
      if (typeof window.activateMainSection === 'function') {
        window.activateMainSection('tab-directory', { subTabId: 'panel-directory-contacts' });
      }
    };
    if ($('directoryContactsFiltersToggle')) {
      $('directoryContactsFiltersToggle').addEventListener('click', () => {
        setTimeout(() => {
          const panel = $('directoryContactsFiltersDrawer');
          if (!(panel instanceof HTMLDetailsElement)) return;
          $('directoryContactsFiltersToggle').setAttribute('aria-expanded', panel.open ? 'true' : 'false');
        }, 0);
      });
    }

    const hash = String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
    if (hash === 'directory') {
      toContacts();
    }
  }

  async function boot() {
    if (state.booted) return;
    if (!$('tab-directory')) return;

    state.booted = true;
    bindDirectorySubTabs();
    bindContactsEvents();
    bindSubscribersEvents();
    bindGroupsEvents();
    bindDialogs();
    bindSectionActivation();
    bindRootButtons();

    const savedSub = restoreSubTab();
    if (typeof window.setDirectorySubTab === 'function') {
      window.setDirectorySubTab(savedSub);
    }

    const tab = $('tab-directory');
    if (tab && !tab.hidden) {
      await onDirectoryActivated({ sectionId: 'tab-directory', subTabId: savedSub });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch(() => {});
  });

  window.AdminDirectory = {
    refresh: async () => {
      await loadOverview();
      await refreshActiveSubTab();
    }
  };
})();
