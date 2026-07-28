// Full-screen visual website editor.
//
// Loaded as a plain <script> after admin.js (shares the same global scope), so it
// reuses admin.js's `api()` helper (CSRF-aware fetch wrapper), `$()`, `escapeHtml()`,
// `escapeAttr()`, `validateUploadFiles()`, `SITE_IMAGE_UPLOAD_MAX_BYTES`,
// `IMAGE_UPLOAD_MIME_TYPES`, and `sitePreviewPageMap`.
//
// Public entry point: window.SiteEditor.open(pageKey)
//
// Talks to the public page rendered inside #siteEditorFrame via the postMessage
// protocol implemented in site-content-loader.js:
//   iframe -> parent: ready | fieldClick | navigateBlocked | error
//   parent -> iframe: init | refresh | setField
//
// See SITE_EDITOR.md for the full architecture write-up.
(function () {
  'use strict';

  const CMS_SOURCE = 'mmmbc-cms';
  const AUTOSAVE_DEBOUNCE_MS = 1500;
  const AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const GROUP_LABELS = {
    staff: 'Staff',
    deacons: 'Deacons',
    deaconesses: 'Deaconesses',
    official_team: 'Official Team & Trustees'
  };

  let currentPage = null;
  let pageLabel = '';
  let fieldSchemas = {};
  let draftFields = {};
  let draftVersion = 0;
  let publishedVersion = 0;
  let dirty = false;
  let saving = false;
  let publishing = false;
  let frameReady = false;
  let lastFocusedBeforePopover = null;
  let autosaveDebounceTimer = null;
  let autosaveIntervalTimer = null;
  let popoverMode = null; // { kind: 'field', field } | { kind: 'collection', field }

  function el(id) { return document.getElementById(id); }

  function pageUrlFor(pageKey) {
    const cfg = (typeof sitePreviewPageMap === 'object' && sitePreviewPageMap[pageKey]) || null;
    return cfg ? cfg.url : '/';
  }

  function pageLabelFor(pageKey) {
    const cfg = (typeof sitePreviewPageMap === 'object' && sitePreviewPageMap[pageKey]) || null;
    return cfg ? cfg.label : pageKey;
  }

  // ---------------------------------------------------------------------
  // Overlay open / close
  // ---------------------------------------------------------------------
  function renderTabs() {
    const container = el('siteEditorOverlayTabs');
    if (!container) return;
    container.innerHTML = '';
    for (const key of Object.keys(sitePreviewPageMap || {})) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', key === currentPage ? 'true' : 'false');
      btn.setAttribute('data-site-page', key);
      btn.textContent = pageLabelFor(key);
      btn.addEventListener('click', () => {
        if (key === currentPage) return;
        switchPage(key);
      });
      container.appendChild(btn);
    }
  }

  // Roving-tabindex-style arrow key navigation across the overlay's page tabs
  // (matches the ARIA tabs keyboard pattern: Left/Right/Home/End).
  document.addEventListener('keydown', (e) => {
    const container = el('siteEditorOverlayTabs');
    if (!container || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (!container.contains(document.activeElement)) return;
    const tabs = Array.from(container.querySelectorAll('[data-site-page]'));
    const current = tabs.findIndex((t) => t === document.activeElement);
    if (current === -1) return;
    let nextIndex = current;
    if (e.key === 'ArrowRight') nextIndex = (current + 1) % tabs.length;
    if (e.key === 'ArrowLeft') nextIndex = (current - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = tabs.length - 1;
    e.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    next.focus();
    const key = next.getAttribute('data-site-page');
    if (key && key !== currentPage) switchPage(key);
  });

  function setStatus(text) {
    const status = el('siteEditorOverlayStatus');
    if (status) status.textContent = text;
  }

  function setLoading(isLoading) {
    const loading = el('siteEditorOverlayLoading');
    if (loading) loading.hidden = !isLoading;
  }

  async function open(pageKey) {
    const key = String(pageKey || '').trim().toLowerCase();
    if (!sitePreviewPageMap || !sitePreviewPageMap[key]) return;
    const overlay = el('siteEditorOverlay');
    if (!overlay) return;

    overlay.hidden = false;
    document.body.classList.add('siteEditorOverlayOpen');
    closePopover();
    await switchPage(key, { first: true });
  }

  function requestClose() {
    if (dirty) {
      openExitDialog();
      return;
    }
    closeOverlay();
  }

  function closeOverlay() {
    stopAutosaveTimers();
    closePopover();
    const overlay = el('siteEditorOverlay');
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('siteEditorOverlayOpen');
    const frame = el('siteEditorFrame');
    if (frame) frame.removeAttribute('src');
    currentPage = null;
    dirty = false;
    frameReady = false;
  }

  async function switchPage(pageKey, { first = false } = {}) {
    if (dirty && !first) {
      const proceed = window.confirm('You have unsaved changes on this page. Switch pages anyway? Unsaved edits from the last few seconds may be lost.');
      if (!proceed) return;
    }
    stopAutosaveTimers();
    closePopover();
    currentPage = pageKey;
    frameReady = false;
    dirty = false;
    renderTabs();
    const titleEl = el('siteEditorOverlayTitle');
    if (titleEl) titleEl.textContent = `Edit ${pageLabelFor(pageKey)}`;
    setStatus('Loading…');
    setLoading(true);

    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(pageKey)}`, { method: 'GET' });
      pageLabel = data.label || pageLabelFor(pageKey);
      fieldSchemas = data.fields || {};
      draftFields = (data.draft && data.draft.fields) || {};
      draftVersion = (data.draft && data.draft.version) || 1;
      publishedVersion = (data.published && data.published.version) || 1;
      if (titleEl) titleEl.textContent = `Edit ${pageLabel}`;
      renderCollectionButton();
      loadFrame(pageKey);
      setStatus('Saved');
      startAutosaveInterval();
    } catch (err) {
      setLoading(false);
      setStatus('Failed to load');
      window.alert(err && err.message ? err.message : 'Could not load this page for editing.');
    }
  }

  function loadFrame(pageKey) {
    const frame = el('siteEditorFrame');
    if (!frame) return;
    const base = pageUrlFor(pageKey);
    const sep = base.includes('?') ? '&' : '?';
    frame.src = `${base}${sep}cms_edit=1&_e=${Date.now()}`;
  }

  // ---------------------------------------------------------------------
  // "Manage list" entry point for collection fields (profiles), since collection
  // items in the rendered page are not individually clickable — the loader only
  // renders them from a template with no top-level data-cms-field target.
  // ---------------------------------------------------------------------
  function collectionFieldKey() {
    for (const [key, schema] of Object.entries(fieldSchemas)) {
      if (schema && schema.type === 'collection') return key;
    }
    return null;
  }

  function renderCollectionButton() {
    const actions = document.querySelector('.siteEditorOverlay__actions');
    if (!actions) return;
    let btn = el('siteEditorManageListBtn');
    const key = collectionFieldKey();
    if (!key) {
      if (btn) btn.hidden = true;
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.id = 'siteEditorManageListBtn';
      btn.addEventListener('click', () => openCollectionManager(collectionFieldKey()));
      actions.insertBefore(btn, el('siteEditorSaveBtn'));
    }
    btn.hidden = false;
    btn.textContent = `Manage ${fieldSchemas[key].label || 'List'}`;
  }

  // ---------------------------------------------------------------------
  // postMessage bridge with the iframe
  // ---------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== CMS_SOURCE) return;
    if (data.page !== currentPage) return;

    if (data.type === 'ready') {
      frameReady = true;
      setLoading(false);
      postToFrame({ type: 'init', fields: draftFields });
    } else if (data.type === 'fieldClick') {
      openFieldPopover(data.field, data.fieldType, data.rect);
    } else if (data.type === 'navigateBlocked') {
      // Intentionally ignored: editing surface must never navigate away.
    } else if (data.type === 'error') {
      setStatus('Preview error');
    }
  });

  function postToFrame(message) {
    const frame = el('siteEditorFrame');
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(Object.assign({ source: CMS_SOURCE, page: currentPage }, message), window.location.origin);
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------------
  // Field value commit + autosave
  // ---------------------------------------------------------------------
  function commitFieldValue(fieldKey, value) {
    draftFields[fieldKey] = value;
    dirty = true;
    setStatus('Unsaved changes');
    if (frameReady) postToFrame({ type: 'setField', field: fieldKey, value });
    scheduleAutosave();
  }

  function scheduleAutosave() {
    if (autosaveDebounceTimer) window.clearTimeout(autosaveDebounceTimer);
    autosaveDebounceTimer = window.setTimeout(() => {
      saveDraft({ silent: true });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function startAutosaveInterval() {
    stopAutosaveTimers(true);
    autosaveIntervalTimer = window.setInterval(() => {
      if (dirty && !saving) saveDraft({ silent: true });
    }, AUTOSAVE_INTERVAL_MS);
  }

  function stopAutosaveTimers(keepInterval) {
    if (autosaveDebounceTimer) {
      window.clearTimeout(autosaveDebounceTimer);
      autosaveDebounceTimer = null;
    }
    if (!keepInterval && autosaveIntervalTimer) {
      window.clearInterval(autosaveIntervalTimer);
      autosaveIntervalTimer = null;
    }
  }

  async function saveDraft({ silent = false } = {}) {
    if (!currentPage || saving) return true;
    saving = true;
    if (!silent) setStatus('Saving…');
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ baseVersion: draftVersion, fields: draftFields })
      });
      draftFields = (data.draft && data.draft.fields) || draftFields;
      draftVersion = (data.draft && data.draft.version) || draftVersion;
      dirty = false;
      setStatus('Saved');
      return true;
    } catch (err) {
      if (err && err.status === 409) {
        setStatus('Reloading latest draft…');
        await reloadAfterConflict();
        setStatus('Reloaded — please redo your last change.');
        return false;
      }
      setStatus('Save failed');
      if (!silent) window.alert(err && err.message ? err.message : 'Could not save this page.');
      return false;
    } finally {
      saving = false;
    }
  }

  async function reloadAfterConflict() {
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}`, { method: 'GET' });
      draftFields = (data.draft && data.draft.fields) || {};
      draftVersion = (data.draft && data.draft.version) || draftVersion;
      publishedVersion = (data.published && data.published.version) || publishedVersion;
      dirty = false;
      if (frameReady) postToFrame({ type: 'refresh', fields: draftFields });
    } catch {
      // keep current in-memory state; user can retry manually
    }
  }

  async function publishDraft() {
    if (!currentPage || publishing) return;
    publishing = true;
    setStatus('Publishing…');
    try {
      if (dirty) {
        const saved = await saveDraft({ silent: true });
        if (!saved) { publishing = false; return; }
      }
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ baseVersion: draftVersion })
      });
      publishedVersion = (data.published && data.published.version) || publishedVersion;
      setStatus('Published');
    } catch (err) {
      if (err && err.status === 409) {
        setStatus('Reloading latest draft…');
        await reloadAfterConflict();
        setStatus('Reloaded — please review and try Update again.');
      } else {
        setStatus('Publish failed');
        window.alert(err && err.message ? err.message : 'This page could not be published. Check the fields and try again.');
      }
    } finally {
      publishing = false;
    }
  }

  // ---------------------------------------------------------------------
  // Exit confirmation dialog
  // ---------------------------------------------------------------------
  function openExitDialog() {
    const dialog = el('siteEditorExitDialog');
    if (!(dialog instanceof HTMLDialogElement)) {
      closeOverlay();
      return;
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeExitDialog() {
    const dialog = el('siteEditorExitDialog');
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  }

  // ---------------------------------------------------------------------
  // Contextual popover: per-field-type editing controls
  // ---------------------------------------------------------------------
  function positionPopover(rect) {
    const popover = el('siteEditorPopover');
    if (!popover) return;
    if (window.matchMedia && window.matchMedia('(max-width:640px)').matches) return; // CSS pins it as a bottom sheet
    const headerHeight = (document.querySelector('.siteEditorOverlay__header') || {}).offsetHeight || 64;
    const margin = 12;
    const width = popover.offsetWidth || 360;
    let top = (rect ? rect.top : 0) + headerHeight + margin;
    let left = (rect ? rect.left : 0) + margin;
    const maxLeft = window.innerWidth - width - margin;
    const maxTop = window.innerHeight - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);
    if (left < margin) left = margin;
    if (top > maxTop - 100) top = Math.max(headerHeight + margin, maxTop - 300);
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function openPopoverShell(title) {
    const popover = el('siteEditorPopover');
    const titleEl = el('siteEditorPopoverTitle');
    const hint = el('siteEditorPopoverHint');
    if (titleEl) titleEl.textContent = title;
    if (hint) hint.textContent = '';
    lastFocusedBeforePopover = document.activeElement;
    if (popover) popover.hidden = false;
    document.addEventListener('keydown', onPopoverKeydown, true);
  }

  function closePopover() {
    const popover = el('siteEditorPopover');
    if (popover) popover.hidden = true;
    popoverMode = null;
    document.removeEventListener('keydown', onPopoverKeydown, true);
    if (lastFocusedBeforePopover && typeof lastFocusedBeforePopover.focus === 'function') {
      try { lastFocusedBeforePopover.focus(); } catch { /* ignore */ }
    }
  }

  function onPopoverKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePopover();
    }
  }

  function fieldPopoverTitle(fieldKey, schema) {
    return (schema && schema.label) || fieldKey;
  }

  function openFieldPopover(fieldKey, fieldType, rect) {
    const schema = fieldSchemas[fieldKey];
    if (!schema) return;
    popoverMode = { kind: 'field', field: fieldKey };
    openPopoverShell(fieldPopoverTitle(fieldKey, schema));
    positionPopover(rect);
    renderFieldControl(schema.type || fieldType, fieldKey, schema, draftFields[fieldKey]);
    focusFirstPopoverControl();
  }

  function focusFirstPopoverControl() {
    const body = el('siteEditorPopoverBody');
    if (!body) return;
    const focusable = body.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  }

  function buildFieldWrap(labelText, hintText) {
    const wrap = document.createElement('div');
    wrap.className = 'siteEditorField';
    if (labelText) {
      const label = document.createElement('label');
      label.textContent = labelText;
      wrap.appendChild(label);
    }
    if (hintText) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = hintText;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function renderFieldControl(type, fieldKey, schema, value) {
    const body = el('siteEditorPopoverBody');
    if (!body) return;
    body.innerHTML = '';

    const commit = (val) => commitFieldValue(fieldKey, val);

    if (type === 'text' || type === 'email' || type === 'telephone' || type === 'url') {
      const wrap = buildFieldWrap(schema.label);
      const input = document.createElement('input');
      input.className = 'input';
      input.type = type === 'text' ? 'text' : type;
      input.maxLength = schema.maxLength || 500;
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', () => commit(input.value));
      wrap.appendChild(input);
      body.appendChild(wrap);
      return;
    }

    if (type === 'textarea' || type === 'rich_text') {
      const wrap = buildFieldWrap(schema.label, type === 'rich_text' ? 'Basic formatting only: <b>, <i>, <a href="...">.' : '');
      const textarea = document.createElement('textarea');
      textarea.className = 'textarea';
      textarea.rows = 6;
      textarea.maxLength = schema.maxLength || 4000;
      textarea.value = value == null ? '' : String(value);
      textarea.addEventListener('change', () => commit(textarea.value));
      wrap.appendChild(textarea);
      body.appendChild(wrap);
      return;
    }

    if (type === 'weekday') {
      const wrap = buildFieldWrap(schema.label);
      const select = document.createElement('select');
      select.className = 'select';
      for (const day of WEEKDAYS) {
        const opt = document.createElement('option');
        opt.value = day;
        opt.textContent = day;
        if (day === value) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => commit(select.value));
      wrap.appendChild(select);
      body.appendChild(wrap);
      return;
    }

    if (type === 'time') {
      const wrap = buildFieldWrap(schema.label);
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'time';
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', () => commit(input.value));
      wrap.appendChild(input);
      body.appendChild(wrap);
      return;
    }

    if (type === 'boolean') {
      const wrap = buildFieldWrap('');
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';
      const input = document.createElement('input');
      input.className = 'checkbox';
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.addEventListener('change', () => commit(input.checked));
      label.appendChild(input);
      label.appendChild(document.createTextNode(schema.label || ''));
      wrap.appendChild(label);
      body.appendChild(wrap);
      return;
    }

    if (type === 'select') {
      const wrap = buildFieldWrap(schema.label);
      const select = document.createElement('select');
      select.className = 'select';
      for (const opt of schema.options || []) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === value) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener('change', () => commit(select.value));
      wrap.appendChild(select);
      body.appendChild(wrap);
      return;
    }

    if (type === 'image') {
      renderImageControl(body, fieldKey, schema, value, commit);
      return;
    }

    const fallback = document.createElement('p');
    fallback.className = 'hint';
    fallback.textContent = 'This field type is not editable here.';
    body.appendChild(fallback);
  }

  function renderImageControl(body, fieldKey, schema, value, commit) {
    const current = value && typeof value === 'object' ? value : { url: '', alt: '' };

    const previewWrap = document.createElement('div');
    previewWrap.className = 'siteEditorImagePreviewBox';
    if (current.url) {
      const img = document.createElement('img');
      img.src = current.url;
      img.alt = current.alt || '';
      previewWrap.appendChild(img);
    } else {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = 'No image selected.';
      previewWrap.appendChild(none);
    }
    body.appendChild(previewWrap);

    const altWrap = buildFieldWrap('Alt text');
    const altInput = document.createElement('input');
    altInput.className = 'input';
    altInput.type = 'text';
    altInput.maxLength = 200;
    altInput.value = current.alt || '';
    altInput.addEventListener('change', () => {
      commit({ url: current.url || '', alt: altInput.value });
    });
    altWrap.appendChild(altInput);
    body.appendChild(altWrap);

    const fileWrap = buildFieldWrap('Replace image', 'JPG, PNG, WEBP, or GIF. Maximum 8 MB.');
    const fileInput = document.createElement('input');
    fileInput.className = 'input';
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    fileWrap.appendChild(fileInput);
    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn';
    uploadBtn.textContent = 'Upload';
    uploadBtn.addEventListener('click', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const problem = validateUploadFiles([file], {
        maxFileBytes: SITE_IMAGE_UPLOAD_MAX_BYTES,
        maxFiles: 1,
        allowedMimes: IMAGE_UPLOAD_MIME_TYPES,
        label: 'image'
      });
      const hint = el('siteEditorPopoverHint');
      if (problem) {
        if (hint) hint.textContent = problem;
        return;
      }
      uploadBtn.disabled = true;
      if (hint) hint.textContent = 'Uploading…';
      try {
        const fd = new FormData();
        fd.append('image', file);
        const out = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/media`, {
          method: 'POST',
          body: fd
        });
        const nextValue = { url: out.url, alt: altInput.value || current.alt || '' };
        commit(nextValue);
        openFieldPopover(fieldKey, 'image', null);
        if (hint) hint.textContent = 'Image uploaded.';
      } catch (err) {
        if (hint) hint.textContent = err && err.message ? err.message : 'Upload failed.';
      } finally {
        uploadBtn.disabled = false;
      }
    });
    fileWrap.appendChild(uploadBtn);
    body.appendChild(fileWrap);
  }

  // ---------------------------------------------------------------------
  // Collection manager (ministries/leadership profile lists)
  // ---------------------------------------------------------------------
  function makeItemId() {
    return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function openCollectionManager(fieldKey) {
    const schema = fieldSchemas[fieldKey];
    if (!schema) return;
    popoverMode = { kind: 'collection', field: fieldKey };
    openPopoverShell(schema.label || 'Manage list');
    const popover = el('siteEditorPopover');
    if (popover) {
      popover.style.top = '80px';
      popover.style.left = '16px';
    }
    renderCollectionManager(fieldKey, schema);
  }

  function renderCollectionManager(fieldKey, schema) {
    const body = el('siteEditorPopoverBody');
    if (!body) return;
    body.innerHTML = '';

    const items = Array.isArray(draftFields[fieldKey]) ? draftFields[fieldKey].slice() : [];

    const list = document.createElement('div');
    list.style.display = 'grid';
    list.style.gap = '10px';

    items.forEach((item, index) => {
      list.appendChild(renderCollectionItem(fieldKey, schema, items, item, index));
    });

    body.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = `Add ${schema.itemLabel || 'item'}`;
    addBtn.addEventListener('click', () => {
      const newItem = { id: makeItemId() };
      if (Array.isArray(schema.groups) && schema.groups.length) newItem.group = schema.groups[0];
      for (const key of Object.keys(schema.itemFields || {})) {
        newItem[key] = schema.itemFields[key].type === 'image' ? { url: '', alt: '' } : '';
      }
      const next = items.concat([newItem]);
      commitFieldValue(fieldKey, next);
      renderCollectionManager(fieldKey, schema);
    });
    body.appendChild(addBtn);
  }

  function renderCollectionItem(fieldKey, schema, items, item, index) {
    const card = document.createElement('div');
    card.style.border = '1px solid var(--border)';
    card.style.borderRadius = '12px';
    card.style.padding = '10px';
    card.style.display = 'grid';
    card.style.gap = '8px';

    const updateItem = (patch) => {
      const nextItems = items.slice();
      nextItems[index] = Object.assign({}, item, patch);
      commitFieldValue(fieldKey, nextItems);
      item = nextItems[index];
      items = nextItems;
    };

    if (Array.isArray(schema.groups) && schema.groups.length) {
      const groupSelect = document.createElement('select');
      groupSelect.className = 'select';
      for (const g of schema.groups) {
        const opt = document.createElement('option');
        opt.value = g;
        opt.textContent = GROUP_LABELS[g] || g;
        if (g === item.group) opt.selected = true;
        groupSelect.appendChild(opt);
      }
      groupSelect.addEventListener('change', () => updateItem({ group: groupSelect.value }));
      card.appendChild(groupSelect);
    }

    for (const [key, itemFieldSchema] of Object.entries(schema.itemFields || {})) {
      if (itemFieldSchema.type === 'image') {
        const value = item[key] && typeof item[key] === 'object' ? item[key] : { url: '', alt: '' };
        const imgWrap = document.createElement('div');
        imgWrap.className = 'siteEditorImagePreviewBox';
        if (value.url) {
          const img = document.createElement('img');
          img.src = value.url;
          img.alt = value.alt || '';
          imgWrap.appendChild(img);
        }
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.className = 'input';
        fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          const problem = validateUploadFiles([file], {
            maxFileBytes: SITE_IMAGE_UPLOAD_MAX_BYTES,
            maxFiles: 1,
            allowedMimes: IMAGE_UPLOAD_MIME_TYPES,
            label: 'image'
          });
          if (problem) { window.alert(problem); return; }
          try {
            const fd = new FormData();
            fd.append('image', file);
            const out = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/media`, { method: 'POST', body: fd });
            updateItem({ [key]: { url: out.url, alt: value.alt || '' } });
            renderCollectionManager(fieldKey, schema);
          } catch (err) {
            window.alert(err && err.message ? err.message : 'Upload failed.');
          }
        });
        imgWrap.appendChild(fileInput);
        card.appendChild(imgWrap);
        continue;
      }

      const input = itemFieldSchema.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
      input.className = itemFieldSchema.type === 'textarea' ? 'textarea' : 'input';
      if (input.tagName === 'INPUT') input.type = 'text';
      input.placeholder = itemFieldSchema.label || key;
      input.value = item[key] || '';
      input.addEventListener('change', () => updateItem({ [key]: input.value }));
      card.appendChild(input);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      const next = items.slice();
      next.splice(index, 1);
      commitFieldValue(fieldKey, next);
      renderCollectionManager(fieldKey, schema);
    });
    card.appendChild(removeBtn);

    return card;
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wire() {
    if (el('siteEditorSaveBtn')) {
      el('siteEditorSaveBtn').addEventListener('click', () => saveDraft({ silent: false }));
    }
    if (el('siteEditorUpdateBtn')) {
      el('siteEditorUpdateBtn').addEventListener('click', () => publishDraft());
    }
    if (el('siteEditorExitBtn')) {
      el('siteEditorExitBtn').addEventListener('click', () => requestClose());
    }
    if (el('siteEditorPopoverCloseBtn')) {
      el('siteEditorPopoverCloseBtn').addEventListener('click', () => closePopover());
    }
    if (el('siteEditorExitDiscardBtn')) {
      el('siteEditorExitDiscardBtn').addEventListener('click', () => {
        closeExitDialog();
        closeOverlay();
      });
    }
    if (el('siteEditorExitSaveBtn')) {
      el('siteEditorExitSaveBtn').addEventListener('click', async () => {
        await saveDraft({ silent: true });
        closeExitDialog();
        closeOverlay();
      });
    }
    if (el('siteEditorExitCancelBtn')) {
      el('siteEditorExitCancelBtn').addEventListener('click', () => closeExitDialog());
    }
    window.addEventListener('beforeunload', (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = 'You have unsaved website edits.';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.SiteEditor = { open };
})();
