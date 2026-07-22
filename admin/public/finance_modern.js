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
    if (!res.ok) throw new Error(String(data.error || 'Request failed.'));
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

    async function load(){
      const q = encodeURIComponent(String(($('donorSearch')?.value || '')).trim());
      const data = await api(`/api/finances/donors?q=${q}`, { method:'GET' });
      if (list) {
        list.innerHTML = (data.donors || []).map((d) => `
          <tr>
            <td>${d.firstName} ${d.lastName}</td>
            <td>${d.householdId || ''}</td>
            <td>${d.envelopeNumber || ''}</td>
            <td>${d.email || ''}</td>
            <td>${d.phone || ''}</td>
            <td>${d.active ? 'Active' : 'Inactive'}</td>
          </tr>
        `).join('');
      }
      setMsg(msg, `Total donors: ${Number(data.totalDonors || 0)}. Missing addresses: ${Number(data.missingAddressCount || 0)}.`, 'help');
    }

    if ($('donorSearchBtn')) $('donorSearchBtn').addEventListener('click', load);

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
    const form = $('collectionForm');

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
