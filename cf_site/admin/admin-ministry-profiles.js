/*
 * Profile editor for Leadership & Staff and the related public profile pages.
 * Each page keeps its own D1-backed draft/published version. Profile photos use
 * the existing page-media endpoint, which stores uploads under the site/ R2 key
 * prefix and returns a public /cdn/gallery/ URL.
 */
(function () {
  'use strict';

  const admin = window.MMBCAdmin || {};
  const api = admin.api;
  const confirmWrite = admin.confirmWrite || ((message) => window.confirm(message));
  const resetUnsavedBaseline = admin.resetUnsavedBaseline;
  const updateUnsavedForForm = admin.updateUnsavedForForm;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const LEADERSHIP_GROUPS = [
    { value: 'staff', label: 'Leadership & Staff' },
    { value: 'deacons', label: 'Deacons' },
    { value: 'deaconesses', label: 'Deaconesses' },
    { value: 'official_team', label: 'Official Team & Trustees' }
  ];
  const PROFILE_PAGES = [
    { key: 'leadership', label: 'Leadership & Staff', groups: LEADERSHIP_GROUPS },
    { key: 'associate_ministers', label: 'Associate Ministers' },
    { key: 'deacons', label: 'Deacons' },
    { key: 'deaconesses', label: 'Deaconesses' },
    { key: 'official_team_trustees', label: 'Official Team & Trustees' },
    { key: 'ministries', label: 'Ministries' }
  ];

  const state = {
    loaded: false,
    loading: false,
    activePage: 'leadership',
    pages: {},
    editingId: '',
    applying: false
  };

  function $(id) { return document.getElementById(id); }

  function pageConfig(page = state.activePage) {
    return PROFILE_PAGES.find((item) => item.key === page) || PROFILE_PAGES[0];
  }

  function pageState(page = state.activePage) {
    if (!state.pages[page]) {
      state.pages[page] = {
        draftVersion: 0,
        publishedVersion: 0,
        draftFields: normalizeFields({}, page),
        publishedFields: normalizeFields({}, page)
      };
    }
    return state.pages[page];
  }

  function safeText(value, max = 4000) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, (char) => char === '\n' || char === '\t' ? char : '')
      .slice(0, max);
  }

  function safeImage(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      url: safeText(raw.url, 500).trim(),
      alt: safeText(raw.alt, 200).trim()
    };
  }

  function normalizeProfile(raw, index, page) {
    const config = pageConfig(page);
    const fallbackId = `${page}-${index + 1}`;
    const rawGroup = safeText(raw?.group || raw?.section, 120).trim();
    const group = page === 'leadership'
      ? (config.groups.some((item) => item.value === rawGroup) ? rawGroup : 'staff')
      : '';
    return {
      id: safeText(raw?.id || fallbackId, 64).trim() || fallbackId,
      name: safeText(raw?.name, 120).trim(),
      title: safeText(raw?.title, 160).trim(),
      bio: safeText(raw?.bio, 4000).trim(),
      page: safeText(raw?.page || page, 120).trim() || page,
      section: safeText(raw?.section || group || page, 120).trim() || page,
      ...(page === 'leadership' ? { group } : {}),
      image: safeImage(raw?.image)
    };
  }

  function normalizeFields(raw, page) {
    const fields = raw && typeof raw === 'object' ? { ...raw } : {};
    const config = pageConfig(page);
    fields['page.title'] = safeText(fields['page.title'] || config.label, 100).trim();
    if (page === 'ministries') fields['page.intro'] = safeText(fields['page.intro'], 2000).trim();
    else delete fields['page.intro'];
    const profiles = Array.isArray(fields.profiles) ? fields.profiles : [];
    fields.profiles = profiles
      .map((profile, index) => normalizeProfile(profile, index, page))
      .filter((profile) => profile.name || profile.bio || profile.image.url);
    return fields;
  }

  function setStatus(message, kind = '') {
    const node = $('ministriesEditorStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.classList.toggle('ok', kind === 'ok');
    node.classList.toggle('errorText', kind === 'error');
  }

  function setError(message) {
    const node = $('ministriesEditorError');
    if (!node) return;
    node.textContent = String(message || '');
    node.hidden = !message;
  }

  function setDialogError(message) {
    const node = $('ministryProfileFormError');
    if (!node) return;
    node.textContent = String(message || '');
    node.hidden = !message;
  }

  function activeFields() {
    return pageState().draftFields;
  }

  function syncHiddenProfileState() {
    const hidden = $('ministriesProfilesState');
    if (hidden) hidden.value = JSON.stringify(activeFields().profiles || []);
  }

  function markEditorDirty() {
    syncHiddenProfileState();
    const form = $('ministriesPageForm');
    if (form && typeof updateUnsavedForForm === 'function') updateUnsavedForForm(form);
  }

  function renderPageChips() {
    const container = $('ministriesProfilePageChips');
    if (!container) return;
    container.replaceChildren();
    PROFILE_PAGES.forEach((config) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ministryProfilePageChip';
      button.dataset.profilePage = config.key;
      button.textContent = config.label;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(config.key === state.activePage));
      button.setAttribute('aria-pressed', String(config.key === state.activePage));
      if (config.key === state.activePage) button.classList.add('is-active');
      container.appendChild(button);
    });
  }

  function renderEditorFields() {
    const fields = activeFields();
    const config = pageConfig();
    state.applying = true;
    try {
      const title = $('ministriesPageTitle');
      const intro = $('ministriesPageIntro');
      const introField = document.querySelector('.ministryPageForm__intro');
      const pageTitleLabel = document.querySelector('#ministriesPageTitle')?.parentElement;
      if (title) title.value = fields['page.title'] || '';
      if (intro) intro.value = fields['page.intro'] || '';
      if (introField) introField.hidden = state.activePage !== 'ministries';
      if (pageTitleLabel) pageTitleLabel.firstChild.textContent = `${config.label} page heading`;
      const listTitle = $('ministriesProfilesListTitle');
      if (listTitle) listTitle.textContent = `${config.label} profiles`;
      syncHiddenProfileState();
    } finally {
      state.applying = false;
    }
  }

  function isSafeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.startsWith('//')) return false;
    try {
      const parsed = new URL(raw, window.location.origin);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  function createButton(label, action, { danger = false, disabled = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn${danger ? ' btn--danger' : ''}`;
    button.dataset.profileAction = action;
    button.textContent = label;
    button.disabled = disabled;
    return button;
  }

  function groupLabel(value) {
    return LEADERSHIP_GROUPS.find((item) => item.value === value)?.label || value || 'Unassigned';
  }

  function renderProfiles() {
    const list = $('ministriesProfilesList');
    const empty = $('ministriesProfilesEmpty');
    const count = $('ministriesProfilesCount');
    if (!list) return;

    const profiles = Array.isArray(activeFields().profiles) ? activeFields().profiles : [];
    renderPageChips();
    list.replaceChildren();
    if (count) count.textContent = `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`;
    const summary = $('ministriesProfileFilterSummary');
    if (summary) summary.textContent = `${pageConfig().label}: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}`;
    if (empty) {
      empty.hidden = profiles.length > 0;
      empty.textContent = 'No profiles have been added yet. Select Add Profile to create the first card.';
    }

    profiles.forEach((profile, index) => {
      const card = document.createElement('article');
      card.className = 'ministryProfileAdminCard';
      card.dataset.profileId = profile.id;

      const image = document.createElement('div');
      if (isSafeImageUrl(profile.image.url)) {
        const img = document.createElement('img');
        img.className = 'ministryProfileAdminCard__image';
        img.src = profile.image.url;
        img.alt = profile.image.alt || profile.name;
        img.loading = 'lazy';
        image.appendChild(img);
      } else {
        image.className = 'ministryProfileAdminCard__image ministryProfileAdminCard__image--empty';
        image.textContent = 'No photo';
      }
      card.appendChild(image);

      const body = document.createElement('div');
      body.className = 'ministryProfileAdminCard__body';
      const name = document.createElement('h4');
      name.className = 'ministryProfileAdminCard__name';
      name.textContent = profile.name || 'Unnamed profile';
      body.appendChild(name);
      if (profile.title) {
        const title = document.createElement('p');
        title.className = 'ministryProfileAdminCard__title';
        title.textContent = profile.title;
        body.appendChild(title);
      }
      const location = document.createElement('p');
      location.className = 'ministryProfileAdminCard__location';
      location.textContent = state.activePage === 'leadership'
        ? `Section: ${groupLabel(profile.group || profile.section)}`
        : `Page: ${pageConfig().label}`;
      body.appendChild(location);
      const bio = document.createElement('p');
      bio.className = 'ministryProfileAdminCard__bio';
      bio.textContent = profile.bio || 'No biography entered.';
      body.appendChild(bio);
      card.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'ministryProfileAdminCard__actions';
      actions.appendChild(createButton('Edit', 'edit'));
      actions.appendChild(createButton('Move up', 'up', { disabled: index === 0 }));
      actions.appendChild(createButton('Move down', 'down', { disabled: index === profiles.length - 1 }));
      actions.appendChild(createButton('Delete', 'delete', { danger: true }));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function renderActivePage() {
    renderEditorFields();
    renderProfiles();
    updateVersionSummary();
  }

  function updateVersionSummary() {
    const node = $('ministriesVersionSummary');
    if (!node) return;
    const current = pageState();
    node.textContent = state.loaded
      ? `Draft v${current.draftVersion} · Published v${current.publishedVersion}`
      : '';
  }

  function profileFromForm() {
    const page = state.activePage;
    const current = pageState().draftFields.profiles || [];
    const group = page === 'leadership' ? $('ministryProfileGroup')?.value || 'staff' : '';
    return normalizeProfile({
      id: $('ministryProfileId')?.value || '',
      name: $('ministryProfileName')?.value || '',
      title: $('ministryProfileTitle')?.value || '',
      bio: $('ministryProfileBio')?.value || '',
      page,
      section: group || page,
      group,
      image: {
        url: $('ministryProfileImageUrl')?.value || '',
        alt: $('ministryProfileImageAlt')?.value || ''
      }
    }, current.length, page);
  }

  function updateDialogImagePreview(url, alt) {
    const preview = $('ministryProfileImagePreview');
    const empty = $('ministryProfileImageEmpty');
    if (!preview || !empty) return;
    if (isSafeImageUrl(url)) {
      preview.src = url;
      preview.alt = alt || '';
      preview.hidden = false;
      empty.hidden = true;
    } else {
      preview.removeAttribute('src');
      preview.alt = '';
      preview.hidden = true;
      empty.hidden = false;
    }
  }

  function openProfileDialog(profile = null) {
    const dialog = $('ministryProfileDialog');
    const form = $('ministryProfileForm');
    if (!dialog || !form) return;
    const page = state.activePage;
    const current = profile || {
      id: '', name: '', title: '', bio: '', page,
      section: page === 'leadership' ? 'staff' : page,
      group: page === 'leadership' ? 'staff' : '',
      image: { url: '', alt: '' }
    };
    const group = page === 'leadership' ? (current.group || current.section || 'staff') : '';
    state.editingId = current.id || '';
    $('ministryProfileDialogTitle').textContent = current.id ? `Edit ${pageConfig().label} Profile` : `Add ${pageConfig().label} Profile`;
    $('ministryProfileId').value = current.id || '';
    $('ministryProfileName').value = current.name || '';
    $('ministryProfileTitle').value = current.title || '';
    $('ministryProfilePage').value = page;
    $('ministryProfileSection').value = page === 'leadership' ? group : (current.section || page);
    $('ministryProfileBio').value = current.bio || '';
    $('ministryProfileImageUrl').value = current.image?.url || '';
    $('ministryProfileImageAlt').value = current.image?.alt || current.name || '';
    $('ministryProfileImageFile').value = '';
    const groupField = $('ministryProfileGroupField');
    const groupSelect = $('ministryProfileGroup');
    if (groupField) groupField.hidden = page !== 'leadership';
    if (groupSelect) groupSelect.value = group || 'staff';
    setDialogError('');
    updateDialogImagePreview(current.image?.url || '', current.image?.alt || current.name || '');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.hidden = false;
    window.setTimeout(() => $('ministryProfileName')?.focus(), 0);
  }

  function closeProfileDialog() {
    const dialog = $('ministryProfileDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.hidden = true;
    state.editingId = '';
    setDialogError('');
  }

  async function uploadProfileImage(file) {
    if (!file) return '';
    if (!IMAGE_TYPES.has(String(file.type || '').toLowerCase())) throw new Error('Use a JPG, PNG, WEBP, or GIF image.');
    if (Number(file.size || 0) > MAX_IMAGE_BYTES) throw new Error('Profile photos must be 8 MB or smaller.');
    const form = new FormData();
    form.append('image', file, file.name || 'profile-image');
    const page = encodeURIComponent(state.activePage);
    const data = await api(`/api/admin/site-pages/${page}/media`, { method: 'POST', body: form });
    return String(data?.url || '').trim();
  }

  async function saveProfileFromDialog(event) {
    event.preventDefault();
    setDialogError('');
    const profile = profileFromForm();
    if (!profile.name) {
      setDialogError('A profile name is required.');
      return;
    }

    const file = $('ministryProfileImageFile')?.files?.[0];
    const submit = $('ministryProfileForm')?.querySelector('button[type="submit"]');
    try {
      if (submit) submit.disabled = true;
      if (file) {
        setDialogError('Uploading photo…');
        profile.image.url = await uploadProfileImage(file);
        profile.image.alt = profile.image.alt || profile.name;
      }
      if (!profile.image.url) profile.image.alt = '';

      const profiles = Array.isArray(activeFields().profiles) ? [...activeFields().profiles] : [];
      const existingIndex = profiles.findIndex((item) => item.id === profile.id);
      if (existingIndex >= 0) profiles[existingIndex] = profile;
      else {
        profile.id = profile.id || `${state.activePage}-${Date.now()}`;
        profiles.push(profile);
      }
      activeFields().profiles = profiles;
      renderProfiles();
      markEditorDirty();
      closeProfileDialog();
      setStatus('Profile updated in this draft. Select Save Draft to store it.', 'ok');
    } catch (error) {
      setDialogError(error?.message || 'The profile photo could not be uploaded.');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function handleProfileAction(event) {
    const button = event.target?.closest?.('[data-profile-action]');
    const card = event.target?.closest?.('[data-profile-id]');
    if (!button || !card) return;
    const id = String(card.dataset.profileId || '');
    const profiles = Array.isArray(activeFields().profiles) ? [...activeFields().profiles] : [];
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return;
    const action = button.dataset.profileAction;

    if (action === 'edit') {
      openProfileDialog(profiles[index]);
      return;
    }
    if (action === 'delete') {
      if (!confirmWrite(`Delete the profile for ${profiles[index].name || 'this person'}? This removal will be included in the next saved draft.`)) return;
      profiles.splice(index, 1);
    } else if (action === 'up' && index > 0) {
      [profiles[index - 1], profiles[index]] = [profiles[index], profiles[index - 1]];
    } else if (action === 'down' && index < profiles.length - 1) {
      [profiles[index + 1], profiles[index]] = [profiles[index], profiles[index + 1]];
    } else {
      return;
    }

    activeFields().profiles = profiles;
    renderProfiles();
    markEditorDirty();
    setStatus('Profile order or content changed in this draft. Select Save Draft to store it.', 'ok');
  }

  async function loadEditor({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) setStatus('Loading profile pages…');
    setError('');
    try {
      const results = await Promise.all(PROFILE_PAGES.map(async (config) => {
        const data = await api(`/api/admin/site-pages/${encodeURIComponent(config.key)}`, { method: 'GET' });
        return { config, data };
      }));
      results.forEach(({ config, data }) => {
        state.pages[config.key] = {
          draftVersion: Number(data?.draft?.version || 0),
          publishedVersion: Number(data?.published?.version || 0),
          draftFields: normalizeFields(data?.draft?.fields, config.key),
          publishedFields: normalizeFields(data?.published?.fields, config.key)
        };
      });
      state.loaded = true;
      renderActivePage();
      if (typeof resetUnsavedBaseline === 'function') resetUnsavedBaseline($('ministriesPageForm'));
      setStatus('Ready. Changes stay in draft until you publish them.', 'ok');
    } catch (error) {
      state.loaded = false;
      setError(error?.message || 'The profile editor could not be loaded.');
      setStatus('Unable to load profile pages.', 'error');
    } finally {
      state.loading = false;
    }
  }

  async function saveDraft({ silent = false } = {}) {
    if (!state.loaded) await loadEditor();
    const current = pageState();
    const title = String($('ministriesPageTitle')?.value || '').trim();
    if (!title) {
      setError('A page heading is required before saving.');
      return false;
    }
    current.draftFields['page.title'] = title;
    if (state.activePage === 'ministries') current.draftFields['page.intro'] = String($('ministriesPageIntro')?.value || '').trim();
    current.draftFields = normalizeFields(current.draftFields, state.activePage);
    syncHiddenProfileState();
    if (!silent) setStatus(`Saving ${pageConfig().label} draft…`);
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(state.activePage)}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ baseVersion: current.draftVersion, fields: current.draftFields })
      });
      current.draftVersion = Number(data?.draft?.version || current.draftVersion);
      current.draftFields = normalizeFields(data?.draft?.fields || current.draftFields, state.activePage);
      renderActivePage();
      if (typeof resetUnsavedBaseline === 'function') resetUnsavedBaseline($('ministriesPageForm'));
      if (!silent) setStatus(`${pageConfig().label} draft saved. It is not live until you publish it.`, 'ok');
      return true;
    } catch (error) {
      if (Number(error?.status) === 409) {
        await loadEditor({ silent: true });
        setStatus('The draft changed in another session. The latest drafts were reloaded.', 'error');
      } else {
        setError(error?.message || 'The draft could not be saved.');
        setStatus('Draft save failed.', 'error');
      }
      return false;
    }
  }

  async function publishDraft() {
    if (!confirmWrite(`Publish the current ${pageConfig().label} draft to the public website?`)) return;
    const saved = await saveDraft({ silent: true });
    if (!saved) return;
    const current = pageState();
    setStatus(`Publishing ${pageConfig().label}…`);
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(state.activePage)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ baseVersion: current.draftVersion })
      });
      current.publishedVersion = Number(data?.published?.version || current.publishedVersion);
      current.publishedFields = normalizeFields(data?.published?.fields || current.draftFields, state.activePage);
      updateVersionSummary();
      setStatus(`${pageConfig().label} published. The public page will update shortly.`, 'ok');
    } catch (error) {
      setError(error?.message || 'The draft could not be published.');
      setStatus('Publish failed.', 'error');
    }
  }

  async function restorePrevious() {
    if (!confirmWrite(`Restore the previous published ${pageConfig().label} version? This changes what visitors see.`)) return;
    setStatus(`Restoring the previous ${pageConfig().label} version…`);
    try {
      const data = await api(`/api/admin/site-pages/${encodeURIComponent(state.activePage)}/restore-previous`, { method: 'POST', body: '{}' });
      const current = pageState();
      current.publishedVersion = Number(data?.published?.version || current.publishedVersion);
      current.publishedFields = normalizeFields(data?.published?.fields || current.publishedFields, state.activePage);
      updateVersionSummary();
      setStatus(`Previous ${pageConfig().label} version restored. The current draft was kept.`, 'ok');
    } catch (error) {
      setError(error?.message || 'There is no previous published version to restore.');
      setStatus('Restore failed.', 'error');
    }
  }

  function switchPage(page) {
    if (!PROFILE_PAGES.some((item) => item.key === page) || page === state.activePage) return;
    state.activePage = page;
    setError('');
    renderActivePage();
    if (typeof resetUnsavedBaseline === 'function') resetUnsavedBaseline($('ministriesPageForm'));
    setStatus(`Editing ${pageConfig().label}. Changes stay in draft until you save.`, 'ok');
  }

  function wire() {
    const pageForm = $('ministriesPageForm');
    if (!pageForm) return;
    pageForm.addEventListener('input', () => {
      if (state.applying) return;
      activeFields()['page.title'] = String($('ministriesPageTitle')?.value || '').trim();
      if (state.activePage === 'ministries') activeFields()['page.intro'] = String($('ministriesPageIntro')?.value || '').trim();
      markEditorDirty();
    });
    $('ministriesProfilesList')?.addEventListener('click', handleProfileAction);
    $('ministriesProfilePageChips')?.addEventListener('click', (event) => {
      const chip = event.target?.closest?.('[data-profile-page]');
      if (chip) switchPage(chip.dataset.profilePage);
    });
    $('ministriesAddProfileBtn')?.addEventListener('click', () => openProfileDialog());
    $('ministriesRefreshBtn')?.addEventListener('click', () => loadEditor());
    $('ministriesSaveDraftBtn')?.addEventListener('click', () => saveDraft());
    $('ministriesPublishBtn')?.addEventListener('click', publishDraft);
    $('ministriesRestoreBtn')?.addEventListener('click', restorePrevious);
    $('ministryProfileForm')?.addEventListener('submit', saveProfileFromDialog);
    $('ministryProfileDialogCloseBtn')?.addEventListener('click', closeProfileDialog);
    $('ministryProfileCancelBtn')?.addEventListener('click', closeProfileDialog);
    $('ministryProfileImageUrl')?.addEventListener('input', (event) => updateDialogImagePreview(event.target.value, $('ministryProfileImageAlt')?.value));
    $('ministryProfileImageAlt')?.addEventListener('input', () => updateDialogImagePreview($('ministryProfileImageUrl')?.value, $('ministryProfileImageAlt')?.value));
    $('ministryProfileImageFile')?.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) updateDialogImagePreview(URL.createObjectURL(file), $('ministryProfileImageAlt')?.value);
    });
    window.addEventListener('admin:section-activated', (event) => {
      if (event.detail?.sectionId === 'tab-ministries') loadEditor();
    });
    if (document.querySelector('#tab-ministries:not([hidden])')) loadEditor();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
}());
