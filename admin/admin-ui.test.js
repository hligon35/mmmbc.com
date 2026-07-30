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
    expect(indexHtml).toContain('data-section-target="tab-newsletter"');
    expect(indexHtml).toContain('data-section-target="tab-photos"');
    expect(indexHtml).toContain('data-section-target="tab-finances"');
    expect(adminJs).toContain("for (const trigger of Array.from(document.querySelectorAll('[data-section-target]'))) {");
  });

  test('Sidebar labels and groups render with plain-language naming', () => {
    expect(indexHtml).toContain('Website Updates');
    expect(indexHtml).toContain('Communication');
    expect(indexHtml).toContain('Administration');
    expect(indexHtml).not.toContain('Edit Website Pages');
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
    expect(adminJs).toContain("$('newsletterTestRecipientsInput').addEventListener('keydown'");
  });

  test('Unsaved-state tracking includes file selections and upload progress', () => {
    expect(adminJs).toContain('const unsavedFileSelections = new Set();');
    expect(adminJs).toContain('const formUploadsInProgress = new Set();');
    expect(adminJs).toContain('function fileSignature(file)');
    expect(adminJs).toContain("markFormUploadState(form, true);");
    expect(adminJs).toContain('You selected file changes that have not been uploaded yet.');
  });

  test('Authentication and CSRF behavior remains wired', () => {
    expect(adminJs).toContain("await fetch('/api/csrf'");
    expect(adminJs).toContain("await api('/api/me', { method: 'GET' })");
    expect(adminJs).toContain("await api('/api/auth/logout', { method: 'POST', body: '{}' });");
  });
});

describe('Church Finances wizard redesign', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'admin.js'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  test('Finance section keeps its section target and heading', () => {
    expect(indexHtml).toContain('data-section-target="tab-finances"');
    expect(indexHtml).toMatch(/Church Finances/);
  });

  test('Record Money defaults to the first sub-tab with a 4-step wizard', () => {
    expect(indexHtml).toContain('id="subTabBtn-finances-record"');
    expect(indexHtml).toContain('id="subTabBtn-finances-review"');
    expect(indexHtml).toContain('id="subTabBtn-finances-reports"');
    expect(indexHtml).toContain('id="panel-finances-record"');
    expect(indexHtml).toContain('data-wizard-goto="direction"');
    expect(indexHtml).toContain('data-wizard-goto="details"');
    expect(indexHtml).toContain('data-wizard-goto="payment"');
    expect(indexHtml).toContain('data-wizard-goto="review"');
  });

  test('Money Direction step offers plain-language choices', () => {
    expect(indexHtml).toContain('What are you recording?');
    expect(indexHtml).toContain('Money Received');
    expect(indexHtml).toContain('Money Spent');
  });

  test('Payment method step removes the old "(Any)" option and requires a real choice', () => {
    expect(indexHtml).toContain('Choose payment method');
    expect(indexHtml).not.toContain('(Any)');
  });

  test('Review step reuses field values and is not gated by confirm()', () => {
    expect(indexHtml).toContain('id="financeReviewSummary"');
    expect(indexHtml).toContain('Review this entry');
    expect(adminJs).toContain('function financeRenderReviewSummary()');
    expect(adminJs).not.toContain("confirmWrite(id ? 'Save changes to this entry?' : 'Add this finance entry?')");
  });

  test('Saving is protected against duplicate submits', () => {
    expect(adminJs).toContain('if (financeWizard.saving) return;');
    expect(adminJs).toContain('financeWizard.saving = true;');
  });

  test('Edit mode reuses the wizard and relabels the heading/buttons', () => {
    expect(adminJs).toContain("heading.textContent = isEditing ? 'Edit Transaction' : 'Record Money';");
    expect(adminJs).toContain("reviewHeading.textContent = isEditing ? 'Review changes' : 'Review this entry';");
    expect(adminJs).toContain("saveBtn.textContent = isEditing ? 'Save Changes' : 'Save Entry';");
  });

  test('Client-side validation uses the exact required copy', () => {
    expect(adminJs).toContain('Enter an amount greater than $0.00.');
    expect(adminJs).toContain('Choose what the money was received for.');
    expect(adminJs).toContain('Choose what this expense was for.');
    expect(adminJs).toContain('Choose a payment method.');
    expect(adminJs).toContain('Enter who was paid.');
  });

  test('Server enforces Paid To for expenses without breaking existing validation', () => {
    expect(serverJs).toContain("if (type === 'expense' && !party) return res.status(400).json({ error: 'Enter who was paid.' });");
    expect(serverJs).toContain("if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });");
  });

  test('Unsaved-change and delete confirmations use dedicated accessible dialogs', () => {
    expect(indexHtml).toContain('id="financeUnsavedDialog"');
    expect(indexHtml).toContain('Keep Editing');
    expect(indexHtml).toContain('Discard Entry');
    expect(indexHtml).toContain('id="financeDeleteDialog"');
    expect(indexHtml).toContain('Void Transaction');
    expect(indexHtml).toContain('Keep Transaction');
    expect(adminJs).toContain('function financeOpenUnsavedDialog(');
    expect(adminJs).toContain('function financeOpenDeleteDialog(');
  });

  test('Review Transactions shows a simplified table with visible-label actions', () => {
    expect(indexHtml).toContain('Transaction History');
    expect(indexHtml).toContain('Money In');
    expect(indexHtml).toContain('Money Out');
    expect(adminJs).toContain("viewBtn.textContent = 'View';");
    expect(adminJs).toContain("editBtn.textContent = 'Edit';");
    expect(adminJs).toContain("receiptBtn.textContent = 'Print Receipt';");
    expect(adminJs).toContain("delBtn.textContent = 'Delete';");
  });

  test('Review Transactions supports advanced filters and Show All Entries', () => {
    expect(indexHtml).toContain('id="financeAdvancedFilters"');
    expect(indexHtml).toContain('id="financeFilterCategory"');
    expect(indexHtml).toContain('id="financeFilterFund"');
    expect(indexHtml).toContain('id="financeFilterMethod"');
    expect(indexHtml).toContain('Show All Entries');
  });

  test('Reports & Printing view keeps Financial Summary, printing, and export actions', () => {
    expect(indexHtml).toContain('View Financial Summary');
    expect(indexHtml).toContain('Print Transaction History');
    expect(indexHtml).toContain('Print Selected Receipts');
    expect(indexHtml).toContain('Download Spreadsheet');
    expect(indexHtml).toContain('Finance Dashboard');
  });

  test('Finance period controls use full labels', () => {
    expect(indexHtml).toContain('This Week');
    expect(indexHtml).toContain('This Month');
  });

  test('Event printing moved out of Finances and into the Events tab', () => {
    expect(indexHtml).toContain('id="eventsPrintMenu"');
    expect(indexHtml).toContain('id="printEventsAllBtn"');
    expect(indexHtml).toContain('id="printEventsGroupBtn"');
    expect(indexHtml).toContain('id="printEventId"');

    const financesSectionMatch = indexHtml.match(/<section class="tabPanel"[^>]*id="tab-finances"[\s\S]*?<\/section>/);
    expect(financesSectionMatch).not.toBeNull();
    expect(financesSectionMatch[0]).not.toContain('printEventsAllBtn');

    const eventsSectionMatch = indexHtml.match(/<section class="tabPanel"[^>]*id="tab-events"[\s\S]*?<\/section>/);
    expect(eventsSectionMatch).not.toBeNull();
    expect(eventsSectionMatch[0]).toContain('printEventsAllBtn');
  });
});
