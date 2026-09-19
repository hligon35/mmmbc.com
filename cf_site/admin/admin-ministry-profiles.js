/*
 * Ministry profile-card editor.
 *
 * This editor uses the existing D1-backed site-page draft/publish API. The
 * public page remains unchanged until an administrator selects Publish to
 * Website, and profile images are stored in the configured Cloudflare R2
 * bucket through the page-media endpoint.
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

  const state = {
    loaded: false,
    loading: false,
    draftVersion: 0,
    publishedVersion: 0,
    draftFields: { 'page.title': '', 'page.intro': '', profiles: [] },
    publishedFields: { 'page.title': '', 'page.intro': '', profiles: [] },
    editingId: '',
    applying: false
  };

  function $(id) { return document.getElementById(id); }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function safeText(value, max = 4000) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, (char) => char === '\n' || char === '\t' ? char : '').slice(0, max);
  }

  function safeImage(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
      url: safeText(raw.url, 500).trim(),
      alt: safeText(raw.alt, 200).trim()
    };
  }

  function normalizeProfile(raw, index) {
    const fallbackId = `ministries-${index + 1}`;
    return {
      id: safeText(raw?.id || fallbackId, 64).trim() || fallbackId,
      name: safeText(raw?.name, 120).trim(),
      title: safeText(raw?.title, 160).trim(),
      bio: safeText(raw?.bio, 4000).trim(),
      image: safeImage(raw?.image)
    };
  }

  function normalizeFields(raw) {
    const fields = raw && typeof raw === 'object' ? raw : {};
    const profiles = Array.isArray(fields.profiles)
      ? fields.profiles.map(normalizeProfile).filter((profile) => profile.name || profile.bio || profile.image.url)
      : [];
    return {
      'page.title': safeText(fields['page.title'] || 'Ministries', 100).trim(),
      'page.intro': safeText(fields['page.intro'], 2000).trim(),
      profiles
    };
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

  function syncHiddenProfileState() {
    const hidden = $('ministriesProfilesState');
    if (hidden) hidden.value = JSON.stringify(state.draftFields.profiles || []);
  }

  function markEditorDirty() {
    syncHiddenProfileState();
    const form = $('ministriesPageForm');
    if (form && typeof updateUnsavedForForm === 'function') updateUnsavedForForm(form);
  }

  function renderEditorFields() {
    state.applying = true;
    try {
      const title = $('ministriesPageTitle');
      const intro = $('ministriesPageIntro');
      if (title) title.value = state.draftFields['page.title'] || '';
      if (intro) intro.value = state.draftFields['page.intro'] || '';
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

  function renderProfiles() {
    const list = $('ministriesProfilesList');
    const empty = $('ministriesProfilesEmpty');
    const count = $('ministriesProfilesCount');
    if (!list) return;

    const profiles = Array.isArray(state.draftFields.profiles) ? state.draftFields.profiles : [];
    list.replaceChildren();
    if (count) count.textContent = `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`;
    if (empty) empty.hidden = profiles.length > 0;

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

  function updateVersionSummary() {
    const node = $('ministriesVersionSummary');
    if (!node) return;
    node.textContent = state.loaded
      ? `Draft v${state.draftVersion} · Published v${state.publishedVersion}`
      : '';
  }

  function profileFromForm() {
    return normalizeProfile({
      id: $('ministryProfileId')?.value || '',
      name: $('ministryProfileName')?.value || '',
      title: $('ministryProfileTitle')?.value || '',
      bio: $('ministryProfileBio')?.value || '',
      image: {
        url: $('ministryProfileImageUrl')?.value || '',
        alt: $('ministryProfileImageAlt')?.value || ''
      }
    }, state.draftFields.profiles.length);
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
    const current = profile || { id: '', name: '', title: '', bio: '', image: { url: '', alt: '' } };
    state.editingId = current.id || '';
    $('ministryProfileDialogTitle').textContent = current.id ? 'Edit Ministry Profile' : 'Add Ministry Profile';
    $('ministryProfileId').value = current.id || '';
    $('ministryProfileName').value = current.name || '';
    $('ministryProfileTitle').value = current.title || '';
    $('ministryProfileBio').value = current.bio || '';
    $('ministryProfileImageUrl').value = current.image?.url || '';
    $('ministryProfileImageAlt').value = current.image?.alt || current.name || '';
    $('ministryProfileImageFile').value = '';
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
    form.append('image', file, file.name || 'ministry-profile-image');
    const data = await api('/api/admin/site-pages/ministries/media', { method: 'POST', body: form });
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

      const profiles = Array.isArray(state.draftFields.profiles) ? [...state.draftFields.profiles] : [];
      const existingIndex = profiles.findIndex((item) => item.id === profile.id);
      if (existingIndex >= 0) profiles[existingIndex] = profile;
      else {
        profile.id = profile.id || `ministries-${Date.now()}`;
        profiles.push(profile);
      }
      state.draftFields.profiles = profiles;
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
    const profiles = Array.isArray(state.draftFields.profiles) ? [...state.draftFields.profiles] : [];
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

    state.draftFields.profiles = profiles;
    renderProfiles();
    markEditorDirty();
    setStatus('Profile order or content changed in this draft. Select Save Draft to store it.', 'ok');
  }

  async function loadEditor({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) setStatus('Loading ministry profiles…');
    setError('');
    try {
      const data = await api('/api/admin/site-pages/ministries', { method: 'GET' });
      state.draftVersion = Number(data?.draft?.version || 0);
      state.publishedVersion = Number(data?.published?.version || 0);
      state.draftFields = normalizeFields(data?.draft?.fields);
      state.publishedFields = normalizeFields(data?.published?.fields);
      state.loaded = true;
      renderEditorFields();
      renderProfiles();
      updateVersionSummary();
      if (typeof resetUnsavedBaseline === 'function') resetUnsavedBaseline($('ministriesPageForm'));
      setStatus('Ready. Changes stay in draft until you publish them.', 'ok');
    } catch (error) {
      state.loaded = false;
      setError(error?.message || 'The Ministry Profiles editor could not be loaded.');
      setStatus('Unable to load ministry profiles.', 'error');
    } finally {
      state.loading = false;
    }
  }

  async function saveDraft({ silent = false } = {}) {
    if (!state.loaded) await loadEditor();
    const title = String($('ministriesPageTitle')?.value || '').trim();
    if (!title) {
      setError('A page heading is required before saving.');
      return false;
    }
    state.draftFields['page.title'] = title;
    state.draftFields['page.intro'] = String($('ministriesPageIntro')?.value || '').trim();
    syncHiddenProfileState();
    if (!silent) setStatus('Saving draft…');
    try {
      const data = await api('/api/admin/site-pages/ministries/draft', {
        method: 'PUT',
        body: JSON.stringify({ baseVersion: state.draftVersion, fields: state.draftFields })
      });
      state.draftVersion = Number(data?.draft?.version || state.draftVersion);
      state.draftFields = normalizeFields(data?.draft?.fields || state.draftFields);
      renderEditorFields();
      renderProfiles();
      updateVersionSummary();
      if (typeof resetUnsavedBaseline === 'function') resetUnsavedBaseline($('ministriesPageForm'));
      if (!silent) setStatus('Draft saved. It is not live until you publish it.', 'ok');
      return true;
    } catch (error) {
      if (Number(error?.status) === 409) {
        await loadEditor({ silent: true });
        setStatus('The draft changed in another session. The latest draft was reloaded.', 'error');
      } else {
        setError(error?.message || 'The draft could not be saved.');
        setStatus('Draft save failed.', 'error');
      }
      return false;
    }
  }

  async function publishDraft() {
    if (!confirmWrite('Publish the current Ministry Profiles draft to the public website?')) return;
    const saved = await saveDraft({ silent: true });
    if (!saved) return;
    setStatus('Publishing to the website…');
    try {
      const data = await api('/api/admin/site-pages/ministries/publish', {
        method: 'POST',
        body: JSON.stringify({ baseVersion: state.draftVersion })
      });
      state.publishedVersion = Number(data?.published?.version || state.publishedVersion);
      state.publishedFields = normalizeFields(data?.published?.fields || state.draftFields);
      updateVersionSummary();
      setStatus('Published. The public Ministries page will update shortly.', 'ok');
    } catch (error) {
      setError(error?.message || 'The draft could not be published.');
      setStatus('Publish failed.', 'error');
    }
  }

  async function restorePrevious() {
    if (!confirmWrite('Restore the previous published Ministry Profiles version? This changes what visitors see.')) return;
    setStatus('Restoring the previous published version…');
    try {
      const data = await api('/api/admin/site-pages/ministries/restore-previous', { method: 'POST', body: '{}' });
      state.publishedVersion = Number(data?.published?.version || state.publishedVersion);
      state.publishedFields = normalizeFields(data?.published?.fields || state.publishedFields);
      updateVersionSummary();
      setStatus('Previous published version restored. The current draft was kept.', 'ok');
    } catch (error) {
      setError(error?.message || 'There is no previous published version to restore.');
      setStatus('Restore failed.', 'error');
    }
  }

  function wire() {
    const pageForm = $('ministriesPageForm');
    if (!pageForm) return;
    pageForm.addEventListener('input', () => {
      if (state.applying) return;
      state.draftFields['page.title'] = String($('ministriesPageTitle')?.value || '').trim();
      state.draftFields['page.intro'] = String($('ministriesPageIntro')?.value || '').trim();
      markEditorDirty();
    });
    $('ministriesProfilesList')?.addEventListener('click', handleProfileAction);
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
