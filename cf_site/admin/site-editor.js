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
//   iframe -> parent: ready | fieldClick | collectionItemClick | collectionItemActions | navigateBlocked | error
//   parent -> iframe: init | refresh | setField | setCollectionItemField | setSelection | clearSelection
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
  let publishedFieldsSnapshot = {};
  let dirty = false;
  let saving = false;
  let publishing = false;
  let frameReady = false;
  let lastFocusedBeforePopover = null;
  let autosaveDebounceTimer = null;
  let autosaveIntervalTimer = null;
  let popoverMode = null; // { kind: 'field', field } | { kind: 'collection', field } | { kind: 'item', collection, itemId, field } | { kind: 'itemActions', collection, itemId }
  let lastChange = null; // single-slot undo: { kind: 'field', field, prevValue } | { kind: 'item', collection, itemId, field, prevValue }

  // ---------------------------------------------------------------------
  // Small accessible dialog helpers (replace window.confirm / window.alert, which are
  // not screen-reader-friendly and block the whole tab). All three return promises.
  // ---------------------------------------------------------------------
  function showAlertDialog(message, title) {
    return new Promise((resolve) => {
      const dialog = el('siteEditorAlertDialog');
      if (!(dialog instanceof HTMLDialogElement)) { resolve(); return; }
      el('siteEditorAlertDialogTitle').textContent = title || 'Notice';
      el('siteEditorAlertDialogBody').textContent = message || '';
      const okBtn = el('siteEditorAlertOkBtn');
      const onOk = () => { cleanup(); resolve(); };
      function cleanup() {
        okBtn.removeEventListener('click', onOk);
        if (dialog.open) dialog.close();
      }
      okBtn.addEventListener('click', onOk);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }

  function showConfirmDialog(message, title, confirmLabel) {
    return new Promise((resolve) => {
      const dialog = el('siteEditorConfirmDialog');
      if (!(dialog instanceof HTMLDialogElement)) { resolve(window.confirm(message)); return; }
      el('siteEditorConfirmDialogTitle').textContent = title || 'Are you sure?';
      el('siteEditorConfirmDialogBody').textContent = message || '';
      const okBtn = el('siteEditorConfirmOkBtn');
      const cancelBtn = el('siteEditorConfirmCancelBtn');
      okBtn.textContent = confirmLabel || 'Confirm';
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      function cleanup() {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (dialog.open) dialog.close();
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }

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
      const proceed = await showConfirmDialog(
        'You have unsaved changes on this page. Switch pages anyway? Unsaved edits from the last few seconds may be lost.',
        'Switch pages?',
        'Switch pages'
      );
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
      publishedFieldsSnapshot = (data.published && data.published.fields) || {};
      lastChange = null;
      updateUndoButton();
      if (titleEl) titleEl.textContent = `Edit ${pageLabel}`;
      renderCollectionButtons();
      loadFrame(pageKey);
      setStatus('Saved');
      startAutosaveInterval();
    } catch (err) {
      setLoading(false);
      setStatus('Failed to load');
      await showAlertDialog(err && err.message ? err.message : 'Could not load this page for editing.');
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
  function collectionFieldKeys() {
    return Object.entries(fieldSchemas)
      .filter(([, schema]) => schema && schema.type === 'collection')
      .map(([key]) => key);
  }

  function renderCollectionButtons() {
    const actions = document.querySelector('.siteEditorOverlay__actions');
    if (!actions) return;
    document.querySelectorAll('[data-site-editor-manage-list]').forEach((btn) => btn.remove());
    const keys = collectionFieldKeys();
    for (const key of keys) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.setAttribute('data-site-editor-manage-list', key);
      btn.textContent = `Manage ${fieldSchemas[key].label || 'List'}`;
      btn.addEventListener('click', () => openCollectionManager(key));
      actions.insertBefore(btn, el('siteEditorSaveBtn'));
    }
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
    } else if (data.type === 'collectionItemClick') {
      openCollectionItemFieldPopover(data.collection, data.itemId, data.field, data.fieldType, data.rect);
    } else if (data.type === 'collectionItemActions') {
      openItemActionsPopover(data.collection, data.itemId, data.rect);
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
    lastChange = { kind: 'field', field: fieldKey, prevValue: draftFields[fieldKey] };
    updateUndoButton();
    draftFields[fieldKey] = value;
    dirty = true;
    setStatus('Unsaved changes');
    if (frameReady) postToFrame({ type: 'setField', field: fieldKey, value });
    scheduleAutosave();
  }

  function findCollectionItem(collection, itemId) {
    const items = Array.isArray(draftFields[collection]) ? draftFields[collection] : [];
    return items.find((it) => it && it.id === itemId) || null;
  }

  function commitCollectionItemField(collection, itemId, field, value) {
    const items = Array.isArray(draftFields[collection]) ? draftFields[collection].slice() : [];
    const index = items.findIndex((it) => it && it.id === itemId);
    if (index === -1) return;
    lastChange = { kind: 'item', collection, itemId, field, prevValue: items[index][field] };
    updateUndoButton();
    items[index] = Object.assign({}, items[index], { [field]: value });
    draftFields[collection] = items;
    dirty = true;
    setStatus('Unsaved changes');
    if (frameReady) postToFrame({ type: 'setCollectionItemField', collection, itemId, field, value });
    scheduleAutosave();
  }

  function updateUndoButton() {
    const btn = el('siteEditorUndoBtn');
    if (btn) btn.disabled = !lastChange;
  }

  function undoLastChange() {
    if (!lastChange) return;
    if (lastChange.kind === 'field') {
      const { field, prevValue } = lastChange;
      draftFields[field] = prevValue;
      if (frameReady) postToFrame({ type: 'setField', field, value: prevValue });
    } else if (lastChange.kind === 'item') {
      const { collection, itemId, field, prevValue } = lastChange;
      const items = Array.isArray(draftFields[collection]) ? draftFields[collection].slice() : [];
      const index = items.findIndex((it) => it && it.id === itemId);
      if (index !== -1) {
        items[index] = Object.assign({}, items[index], { [field]: prevValue });
        draftFields[collection] = items;
        if (frameReady) postToFrame({ type: 'setCollectionItemField', collection, itemId, field, value: prevValue });
      }
    }
    lastChange = null;
    updateUndoButton();
    dirty = true;
    setStatus('Unsaved changes');
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
      if (!silent) await showAlertDialog(err && err.message ? err.message : 'Could not save this page.');
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
    const proceed = await openPublishReviewDialog();
    if (!proceed) return;
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
      publishedFieldsSnapshot = (data.published && data.published.fields) || publishedFieldsSnapshot;
      setStatus('Published');
    } catch (err) {
      if (err && err.status === 409) {
        setStatus('Reloading latest draft…');
        await reloadAfterConflict();
        setStatus('Reloaded — please review and try Update again.');
      } else {
        setStatus('Publish failed');
        await showAlertDialog(err && err.message ? err.message : 'This page could not be published. Check the fields and try again.');
      }
    } finally {
      publishing = false;
    }
  }

  // Summarizes, in plain language, which fields/collections differ between the current
  // draft and what's currently live, so the reviewer knows exactly what publishing will
  // change before it happens. Not a byte-level diff — a friendly "what changed" summary.
  function describeFieldChange(key, schema) {
    const before = publishedFieldsSnapshot ? publishedFieldsSnapshot[key] : undefined;
    const after = draftFields[key];
    const label = (schema && schema.label) || key;
    if (schema && schema.type === 'collection') {
      const beforeCount = Array.isArray(before) ? before.length : 0;
      const afterCount = Array.isArray(after) ? after.length : 0;
      if (JSON.stringify(before || []) === JSON.stringify(after || [])) return null;
      return `${label}: ${beforeCount} → ${afterCount} item(s), content changed`;
    }
    if (JSON.stringify(before === undefined ? null : before) === JSON.stringify(after === undefined ? null : after)) return null;
    return `${label}: updated`;
  }

  function openPublishReviewDialog() {
    return new Promise((resolve) => {
      const dialog = el('siteEditorPublishDialog');
      const list = el('siteEditorPublishDialogList');
      if (!(dialog instanceof HTMLDialogElement) || !list) { resolve(true); return; }
      list.innerHTML = '';
      const changes = Object.keys(fieldSchemas)
        .map((key) => describeFieldChange(key, fieldSchemas[key]))
        .filter(Boolean);
      if (changes.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No changes detected since the last published version.';
        list.appendChild(li);
      } else {
        for (const change of changes) {
          const li = document.createElement('li');
          li.textContent = change;
          list.appendChild(li);
        }
      }
      const confirmBtn = el('siteEditorPublishConfirmBtn');
      const cancelBtn = el('siteEditorPublishCancelBtn');
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      function cleanup() {
        confirmBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        if (dialog.open) dialog.close();
      }
      confirmBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    });
  }

  async function restorePreviousPublished() {
    if (!currentPage) return;
    const proceed = await showConfirmDialog(
      'This replaces the LIVE site content for this page with the previously published version. Your current draft is not affected. Continue?',
      'Restore previous published version?',
      'Restore'
    );
    if (!proceed) return;
    setStatus('Restoring…');
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/restore-previous`, { method: 'POST' });
      publishedVersion = (data.published && data.published.version) || publishedVersion;
      publishedFieldsSnapshot = (data.published && data.published.fields) || publishedFieldsSnapshot;
      setStatus('Previous version restored');
      await showAlertDialog('The live site now shows the previously published version of this page.', 'Restored');
    } catch (err) {
      setStatus('Restore failed');
      await showAlertDialog(err && err.message ? err.message : 'Could not restore the previous version.');
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
    postToFrame({ type: 'clearSelection' });
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

  // Re-renders whichever popover is currently open for a given field key, after an
  // async action (like an image upload) changes its value out from under the form.
  function reopenCurrentFieldPopover(fieldKey) {
    if (popoverMode && popoverMode.kind === 'item' && popoverMode.field === fieldKey) {
      openCollectionItemFieldPopover(popoverMode.collection, popoverMode.itemId, fieldKey, 'image', null);
    } else {
      openFieldPopover(fieldKey, 'image', null);
    }
  }

  function openFieldPopover(fieldKey, fieldType, rect) {
    const schema = fieldSchemas[fieldKey];
    if (!schema) return;
    popoverMode = { kind: 'field', field: fieldKey };
    openPopoverShell(fieldPopoverTitle(fieldKey, schema));
    positionPopover(rect);
    renderFieldControl(schema.type || fieldType, fieldKey, schema, draftFields[fieldKey]);
    postToFrame({ type: 'setSelection', field: fieldKey });
    focusFirstPopoverControl();
  }

  // Popover for editing ONE subfield of ONE collection item (e.g. clicking directly on a
  // schedule activity's title or time on the rendered page). Reuses renderFieldControl by
  // wrapping schema.itemFields[field] into a plain field schema shape.
  function openCollectionItemFieldPopover(collectionKey, itemId, fieldKey, fieldType, rect) {
    const schema = fieldSchemas[collectionKey];
    const itemFieldSchema = schema && schema.itemFields && schema.itemFields[fieldKey];
    const item = findCollectionItem(collectionKey, itemId);
    if (!schema || !itemFieldSchema || !item) return;
    popoverMode = { kind: 'item', collection: collectionKey, itemId, field: fieldKey };
    openPopoverShell(`${schema.itemLabel || 'Item'}: ${itemFieldSchema.label || fieldKey}`);
    positionPopover(rect);
    renderFieldControl(itemFieldSchema.type || fieldType, fieldKey, itemFieldSchema, item[fieldKey], (value) => {
      commitCollectionItemField(collectionKey, itemId, fieldKey, value);
    });
    postToFrame({ type: 'setSelection', collection: collectionKey, itemId, field: fieldKey });
    focusFirstPopoverControl();
  }

  // Popover for whole-item actions on a collection item (the "⋮" handle button rendered
  // next to each schedule activity / profile card): edit every subfield at once, add a new
  // item right after this one, reorder, or remove.
  function openItemActionsPopover(collectionKey, itemId, rect) {
    const schema = fieldSchemas[collectionKey];
    const items = Array.isArray(draftFields[collectionKey]) ? draftFields[collectionKey] : [];
    const index = items.findIndex((it) => it && it.id === itemId);
    if (!schema || index === -1) return;
    popoverMode = { kind: 'itemActions', collection: collectionKey, itemId };
    openPopoverShell(`${schema.itemLabel || 'Item'} actions`);
    positionPopover(rect);
    renderItemActionsBody(collectionKey, schema, itemId);
    postToFrame({ type: 'setSelection', collection: collectionKey, itemId });
  }

  function renderItemActionsBody(collectionKey, schema, itemId) {
    const body = el('siteEditorPopoverBody');
    if (!body) return;
    body.innerHTML = '';

    const items = Array.isArray(draftFields[collectionKey]) ? draftFields[collectionKey] : [];
    const index = items.findIndex((it) => it && it.id === itemId);
    if (index === -1) return;
    const item = items[index];

    const editWrap = document.createElement('div');
    editWrap.style.display = 'grid';
    editWrap.style.gap = '8px';
    editWrap.appendChild(renderCollectionItem(collectionKey, schema, items, item, index));
    body.appendChild(editWrap);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'toolbar';
    actionsRow.style.marginTop = '8px';

    const addBelowBtn = document.createElement('button');
    addBelowBtn.type = 'button';
    addBelowBtn.className = 'btn';
    addBelowBtn.textContent = `Add ${schema.itemLabel || 'item'} below`;
    addBelowBtn.addEventListener('click', () => {
      const current = Array.isArray(draftFields[collectionKey]) ? draftFields[collectionKey].slice() : [];
      const at = current.findIndex((it) => it && it.id === itemId);
      const newItem = { id: makeItemId() };
      for (const key of Object.keys(schema.itemFields || {})) {
        newItem[key] = defaultItemFieldValue(schema.itemFields[key]);
      }
      current.splice(at + 1, 0, newItem);
      commitFieldValue(collectionKey, current);
      closePopover();
    });
    actionsRow.appendChild(addBelowBtn);

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'btn';
    moveUpBtn.textContent = 'Move up';
    moveUpBtn.disabled = index === 0;
    moveUpBtn.addEventListener('click', () => {
      const current = draftFields[collectionKey].slice();
      const at = current.findIndex((it) => it && it.id === itemId);
      if (at > 0) {
        [current[at - 1], current[at]] = [current[at], current[at - 1]];
        commitFieldValue(collectionKey, current);
        renderItemActionsBody(collectionKey, schema, itemId);
      }
    });
    actionsRow.appendChild(moveUpBtn);

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'btn';
    moveDownBtn.textContent = 'Move down';
    moveDownBtn.disabled = index === items.length - 1;
    moveDownBtn.addEventListener('click', () => {
      const current = draftFields[collectionKey].slice();
      const at = current.findIndex((it) => it && it.id === itemId);
      if (at !== -1 && at < current.length - 1) {
        [current[at + 1], current[at]] = [current[at], current[at + 1]];
        commitFieldValue(collectionKey, current);
        renderItemActionsBody(collectionKey, schema, itemId);
      }
    });
    actionsRow.appendChild(moveDownBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn';
    removeBtn.textContent = `Remove ${schema.itemLabel || 'item'}`;
    removeBtn.addEventListener('click', async () => {
      const proceed = await showConfirmDialog(`Remove this ${(schema.itemLabel || 'item').toLowerCase()}? This cannot be undone with the Undo button.`, 'Remove item?', 'Remove');
      if (!proceed) return;
      const current = draftFields[collectionKey].slice();
      const at = current.findIndex((it) => it && it.id === itemId);
      if (at !== -1) current.splice(at, 1);
      commitFieldValue(collectionKey, current);
      closePopover();
    });
    actionsRow.appendChild(removeBtn);

    body.appendChild(actionsRow);
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

  function renderFieldControl(type, fieldKey, schema, value, commitOverride) {
    const body = el('siteEditorPopoverBody');
    if (!body) return;
    body.innerHTML = '';

    const commit = commitOverride || ((val) => commitFieldValue(fieldKey, val));

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

    if (type === 'number') {
      const wrap = buildFieldWrap(schema.label);
      const input = document.createElement('input');
      input.className = 'input';
      input.type = 'number';
      if (typeof schema.min === 'number') input.min = String(schema.min);
      if (typeof schema.max === 'number') input.max = String(schema.max);
      input.value = value == null ? '' : String(value);
      input.addEventListener('change', () => commit(Number(input.value) || 0));
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
        reopenCurrentFieldPopover(fieldKey);
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

  function defaultItemFieldValue(itemFieldSchema) {
    if (itemFieldSchema.type === 'image') return { url: '', alt: '' };
    if (itemFieldSchema.type === 'number') return typeof itemFieldSchema.min === 'number' ? itemFieldSchema.min : 0;
    if (itemFieldSchema.type === 'weekday') return WEEKDAYS[0];
    return '';
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
        newItem[key] = defaultItemFieldValue(schema.itemFields[key]);
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
          if (problem) { await showAlertDialog(problem); return; }
          try {
            const fd = new FormData();
            fd.append('image', file);
            const out = await api(`/api/admin/site-pages/${encodeURIComponent(currentPage)}/media`, { method: 'POST', body: fd });
            updateItem({ [key]: { url: out.url, alt: value.alt || '' } });
            renderCollectionManager(fieldKey, schema);
          } catch (err) {
            await showAlertDialog(err && err.message ? err.message : 'Upload failed.');
          }
        });
        imgWrap.appendChild(fileInput);
        card.appendChild(imgWrap);
        continue;
      }

      const type = itemFieldSchema.type;
      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'textarea';
      } else if (type === 'weekday') {
        input = document.createElement('select');
        input.className = 'select';
        for (const day of WEEKDAYS) {
          const opt = document.createElement('option');
          opt.value = day;
          opt.textContent = day;
          if (day === item[key]) opt.selected = true;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement('input');
        input.className = 'input';
        input.type = type === 'time' ? 'time' : type === 'number' ? 'number' : 'text';
      }
      if (input.tagName !== 'SELECT') {
        input.placeholder = itemFieldSchema.label || key;
        input.value = item[key] == null ? '' : String(item[key]);
      }
      input.addEventListener('change', () => updateItem({ [key]: type === 'number' ? (Number(input.value) || 0) : input.value }));
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
    if (el('siteEditorUndoBtn')) {
      el('siteEditorUndoBtn').disabled = true;
      el('siteEditorUndoBtn').addEventListener('click', () => undoLastChange());
    }
    if (el('siteEditorRestorePreviousBtn')) {
      el('siteEditorRestorePreviousBtn').addEventListener('click', () => restorePreviousPublished());
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
