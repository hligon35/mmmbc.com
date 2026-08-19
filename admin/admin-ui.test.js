const fs = require('fs');
const path = require('path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function expect(actual) {
  return {
    toContain(expected) {
      assert.ok(String(actual).includes(expected), `${String(actual)} does not contain ${expected}`);
    },
    toMatch(pattern) {
      assert.match(String(actual), pattern);
    },
    not: {
      toContain(expected) {
        assert.ok(!String(actual).includes(expected), `${String(actual)} unexpectedly contains ${expected}`);
      },
      toMatch(pattern) {
        assert.doesNotMatch(String(actual), pattern);
      },
      toBeNull() {
        assert.notStrictEqual(actual, null);
      }
    }
  };
}

describe('Admin accessibility redesign guards', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'admin.js'), 'utf8');
  const adminCss = fs.readFileSync(path.join(__dirname, 'public', 'admin.css'), 'utf8');
  const canonicalCss = fs.readFileSync(path.join(__dirname, 'public', 'admin-header-canonical.css'), 'utf8');
  const overrideCss = fs.readFileSync(path.join(__dirname, 'public', 'admin-structure-overrides.css'), 'utf8');
  const overrideJs = fs.readFileSync(path.join(__dirname, 'public', 'admin-structure-overrides.js'), 'utf8');
  const workerJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  const workerAuthWrapperJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker-auth-wrapper.js'), 'utf8');
  const workerAdminWrapperJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker-admin-api-wrapper.js'), 'utf8');

  test('Home is the default section after authentication', () => {
    expect(indexHtml).toContain('id="tabBtn-home"');
    expect(indexHtml).toContain('aria-controls="tab-home"');
    expect(adminJs).toContain("activateMainSection('tab-home')");
  });

  test('Home task cards map to expected sections', () => {
    expect(indexHtml).toContain('id="tabBtn-content"');
    expect(indexHtml).toContain('id="tabBtn-events"');
    expect(indexHtml).toContain('id="tabBtn-newsletter"');
    expect(indexHtml).toContain('id="tabBtn-photos"');
    expect(indexHtml).toContain('id="tabBtn-finances"');
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
    expect(adminJs).toContain("const label = isOpen ? 'Close menu' : 'Open menu';");
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

  test('Photo image-name toggle keeps one aligned label row in source and override styles', () => {
    expect(indexHtml).toContain('id="photoShowImageNames"');
    expect(indexHtml).toContain('class="photoSettingToggle__label"');
    expect(adminCss).toContain('.photoSettingToggle__label{');
    expect(overrideCss).toContain('#tab-photos #photoToolbar > .photoSettingToggle .photoSettingToggle__label');
    expect(overrideJs).not.toContain('contentEventsSplit__eventHeader');
  });

  test('Bulk controls appear with dynamic labels and count-aware delete copy', () => {
    expect(indexHtml).toContain('id="photoBulkBar"');
    expect(adminJs).toContain("const label = n === 1 ? 'Edit 1 selected photo' : `Edit ${n} selected photos`;");
    expect(adminJs).toContain("setActionIconButton(editBtn, 'edit', label);");
    expect(adminJs).toContain("const label = n === 1 ? 'Delete 1 selected photo' : `Delete ${n} selected photos`;");
    expect(adminJs).toContain("setActionIconButton(deleteBtn, 'delete', label);");
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

  test('Newsletter compose fields use responsive grouped rows without changing existing ids', () => {
    expect(indexHtml).toContain('newsletterComposeGrid newsletterComposeGrid--lead');
    expect(indexHtml).toContain('newsletterComposeGrid newsletterComposeGrid--schedule');
    expect(indexHtml).toContain('id="newsletterSubject"');
    expect(indexHtml).toContain('id="newsletterWeekOfDate"');
    expect(indexHtml).toContain('id="newsletterScheduleTimezone"');
    expect(adminCss).toContain('.newsletterComposeGrid--schedule{');
    expect(overrideCss).toContain('#tab-newsletter .newsletterComposeGrid--schedule');
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

  test('Invite admin button is positioned and wired for interaction', () => {
    expect(adminJs).toContain("$('inviteAdminBtn').addEventListener('click', (event) => {");
    expect(adminJs).toContain('openInviteAdminDialog();');
    expect(adminJs).toContain("event.preventDefault();");
    expect(adminCss).toContain('.headerInviteBtn{');
    expect(canonicalCss).toContain('transform:translateX(-200px) !important;');
    expect(canonicalCss).toContain('pointer-events:auto !important;');
    expect(canonicalCss).toContain('html body #adminHeader .headerInviteBtn{');
  });

  test('Developer diagnostics are gated by explicit capability checks across local and worker paths', () => {
    expect(adminJs).toContain('capabilities?.diagnostics?.view === true');
    expect(adminJs).toContain("await api('/api/admin/storage-health', { method: 'GET' });");
    expect(workerAuthWrapperJs).toContain('DEVELOPER_EMAILS');
    expect(workerAdminWrapperJs).toContain('Developer diagnostics access is required for this action.');
    expect(workerJs).toContain('hasDeveloperDiagnosticsAccess');
  });

  test('Announcements and events combine without injecting a duplicate events heading block', () => {
    expect(overrideJs).not.toContain('sectionHeader--compact contentEventsSplit__eventHeader');
    expect(overrideJs).toContain("eventDescription.textContent = 'Add, edit, and delete service times, meetings, and church programs.';");
  });
});

describe('Church Finances wizard redesign', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, 'public', 'admin.js'), 'utf8');
  const adminCss = fs.readFileSync(path.join(__dirname, 'public', 'admin.css'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  test('Finance section keeps its section target and heading', () => {
    expect(indexHtml).toContain('id="tabBtn-finances"');
    expect(indexHtml).toContain('aria-controls="tab-finances"');
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
    expect(adminJs).toContain("setActionIconButton(viewBtn, 'view', 'View details');");
    expect(adminJs).toContain("setActionIconButton(editBtn, 'edit', 'Edit entry');");
    expect(adminJs).toContain("receiptBtn.textContent = 'Print Receipt';");
    expect(adminJs).toContain("delBtn.textContent = 'Void';");
  });

  test('Review Transactions supports advanced filters and Reset All Filters', () => {
    expect(indexHtml).toContain('id="financeAdvancedFilters"');
    expect(indexHtml).toContain('id="financeFilterCategory"');
    expect(indexHtml).toContain('id="financeFilterFund"');
    expect(indexHtml).toContain('id="financeFilterMethod"');
    expect(indexHtml).toContain('Reset All Filters');
    expect(adminJs).toContain('financeClearQuickKind({ render: false });');
  });

  test('Reports & Printing view keeps summary, printing, and new export actions while hiding removed entry points', () => {
    expect(indexHtml).toContain('Print Transaction History');
    expect(indexHtml).toContain('Print Selected Receipts');
    expect(indexHtml).toContain('Export Transactions');
    expect(indexHtml).toContain('id="financeExportCsvBtn"');
    expect(indexHtml).toContain('id="financeExportXlsxBtn"');
    expect(indexHtml).toContain('id="financeExportSheetsBtn"');
    expect(indexHtml).not.toContain('financeViewSummaryBtn');
    expect(indexHtml).toContain('Money Flow');
    expect(indexHtml).toContain('Giving Breakdown');
    expect(indexHtml).not.toContain('Design &amp; Print Envelopes');
    expect(indexHtml).not.toContain('Finance Dashboard');
    expect(indexHtml).not.toMatch(/id="financeReportsTotals"[^>]*hidden|hidden[^>]*id="financeReportsTotals"/);
    expect(adminJs).not.toContain('function toggleFinanceSummaryPanel(');
    expect(adminJs).toContain('function financeExportToXlsx(rows)');
    expect(adminJs).toContain('function financeExportToGoogleSheets(rows)');
    expect(indexHtml).toContain('/admin/vendor/xlsx.full.min.js');
  });

  test('Receipt printing only renders when an entry is valid for receipt output', () => {
    expect(adminJs).toContain('function financeCanPrintReceipt(entry)');
    expect(adminJs).toContain('if (financeCanPrintReceipt(e)) {');
    expect(adminJs).toContain('No valid transactions are available to print.');
  });

  test('Record Money removes the visible scan QR action and keeps the wider two-column detail layout', () => {
    expect(indexHtml).not.toContain('id="financeScanQrBtn"');
    expect(indexHtml).toContain('class="label financeWizardField"');
    expect(adminCss).toContain('.financeWizardField{');
    expect(adminCss).toContain('.financeWizardPanel{');
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
