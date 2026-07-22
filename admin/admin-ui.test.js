const fs = require('fs');
const path = require('path');

describe('Admin accessibility redesign guards', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'admin.js'), 'utf8');

  test('Home is the default section after authentication', () => {
    expect(indexHtml).toContain('id="tabBtn-home"');
    expect(indexHtml).toContain('aria-controls="tab-home"');
    expect(adminJs).toContain("activateMainSection('tab-home')");
  });

  test('Home task cards map to expected sections', () => {
    expect(indexHtml).toContain('data-section-target="tab-content"');
    expect(indexHtml).toContain('data-subtab-target="panel-content-announcements"');
    expect(indexHtml).toContain('data-section-target="tab-events"');
    expect(indexHtml).toContain('data-section-target="tab-profiles"');
    expect(indexHtml).toContain('data-section-target="tab-newsletter"');
    expect(indexHtml).toContain('data-section-target="tab-photos"');
    expect(indexHtml).toContain('data-section-target="tab-finances"');
    expect(adminJs).toContain("for (const trigger of Array.from(document.querySelectorAll('[data-section-target]'))) {");
  });

  test('Sidebar labels and groups render with plain-language naming', () => {
    expect(indexHtml).toContain('Website Updates');
    expect(indexHtml).toContain('Communication');
    expect(indexHtml).toContain('Administration');
    expect(indexHtml).toContain('Edit Website Pages');
    expect(indexHtml).toContain('Church Finances');
    expect(indexHtml).toContain('Help &amp; Support');
  });

  test('Drawer toggle states are present', () => {
    expect(indexHtml).toContain('Open Menu');
    expect(adminJs).toContain("btn.textContent = next ? 'Close Menu' : 'Open Menu';");
  });

  test('Advanced Photo Tools are collapsed by default', () => {
    expect(indexHtml).toContain('id="advancedPhotoTools"');
    expect(indexHtml).toContain('Advanced Photo Tools');
    expect(indexHtml).toContain('Most administrators will not need to use them.');
    expect(indexHtml).not.toContain('id="advancedPhotoTools" open');
  });

  test('Opening advanced photo tools uses lazy loading and keeps photo APIs intact', () => {
    expect(adminJs).toContain("$('advancedPhotoTools').addEventListener('toggle'"
    );
    expect(adminJs).toContain('loadR2Tree(r2Prefix).catch((e) => setR2Status(e.message));');
    expect(adminJs).toContain("await api(`/api/gallery/r2tree?prefix=${encodeURIComponent(r2Prefix)}&limit=1000`, { method: 'GET' });");
  });

  test('Bulk controls appear with dynamic labels and count-aware delete copy', () => {
    expect(indexHtml).toContain('id="photoBulkBar"');
    expect(adminJs).toContain("editBtn.textContent = n === 1 ? 'Edit 1 selected photo' : `Edit ${n} selected photos`;");
    expect(adminJs).toContain("deleteBtn.textContent = n === 1 ? 'Delete 1 selected photo' : `Delete ${n} selected photos`;");
    expect(adminJs).toContain('This will remove the selected images from the photo gallery and public website after refresh.');
  });

  test('Newsletter recipient count and workflow summaries are present', () => {
    expect(indexHtml).toContain('Step 1: Choose Recipients');
    expect(indexHtml).toContain('Step 2: Write Newsletter');
    expect(indexHtml).toContain('Step 3: Review and Send');
    expect(indexHtml).toContain('id="newsletterRecipientSummary"');
    expect(adminJs).toContain('This newsletter will be sent to ${recipients}');
  });

  test('Newsletter actions retain send/test/draft/schedule behavior', () => {
    expect(adminJs).toContain("await api('/api/newsletter/send'");
    expect(adminJs).toContain("await api('/api/newsletter/test'");
    expect(adminJs).toContain("await mutateNewsletterRecord('save_draft', payload);");
    expect(adminJs).toContain("await mutateNewsletterRecord('schedule', payload);");
  });

  test('Unsaved-change warnings trigger only when dirty state exists', () => {
    expect(adminJs).toContain('const UNSAVED_WARNING_TEXT =');
    expect(adminJs).toContain('function hasUnsavedChanges()');
    expect(adminJs).toContain('window.addEventListener(\'beforeunload\'');
  });

  test('Finance period controls use full labels', () => {
    expect(indexHtml).toContain('This Week');
    expect(indexHtml).toContain('This Month');
  });

  test('Appearance controls support light dark and device options', () => {
    expect(indexHtml).toContain('id="appearanceSelect"');
    expect(indexHtml).toContain('option value="light"');
    expect(indexHtml).toContain('option value="dark"');
    expect(indexHtml).toContain('option value="system"');
    expect(adminJs).toContain('applyAppearancePreference');
  });

  test('Keyboard accessibility handlers remain for tabs and popovers', () => {
    expect(adminJs).toContain("$('siteEditorPageTabs').addEventListener('keydown'");
    expect(adminJs).toContain("$('newsletterRecipientPopover').addEventListener('keydown'");
  });

  test('Authentication and CSRF behavior remains wired', () => {
    expect(adminJs).toContain("await fetch('/api/csrf'");
    expect(adminJs).toContain("await api('/api/me', { method: 'GET' })");
    expect(adminJs).toContain("await api('/api/auth/logout', { method: 'POST', body: '{}' });");
  });
});
