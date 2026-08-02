(function(){
  'use strict';

  const $ = (id) => document.getElementById(id);
  const page = document.body.getAttribute('data-page') || '';

  async function fetchCsrf(){
    const r = await fetch('/api/csrf', { credentials:'include' });
    if (!r.ok) throw new Error('Sign in is required.');
    const j = await r.json();
    return String(j.csrfToken || '');
  }

  async function api(url, options){
    const opts = options || {};
    const headers = Object.assign({ 'content-type':'application/json' }, opts.headers || {});
    if (!['GET','HEAD'].includes(String(opts.method || 'GET').toUpperCase())) {
      headers['X-CSRF-Token'] = await fetchCsrf();
    }
    const res = await fetch(url, Object.assign({}, opts, { headers, credentials:'include' }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = typeof data?.error === 'string'
        ? data.error
        : String(data?.error?.message || 'Request failed.');
      const err = new Error(message);
      err.payload = data;
      throw err;
    }
    return data;
  }

  function setMsg(el, text, kind){
    if (!el) return;
    el.className = kind || 'help';
    el.textContent = text || '';
  }

  function money(cents){
    return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(Number(cents || 0) / 100);
  }

  function escapeHtml(value){
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function amountToCents(value){
    const num = Number(String(value || '').trim());
    if (!Number.isFinite(num)) return NaN;
    return Math.round(num * 100);
  }

  function centsToInput(cents){
    return (Number(cents || 0) / 100).toFixed(2);
  }

  async function initFunds(){
    const msg = $('fundMsg');
    const table = $('fundTableBody');
    const summary = $('fundSummary');
    const form = $('fundForm');
    const transferForm = $('transferForm');
    let funds = [];

    async function load(){
      const dash = await api('/api/finances/funds/dashboard', { method:'GET' });
      funds = Array.isArray(dash.funds) ? dash.funds : [];
      if (summary) {
        summary.innerHTML = `
          <div class="card"><strong>Total unrestricted funds</strong><div>${money(dash.summary.totalUnrestrictedFundsCents)}</div></div>
          <div class="card"><strong>Total restricted funds</strong><div>${money(dash.summary.totalRestrictedFundsCents)}</div></div>
          <div class="card"><strong>General operating balance</strong><div>${money(dash.summary.generalOperatingBalanceCents)}</div></div>
          <div class="card"><strong>Savings and reserves</strong><div>${money(dash.summary.savingsAndReservesCents)}</div></div>
        `;
      }
      if (table) {
        table.innerHTML = funds.map((f) => `
          <tr>
            <td>${f.fundName}</td>
            <td>${f.fundType}</td>
            <td>${f.restrictionStatus}</td>
            <td>${money(f.currentBalanceCents)}</td>
            <td>${money(f.availableBalanceCents)}</td>
            <td>${money(f.pendingDepositsCents)}</td>
            <td>${money(f.pendingExpensesCents)}</td>
            <td>${f.active ? 'Active' : 'Archived'}</td>
          </tr>
        `).join('');
      }
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const payload = {
            fundName: $('fundName').value,
            fundCode: $('fundCode').value,
            fundType: $('fundType').value,
            restrictionStatus: $('fundRestriction').value,
            description: $('fundDescription').value,
            openingBalance: $('fundOpening').value,
            minimumBalanceWarning: $('fundMin').value,
            budgetAmount: $('fundBudget').value,
            responsibleMinistry: $('fundMinistry').value,
            responsibleAdministrator: $('fundAdmin').value,
            notes: $('fundNotes').value,
            active: true
          };
          await api('/api/finances/funds', { method:'POST', body: JSON.stringify(payload) });
          setMsg(msg, 'Fund saved. Review the dashboard totals to confirm.', 'ok');
          form.reset();
          await load();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (transferForm) {
      transferForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/finances/funds/transfers', {
            method:'POST',
            body: JSON.stringify({
              fromFundId: $('transferFrom').value,
              toFundId: $('transferTo').value,
              amount: $('transferAmount').value,
              reason: $('transferReason').value
            })
          });
          setMsg(msg, 'Transfer request saved. If restricted funds are involved, Treasurer approval is required.', 'ok');
          transferForm.reset();
          await load();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    await load();
    const fundOptions = funds.map((f) => `<option value="${f.id}">${f.fundName}</option>`).join('');
    if ($('transferFrom')) $('transferFrom').innerHTML = `<option value="">Select fund</option>${fundOptions}`;
    if ($('transferTo')) $('transferTo').innerHTML = `<option value="">Select fund</option>${fundOptions}`;
  }

  async function initDonors(){
    const msg = $('donorMsg');
    const list = $('donorTableBody');
    const form = $('donorForm');
    const envMsg = $('donorEnvelopeMsg');
    const selectedInput = $('donorEnvelopeSelected');
    const envelopeEdit = $('donorEnvelopeNumberEdit');
    const envelopeReason = $('donorEnvelopeReason');
    const labelPreview = $('donorEnvelopeLabelPreview');
    const historyMsg = $('donorHistoryMsg');
    const historyTable = $('donorHistoryTableBody');
    let donors = [];
    let selectedDonorId = '';

    function selectedDonor(){
      return donors.find((d) => d.id === selectedDonorId) || null;
    }

    function renderSelectedDonor(){
      const donor = selectedDonor();
      if (!donor) {
        if (selectedInput) selectedInput.value = '';
        if (envelopeEdit) envelopeEdit.value = '';
        return;
      }
      if (selectedInput) {
        selectedInput.value = `${donor.firstName} ${donor.lastName} (${donor.id})`;
      }
      if (envelopeEdit) envelopeEdit.value = donor.envelopeNumber || '';
    }

    async function load(){
      const q = encodeURIComponent(String(($('donorSearch')?.value || '')).trim());
      const data = await api(`/api/finances/donors?q=${q}`, { method:'GET' });
      donors = Array.isArray(data.donors) ? data.donors : [];
      if (list) {
        list.innerHTML = donors.map((d) => `
          <tr>
            <td>${escapeHtml(d.firstName)} ${escapeHtml(d.lastName)}</td>
            <td>${escapeHtml(d.householdId || '')}</td>
            <td>${escapeHtml(d.envelopeNumber || '')}</td>
            <td>${escapeHtml(d.envelopeCodeStatus || 'inactive')}</td>
            <td>${escapeHtml(d.email || '')}</td>
            <td>${escapeHtml(d.phone || '')}</td>
            <td>${d.active ? 'Active' : 'Inactive'}</td>
            <td>
              <button class="btn" type="button" data-select-donor="${escapeHtml(d.id)}">Select</button>
            </td>
          </tr>
        `).join('');
      }
      setMsg(msg, `Total donors: ${Number(data.totalDonors || 0)}. Missing addresses: ${Number(data.missingAddressCount || 0)}.`, 'help');
      if (selectedDonorId && !selectedDonor()) selectedDonorId = '';
      renderSelectedDonor();
    }

    if ($('donorSearchBtn')) $('donorSearchBtn').addEventListener('click', load);

    if (list) {
      list.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-select-donor]');
        if (!btn) return;
        selectedDonorId = String(btn.getAttribute('data-select-donor') || '');
        renderSelectedDonor();
        setMsg(envMsg, 'Donor selected for envelope administration.', 'ok');
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/finances/donors', {
            method:'POST',
            body: JSON.stringify({
              firstName: $('donorFirst').value,
              middleName: $('donorMiddle').value,
              lastName: $('donorLast').value,
              preferredName: $('donorPreferred').value,
              householdId: $('donorHousehold').value,
              mailingAddress: $('donorAddress').value,
              email: $('donorEmail').value,
              phone: $('donorPhone').value,
              envelopeNumber: $('donorEnvelope').value,
              preferredStatementDelivery: $('donorDelivery').value,
              active: true,
              statementEligible: true
            })
          });
          setMsg(msg, 'Donor profile created. Use Review before batch statement generation.', 'ok');
          form.reset();
          await load();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    async function updateEnvelopeNumber(){
      if (!selectedDonorId) {
        setMsg(envMsg, 'Select a donor first.', 'error');
        return;
      }
      try {
        const donor = selectedDonor() || {};
        await api(`/api/finances/donors/${encodeURIComponent(selectedDonorId)}`, {
          method:'PUT',
          body: JSON.stringify({
            firstName: donor.firstName,
            middleName: donor.middleName,
            lastName: donor.lastName,
            preferredName: donor.preferredName,
            householdId: donor.householdId,
            mailingAddress: donor.mailingAddress,
            email: donor.email,
            phone: donor.phone,
            preferredStatementDelivery: donor.statementDelivery,
            active: donor.active,
            statementEligible: donor.statementEligible,
            envelopeNumber: envelopeEdit ? envelopeEdit.value : ''
          })
        });
        setMsg(envMsg, 'Envelope number saved.', 'ok');
        await load();
      } catch (err) {
        setMsg(envMsg, err.message, 'error');
      }
    }

    async function envelopeCodeAction(action){
      if (!selectedDonorId) {
        setMsg(envMsg, 'Select a donor first.', 'error');
        return;
      }
      try {
        const note = envelopeReason ? envelopeReason.value : '';
        const data = await api(`/api/finances/donors/${encodeURIComponent(selectedDonorId)}/envelope-code/${action}`, {
          method:'POST',
          body: JSON.stringify({ reason: note })
        });
        setMsg(envMsg, `Envelope code ${action} successful.`, 'ok');
        if (labelPreview) labelPreview.textContent = JSON.stringify(data.envelope || {}, null, 2);
        await load();
      } catch (err) {
        setMsg(envMsg, err.message, 'error');
      }
    }

    async function printEnvelopeLabel(){
      if (!selectedDonorId) {
        setMsg(envMsg, 'Select a donor first.', 'error');
        return;
      }
      try {
        const res = await fetch(`/api/finances/donors/${encodeURIComponent(selectedDonorId)}/envelope-label?format=svg`, {
          credentials: 'include'
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(String(data?.error?.message || 'Unable to load label.'));
        }
        const svg = await res.text();
        if (labelPreview) labelPreview.innerHTML = svg;
        const popup = window.open('', '_blank', 'width=520,height=520');
        if (popup) {
          popup.document.write(`<!doctype html><html><head><title>Envelope Label</title></head><body>${svg}</body></html>`);
          popup.document.close();
          popup.focus();
          popup.print();
        }
      } catch (err) {
        setMsg(envMsg, err.message, 'error');
      }
    }

    async function loadHistory(){
      if (!selectedDonorId) {
        setMsg(historyMsg, 'Select a donor first.', 'error');
        return;
      }
      try {
        const data = await api(`/api/finances/donors/${encodeURIComponent(selectedDonorId)}/history`, { method:'GET' });
        const rows = Array.isArray(data.history) ? data.history : [];
        if (historyTable) {
          historyTable.innerHTML = rows.map((item) => `
            <tr>
              <td>${escapeHtml(item.date || '')}</td>
              <td>${escapeHtml(item.source || '')}</td>
              <td>${escapeHtml(item.fundCode || item.fundId || '')}</td>
              <td>${money(item.amountCents)}</td>
              <td>${escapeHtml(item.paymentMethod || '')}</td>
              <td>${escapeHtml(item.checkNumber || item.id || '')}</td>
            </tr>
          `).join('');
        }
        setMsg(historyMsg, `Loaded ${rows.length} giving records.`, 'ok');
      } catch (err) {
        setMsg(historyMsg, err.message, 'error');
      }
    }

    if ($('donorEnvelopeSaveBtn')) $('donorEnvelopeSaveBtn').addEventListener('click', updateEnvelopeNumber);
    if ($('donorEnvelopeIssueBtn')) $('donorEnvelopeIssueBtn').addEventListener('click', () => envelopeCodeAction('issue'));
    if ($('donorEnvelopeReplaceBtn')) $('donorEnvelopeReplaceBtn').addEventListener('click', () => envelopeCodeAction('replace'));
    if ($('donorEnvelopeDeactivateBtn')) $('donorEnvelopeDeactivateBtn').addEventListener('click', () => envelopeCodeAction('deactivate'));
    if ($('donorEnvelopePrintBtn')) $('donorEnvelopePrintBtn').addEventListener('click', printEnvelopeLabel);
    if ($('donorHistoryLoadBtn')) $('donorHistoryLoadBtn').addEventListener('click', loadHistory);

    await load();
  }

  async function initBoardReports(){
    const form = $('reportForm');
    const out = $('reportOutput');
    const msg = $('reportMsg');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/api/finances/reports/board/generate', {
          method:'POST',
          body: JSON.stringify({
            reportDate: $('reportDate').value,
            priorDate: $('reportPriorDate').value,
            liabilitiesCents: $('reportLiabilities').value,
            boardNotes: $('reportNotes').value
          })
        });
        const p = data.package;
        out.textContent = JSON.stringify(p, null, 2);
        setMsg(msg, 'Board report package generated. Review totals before distribution.', 'ok');
      } catch (err) {
        setMsg(msg, err.message, 'error');
      }
    });
  }

  async function initControls(){
    const msg = $('controlsMsg');
    const dash = $('controlsDash');
    const batchForm = $('collectionBatchForm');
    const countersForm = $('collectionCountersForm');
    const entryForm = $('collectionEntryForm');
    const looseForm = $('collectionLooseForm');
    const depositForm = $('collectionDepositForm');
    const entryTable = $('collectionEntryTable');
    const looseState = $('collectionLooseState');
    const counterState = $('collectionCounterState');
    const donorConfirm = $('collectionDonorConfirm');
    const allocContainer = $('collectionAllocations');
    const allocTotal = $('collectionAllocationTotals');
    const dupWarn = $('collectionDuplicateWarning');

    const state = {
      batchId: '',
      funds: [],
      donor: null,
      duplicateEntryId: '',
      scanStream: null,
      scanActive: false,
      scanRafId: 0
    };

    function currentBatchId(){
      return String(state.batchId || '').trim();
    }

    function ensureBatch(){
      if (!currentBatchId()) {
        setMsg(msg, 'Select or create a collection batch first.', 'error');
        return false;
      }
      return true;
    }

    function fundOptions(selectedValue){
      const opts = state.funds.map((f) => {
        const label = `${f.fundName}${f.fundCode ? ` (${f.fundCode})` : ''}`;
        const selected = String(f.id) === String(selectedValue || '') ? ' selected' : '';
        return `<option value="${escapeHtml(f.id)}"${selected}>${escapeHtml(label)}</option>`;
      }).join('');
      return `<option value="">Select fund</option>${opts}`;
    }

    function renderAllocations(seed){
      const items = Array.isArray(seed) && seed.length ? seed : [{ fundId: '', amountCents: 0, note: '' }];
      if (!allocContainer) return;
      allocContainer.innerHTML = items.map((item, idx) => `
        <div class="stackListRow" data-alloc-row="${idx}">
          <label class="label">Fund
            <select class="select" data-alloc-field="fundId">${fundOptions(item.fundId)}</select>
          </label>
          <label class="label">Amount
            <input class="input" data-alloc-field="amount" type="number" min="0.01" step="0.01" value="${escapeHtml(centsToInput(item.amountCents || 0))}" />
          </label>
          <button class="btn" type="button" data-remove-alloc="${idx}">Remove</button>
          <label class="label" style="grid-column:1/-1">Note
            <input class="input" data-alloc-field="note" value="${escapeHtml(item.note || '')}" />
          </label>
        </div>
      `).join('');
      updateAllocationTotals();
    }

    function readAllocations(){
      const rows = Array.from((allocContainer && allocContainer.querySelectorAll('[data-alloc-row]')) || []);
      const allocations = [];
      let sum = 0;
      for (const row of rows) {
        const fundId = String(row.querySelector('[data-alloc-field="fundId"]')?.value || '').trim();
        const amount = amountToCents(row.querySelector('[data-alloc-field="amount"]')?.value || '');
        const note = String(row.querySelector('[data-alloc-field="note"]')?.value || '').trim();
        if (!fundId || !Number.isInteger(amount) || amount <= 0) continue;
        allocations.push({ fundId, amountCents: amount, note });
        sum += amount;
      }
      return { allocations, sum };
    }

    function updateAllocationTotals(){
      if (!allocTotal) return;
      const envelopeCents = amountToCents($('collectionAmount')?.value || '');
      const { sum } = readAllocations();
      const diff = (Number.isFinite(envelopeCents) ? envelopeCents : 0) - sum;
      allocTotal.textContent = `Allocation total: ${money(sum)}. Envelope total: ${money(Number.isFinite(envelopeCents) ? envelopeCents : 0)}. Difference: ${money(diff)}.`;
    }

    function clearEntryForNext(){
      state.donor = null;
      state.duplicateEntryId = '';
      if (dupWarn) dupWarn.hidden = true;
      if (donorConfirm) donorConfirm.innerHTML = '<strong>No donor resolved.</strong>';
      if ($('collectionScannerInput')) $('collectionScannerInput').value = '';
      if ($('collectionCheckNumber')) $('collectionCheckNumber').value = '';
      if ($('collectionAmount')) $('collectionAmount').value = '';
      renderAllocations([{ fundId: '', amountCents: 0, note: '' }]);
      if ($('collectionScannerInput')) $('collectionScannerInput').focus();
    }

    function renderBatchDetails(detail){
      if (!detail) return;
      const batch = detail.batch || {};

      if ($('collectionDate')) $('collectionDate').value = batch.serviceDate || '';
      if ($('collectionServiceName')) $('collectionServiceName').value = batch.serviceName || '';
      if ($('collectionDeclaredCash')) $('collectionDeclaredCash').value = centsToInput(batch.declaredPhysicalCashCents || 0);
      if ($('collectionDeclaredChecks')) $('collectionDeclaredChecks').value = centsToInput(batch.declaredCheckCents || 0);
      if ($('collectionAttachment')) $('collectionAttachment').value = batch.countSheetAttachmentRef || '';

      if ($('collectionCounters')) {
        $('collectionCounters').value = (detail.counters || []).map((c) => c.counterEmail).join(', ');
      }

      if (entryTable) {
        entryTable.innerHTML = (detail.entries || []).map((e) => {
          const allocationSummary = (e.allocations || []).map((a) => `${a.fundCode || a.fundId}: ${money(a.amountCents)}`).join('; ');
          const identifyAction = e.transactionKind === 'one_time'
            ? `<button class="btn" type="button" data-identify-entry="${escapeHtml(e.id)}">Identify Donor</button>`
            : '';
          return `
            <tr>
              <td>${escapeHtml(e.donorDisplayName || '')}</td>
              <td>${escapeHtml(e.envelopeNumberSnapshot || '')}</td>
              <td>${escapeHtml(e.paymentMethod || '')}</td>
              <td>${money(e.envelopeTotalCents)}</td>
              <td>${escapeHtml(allocationSummary)}</td>
              <td>${escapeHtml(e.createdAt || '')}<div class="btnRow">${identifyAction}</div></td>
            </tr>
          `;
        }).join('');
      }

      if (looseState) {
        looseState.textContent = JSON.stringify(detail.looseGiving || [], null, 2);
      }
      if (counterState) {
        counterState.textContent = JSON.stringify({
          counters: detail.counters || [],
          approvals: detail.approvals || [],
          status: batch.status,
          approvalVersion: batch.approvalVersion
        }, null, 2);
      }
      if (dash) {
        dash.textContent = JSON.stringify({ batch, reconciliation: detail.reconciliation || {} }, null, 2);
      }
    }

    async function loadFunds(){
      const data = await api('/api/finances/funds', { method:'GET' });
      state.funds = Array.isArray(data.funds) ? data.funds : [];
      renderAllocations();
      if ($('collectionLooseFund')) {
        $('collectionLooseFund').innerHTML = fundOptions('');
      }
    }

    async function loadBatches(){
      const data = await api('/api/finances/collections', { method:'GET' });
      const select = $('collectionBatchSelect');
      if (!select) return;
      const batches = Array.isArray(data.batches) ? data.batches : [];
      select.innerHTML = `<option value="">Start new batch</option>` + batches.map((b) => {
        const label = `${b.serviceDate} ${b.serviceName ? `- ${b.serviceName}` : ''} (${b.status})`;
        const selected = state.batchId === b.id ? ' selected' : '';
        return `<option value="${escapeHtml(b.id)}"${selected}>${escapeHtml(label)}</option>`;
      }).join('');
    }

    async function loadCurrentBatch(){
      if (!currentBatchId()) {
        if (dash) dash.textContent = 'Select a batch to view reconciliation.';
        return;
      }
      const detail = await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}`, { method:'GET' });
      renderBatchDetails(detail);
    }

    async function resolveEnvelope(){
      if (!ensureBatch()) return;
      const code = String($('collectionScannerInput')?.value || '').trim();
      if (!code) {
        setMsg(msg, 'Scan or enter an envelope code first.', 'error');
        return;
      }

      try {
        const data = await api('/api/finances/collections/resolve-envelope', {
          method:'POST',
          body: JSON.stringify({ envelopeCode: code, batchId: currentBatchId() })
        });
        state.donor = data.donor || null;
        state.duplicateEntryId = data?.duplicateEntry?.entryId || '';
        if (dupWarn) dupWarn.hidden = !state.duplicateEntryId;
        if (donorConfirm && state.donor) {
          donorConfirm.innerHTML = `
            <strong>Resolved:</strong> ${escapeHtml(state.donor.displayName || '')}<br />
            Envelope #: ${escapeHtml(state.donor.envelopeNumber || '')}<br />
            Status: ${escapeHtml(state.donor.envelopeCodeStatus || '')}
          `;
        }
        setMsg(msg, state.duplicateEntryId ? 'Duplicate envelope found in this batch. Confirm before updating.' : 'Envelope resolved. Enter allocations and save.', state.duplicateEntryId ? 'warn' : 'ok');
      } catch (err) {
        state.donor = null;
        state.duplicateEntryId = '';
        if (dupWarn) dupWarn.hidden = true;
        if (donorConfirm) donorConfirm.innerHTML = '<strong>No donor resolved.</strong>';
        setMsg(msg, err.message, 'error');
      }
    }

    async function saveEnvelopeEntry(opts){
      if (!ensureBatch()) return;
      if (!state.donor) {
        setMsg(msg, 'Resolve an envelope code before saving.', 'error');
        return;
      }

      const envelopeTotalCents = amountToCents($('collectionAmount')?.value || '');
      if (!Number.isInteger(envelopeTotalCents) || envelopeTotalCents <= 0) {
        setMsg(msg, 'Envelope total must be greater than zero.', 'error');
        return;
      }

      const read = readAllocations();
      if (!read.allocations.length) {
        setMsg(msg, 'At least one valid allocation is required.', 'error');
        return;
      }
      if (read.sum !== envelopeTotalCents) {
        setMsg(msg, 'Allocation totals must exactly equal the envelope total.', 'error');
        return;
      }

      if (state.duplicateEntryId && !opts.allowUpdateDuplicate) {
        setMsg(msg, 'Duplicate envelope detected. Use Update Existing Entry after confirming records.', 'error');
        return;
      }

      if (opts.allowUpdateDuplicate && state.duplicateEntryId) {
        const confirmed = window.confirm('This envelope already exists in the selected batch. Replace the existing entry?');
        if (!confirmed) return;
      }

      try {
        await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/envelopes`, {
          method:'POST',
          body: JSON.stringify({
            entryId: opts.allowUpdateDuplicate ? state.duplicateEntryId : '',
            envelopeCode: $('collectionScannerInput').value,
            paymentMethod: $('collectionPaymentMethod').value,
            checkNumber: $('collectionCheckNumber').value,
            envelopeTotalCents,
            allocations: read.allocations
          })
        });
        setMsg(msg, 'Envelope entry saved. Ready for next scan.', 'ok');
        await loadCurrentBatch();
        clearEntryForNext();
      } catch (err) {
        const duplicateId = err?.payload?.error?.details?.existingEntryId;
        if (duplicateId) {
          state.duplicateEntryId = duplicateId;
          if (dupWarn) dupWarn.hidden = false;
        }
        setMsg(msg, err.message, 'error');
      }
    }

    async function addLooseGiving(){
      if (!ensureBatch()) return;
      const amountCents = amountToCents($('collectionLooseAmount')?.value || '');
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        setMsg(msg, 'Loose giving amount must be greater than zero.', 'error');
        return;
      }
      try {
        await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/loose-giving`, {
          method:'POST',
          body: JSON.stringify({
            fundId: $('collectionLooseFund').value,
            paymentMethod: $('collectionLooseMethod').value,
            amountCents,
            note: $('collectionLooseNote').value
          })
        });
        setMsg(msg, 'Loose giving added.', 'ok');
        if (looseForm) looseForm.reset();
        await loadCurrentBatch();
      } catch (err) {
        setMsg(msg, err.message, 'error');
      }
    }

    async function startCameraScan(){
      const video = $('collectionCameraVideo');
      const wrap = $('collectionCameraWrap');
      const input = $('collectionScannerInput');
      if (!video || !wrap || !input) return;

      if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
        setMsg(msg, 'Camera scanning is not available in this browser. USB/Bluetooth scanner input still works.', 'warn');
        return;
      }

      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        state.scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = state.scanStream;
        wrap.hidden = false;
        state.scanActive = true;

        const tick = async () => {
          if (!state.scanActive) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) {
              const text = String(codes[0].rawValue || '').trim();
              if (text) {
                input.value = text;
                await resolveEnvelope();
                stopCameraScan();
                return;
              }
            }
          } catch {
            // keep scanning quietly
          }
          state.scanRafId = window.requestAnimationFrame(tick);
        };

        state.scanRafId = window.requestAnimationFrame(tick);
      } catch (err) {
        setMsg(msg, err.message || 'Unable to start camera scan.', 'error');
      }
    }

    function stopCameraScan(){
      state.scanActive = false;
      if (state.scanRafId) {
        window.cancelAnimationFrame(state.scanRafId);
        state.scanRafId = 0;
      }
      if (state.scanStream) {
        for (const track of state.scanStream.getTracks()) track.stop();
        state.scanStream = null;
      }
      const video = $('collectionCameraVideo');
      const wrap = $('collectionCameraWrap');
      if (video) video.srcObject = null;
      if (wrap) wrap.hidden = true;
    }

    if ($('collectionBatchSelect')) {
      $('collectionBatchSelect').addEventListener('change', async (e) => {
        state.batchId = String(e.target.value || '');
        clearEntryForNext();
        await loadCurrentBatch();
      });
    }

    if (batchForm) {
      batchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          if (!currentBatchId()) {
            const created = await api('/api/finances/collections', {
              method:'POST',
              body: JSON.stringify({
                serviceDate: $('collectionDate').value,
                serviceName: $('collectionServiceName').value,
                declaredPhysicalCashCents: amountToCents($('collectionDeclaredCash').value || '0'),
                declaredCheckCents: amountToCents($('collectionDeclaredChecks').value || '0'),
                countSheetAttachmentRef: $('collectionAttachment').value
              })
            });
            state.batchId = created.batchId;
            setMsg(msg, 'Collection batch created.', 'ok');
          } else {
            await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}`, {
              method:'PUT',
              body: JSON.stringify({
                serviceDate: $('collectionDate').value,
                serviceName: $('collectionServiceName').value,
                declaredPhysicalCashCents: amountToCents($('collectionDeclaredCash').value || '0'),
                declaredCheckCents: amountToCents($('collectionDeclaredChecks').value || '0'),
                countSheetAttachmentRef: $('collectionAttachment').value
              })
            });
            setMsg(msg, 'Batch details updated.', 'ok');
          }
          await loadBatches();
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if ($('collectionStartBtn')) {
      $('collectionStartBtn').addEventListener('click', async () => {
        if (!ensureBatch()) return;
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/start`, { method:'POST', body: JSON.stringify({}) });
          setMsg(msg, 'Batch is now in counting mode.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if ($('collectionRefreshBtn')) {
      $('collectionRefreshBtn').addEventListener('click', async () => {
        try {
          await loadBatches();
          await loadCurrentBatch();
          setMsg(msg, 'Batch data refreshed.', 'help');
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (countersForm) {
      countersForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!ensureBatch()) return;
        try {
          const emails = String($('collectionCounters').value || '').split(',').map((x) => x.trim()).filter(Boolean);
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/counters`, {
            method:'POST',
            body: JSON.stringify({ counterEmails: emails })
          });
          setMsg(msg, 'Counter assignments saved.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (entryForm) {
      entryForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveEnvelopeEntry({ allowUpdateDuplicate: false });
      });
    }

    if ($('collectionResolveBtn')) $('collectionResolveBtn').addEventListener('click', resolveEnvelope);
    if ($('collectionUpdateBtn')) $('collectionUpdateBtn').addEventListener('click', () => saveEnvelopeEntry({ allowUpdateDuplicate: true }));
    if ($('collectionAddAllocationBtn')) {
      $('collectionAddAllocationBtn').addEventListener('click', () => {
        const existing = readAllocations().allocations;
        existing.push({ fundId: '', amountCents: 0, note: '' });
        renderAllocations(existing);
      });
    }
    if (allocContainer) {
      allocContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-remove-alloc]');
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-remove-alloc'));
        const current = readAllocations().allocations;
        current.splice(idx, 1);
        renderAllocations(current.length ? current : [{ fundId: '', amountCents: 0, note: '' }]);
      });
      allocContainer.addEventListener('input', updateAllocationTotals);
      allocContainer.addEventListener('change', updateAllocationTotals);
    }

    if ($('collectionScannerInput')) {
      $('collectionScannerInput').addEventListener('keydown', async (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          await resolveEnvelope();
        }
      });
    }

    if ($('collectionAmount')) $('collectionAmount').addEventListener('input', updateAllocationTotals);
    if ($('collectionCameraBtn')) $('collectionCameraBtn').addEventListener('click', startCameraScan);
    if ($('collectionCameraStopBtn')) $('collectionCameraStopBtn').addEventListener('click', stopCameraScan);

    if (entryTable) {
      entryTable.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-identify-entry]');
        if (!btn) return;
        const entryId = String(btn.getAttribute('data-identify-entry') || '');
        if (!entryId) return;
        const accountNumber = window.prompt('Enter the donor account number if known:', '') || '';
        const donorName = window.prompt('If no account number is available, enter the exact donor name:', '') || '';
        if (!accountNumber.trim() && !donorName.trim()) return;
        try {
          await api(`/api/finances/scans/entries/${encodeURIComponent(entryId)}/identify`, {
            method:'POST',
            body: JSON.stringify({ accountNumber, donorName })
          });
          setMsg(msg, 'Entry donor identified and reassigned.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (looseForm) {
      looseForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await addLooseGiving();
      });
    }

    if ($('collectionApproveBtn')) {
      $('collectionApproveBtn').addEventListener('click', async () => {
        if (!ensureBatch()) return;
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/approvals`, {
            method:'POST',
            body: JSON.stringify({})
          });
          setMsg(msg, 'Approval submitted.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if ($('collectionFinalizeBtn')) {
      $('collectionFinalizeBtn').addEventListener('click', async () => {
        if (!ensureBatch()) return;
        const explanation = window.prompt('Discrepancy explanation (leave blank if no discrepancy):', '') || '';
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/finalize`, {
            method:'POST',
            body: JSON.stringify({ discrepancyExplanation: explanation })
          });
          setMsg(msg, 'Batch finalized and verified.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (depositForm) {
      depositForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!ensureBatch()) return;
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/deposit`, {
            method:'POST',
            body: JSON.stringify({
              depositDate: $('collectionDepositDate').value,
              depositedAmountCents: amountToCents($('collectionDepositAmount').value || ''),
              depositReference: $('collectionDepositRef').value,
              internalControlException: $('collectionDepositException').value
            })
          });
          setMsg(msg, 'Deposit confirmed.', 'ok');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if ($('collectionReopenBtn')) {
      $('collectionReopenBtn').addEventListener('click', async () => {
        if (!ensureBatch()) return;
        const reason = window.prompt('Reason for reopening this batch:', '') || '';
        if (!reason.trim()) return;
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/reopen`, {
            method:'POST',
            body: JSON.stringify({ reason })
          });
          setMsg(msg, 'Batch reopened. Counter approvals were reset.', 'warn');
          await loadCurrentBatch();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if ($('collectionVoidBtn')) {
      $('collectionVoidBtn').addEventListener('click', async () => {
        if (!ensureBatch()) return;
        const reason = window.prompt('Reason for voiding this batch:', '') || '';
        if (!reason.trim()) return;
        const confirmed = window.confirm('Void this batch? This action is audited and cannot be undone without reopen controls.');
        if (!confirmed) return;
        try {
          await api(`/api/finances/collections/${encodeURIComponent(currentBatchId())}/void`, {
            method:'POST',
            body: JSON.stringify({ reason })
          });
          setMsg(msg, 'Batch voided.', 'warn');
          await loadCurrentBatch();
          await loadBatches();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    renderAllocations();
    await loadFunds();
    await loadBatches();
    await loadCurrentBatch();
    clearEntryForNext();

    async function load(){
      const data = await api('/api/finances/controls/dashboard', { method:'GET' });
      dash.textContent = JSON.stringify(data.dashboard, null, 2);
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/finances/controls/collections', {
            method:'POST',
            body: JSON.stringify({
              serviceDate: $('collectionDate').value,
              amount: $('collectionAmount').value,
              counters: String($('collectionCounters').value || '').split(',').map((x) => x.trim()).filter(Boolean),
              attachment: $('collectionAttachment').value
            })
          });
          setMsg(msg, 'Collection saved. Complete verification before posting.', 'ok');
          form.reset();
          await load();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    await load();
  }

  async function initHousing(){
    const msg = $('housingMsg');
    const form = $('housingProfileForm');
    const annualForm = $('housingAnnualForm');
    const list = $('housingProfiles');
    let profiles = [];

    async function load(){
      const data = await api('/api/finances/clergy-housing', { method:'GET' });
      profiles = Array.isArray(data.profiles) ? data.profiles : [];
      if (list) {
        list.innerHTML = profiles.map((p) => `<option value="${p.id}">${p.ministerName} (${p.compensationYear || 'Year not set'})</option>`).join('');
      }
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/finances/clergy-housing/profiles', {
            method:'POST',
            body: JSON.stringify({
              ministerName: $('ministerName').value,
              positionTitle: $('ministerTitle').value,
              ordinationStatus: $('ministerOrdination').value,
              compensationYear: $('ministerYear').value,
              totalCompensation: $('ministerComp').value,
              salaryAmount: $('ministerSalary').value,
              housingAllowanceDesignatedAmount: $('ministerAllowance').value,
              designationEffectiveDate: $('ministerEffective').value,
              dateApproved: $('ministerApproved').value,
              approvingBody: $('ministerBody').value,
              resolutionAttachment: $('ministerResolution').value,
              notes: $('ministerNotes').value
            })
          });
          setMsg(msg, 'Housing profile saved. Keep board resolution documents attached.', 'ok');
          form.reset();
          await load();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    if (annualForm) {
      annualForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/finances/clergy-housing/annual-records', {
            method:'POST',
            body: JSON.stringify({
              profileId: $('housingProfiles').value,
              compensationYear: $('annualYear').value,
              designatedAmount: $('annualDesignated').value,
              amountPaid: $('annualPaid').value,
              actualHousingExpenses: $('annualActual').value,
              fairRentalValue: $('annualFairRental').value,
              utilities: $('annualUtilities').value,
              notes: $('annualNotes').value
            })
          });
          setMsg(msg, 'Annual housing record saved for review.', 'ok');
          annualForm.reset();
        } catch (err) {
          setMsg(msg, err.message, 'error');
        }
      });
    }

    await load();
  }

  (async () => {
    try {
      if (page === 'funds') await initFunds();
      if (page === 'donors') await initDonors();
      if (page === 'reports') await initBoardReports();
      if (page === 'controls') await initControls();
      if (page === 'housing') await initHousing();
    } catch (err) {
      const sink = $('pageError');
      if (sink) sink.textContent = err.message || 'Unable to load this page.';
    }
  })();
})();
