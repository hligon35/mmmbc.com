(function(){
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    csrf: '',
    donors: [],
    selectedDonorId: '',
    selectedCode: '',
    oneTimeCode: '',
    backgroundDataUrl: ''
  };

  const SIZES = {
    a2: { width: 4.375, height: 5.75 },
    a7: { width: 5.25, height: 7.25 },
    a9: { width: 5.75, height: 8.75 },
    '10': { width: 4.125, height: 9.5 }
  };

  async function fetchCsrf(){
    if (state.csrf) return state.csrf;
    const res = await fetch('/api/csrf', { credentials:'include' });
    if (!res.ok) throw new Error('Sign in is required.');
    const data = await res.json().catch(() => ({}));
    state.csrf = String(data.csrfToken || '');
    return state.csrf;
  }

  async function api(url, options){
    const opts = options || {};
    const method = String(opts.method || 'GET').toUpperCase();
    const headers = Object.assign({ 'content-type':'application/json' }, opts.headers || {});
    if (!['GET','HEAD'].includes(method)) headers['X-CSRF-Token'] = await fetchCsrf();
    const res = await fetch(url, Object.assign({}, opts, { method, headers, credentials:'include' }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = typeof data?.error === 'string' ? data.error : String(data?.error?.message || 'Request failed.');
      throw new Error(msg);
    }
    return data;
  }

  function setMsg(text, kind){
    const el = $('envelopeDesignerMsg');
    if (!el) return;
    el.className = kind || 'help';
    el.textContent = String(text || '');
  }

  function selectedDonor(){
    return state.donors.find((donor) => String(donor.id) === state.selectedDonorId) || null;
  }

  function selectedCodeValue(){
    return state.selectedCode || state.oneTimeCode || '';
  }

  async function fetchQrSvg(codeValue){
    if (!codeValue) return '';
    const res = await fetch(`/api/finances/scan-codes/render?code=${encodeURIComponent(codeValue)}`, { credentials:'include' });
    if (!res.ok) return '';
    return res.text();
  }

  function renderResults(){
    const body = $('envelopeDesignerResults');
    if (!body) return;
    body.innerHTML = state.donors.map((donor) => `
      <tr>
        <td>${donor.firstName} ${donor.lastName}</td>
        <td>${donor.accountNumber || ''}</td>
        <td>${donor.envelopeNumber || ''}</td>
        <td>${donor.envelopeCodeStatus || 'inactive'}</td>
        <td><button class="btn" type="button" data-select-donor="${donor.id}">Select</button></td>
      </tr>
    `).join('');
  }

  async function renderPreview(){
    const preview = $('envelopeDesignerPreview');
    if (!preview) return;
    const donor = selectedDonor();
    const sizeKey = $('envelopeDesignerSize')?.value || 'a2';
    const size = SIZES[sizeKey] || SIZES.a2;
    const opacity = Math.max(0, Math.min(100, Number($('envelopeDesignerOpacity')?.value || 0))) / 100;
    const codeValue = selectedCodeValue();
    const qrSvg = await fetchQrSvg(codeValue);
    const heading = $('envelopeDesignerHeading')?.value || 'Mt. Moriah Missionary Baptist Church';
    const message = $('envelopeDesignerMessage')?.value || '';
    const background = state.backgroundDataUrl
      ? `<img src="${state.backgroundDataUrl}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:${opacity};" />`
      : '';
    const donorName = donor ? `${donor.firstName} ${donor.lastName}` : 'Blank One-Time Envelope';
    const accountNumber = donor?.accountNumber || '';
    const envelopeNumber = donor?.envelopeNumber || '';

    preview.innerHTML = `
      <div class="envelopePreview" style="position:relative;aspect-ratio:${size.width}/${size.height};max-width:100%;background:#fff;color:#111;border:1px solid rgba(0,0,0,.2);overflow:hidden;padding:22px;">
        ${background}
        <div style="position:relative;z-index:1;display:grid;grid-template-columns:1.4fr 1fr;gap:18px;height:100%;align-items:start;">
          <div style="display:grid;gap:12px;align-content:start;">
            <div style="font-size:1.05rem;font-weight:900;letter-spacing:.02em;">${heading}</div>
            <div style="font-size:.95rem;line-height:1.45;white-space:pre-wrap;">${message}</div>
            <div><strong>Name:</strong> ${donorName}</div>
            <div><strong>Account #:</strong> ${accountNumber || 'Not assigned'}</div>
            <div><strong>Envelope #:</strong> ${envelopeNumber || 'Not assigned'}</div>
            <div style="display:grid;gap:8px;margin-top:auto;">
              <div>___________________ Tithe</div>
              <div>___________________ Offering</div>
              <div>___________________ Other</div>
            </div>
          </div>
          <div style="display:grid;gap:10px;justify-items:center;align-content:start;">
            <div style="width:100%;max-width:200px;background:#fff;border:1px solid rgba(0,0,0,.12);padding:10px;">${qrSvg || '<div style="min-height:180px;display:grid;place-items:center;">Issue or select a code</div>'}</div>
            <div style="font-size:.8rem;text-align:center;word-break:break-all;">${codeValue || 'No QR code selected'}</div>
          </div>
        </div>
      </div>
    `;
  }

  async function searchDonors(){
    try {
      const q = encodeURIComponent(String($('envelopeDesignerSearch')?.value || '').trim());
      const data = await api(`/api/finances/donors?q=${q}`, { method:'GET' });
      state.donors = Array.isArray(data.donors) ? data.donors : [];
      renderResults();
      setMsg(`Loaded ${state.donors.length} donor result(s).`, 'ok');
    } catch (error) {
      setMsg(error.message, 'error');
    }
  }

  async function ensureMemberCode(){
    const donor = selectedDonor();
    if (!donor) {
      setMsg('Select a donor first.', 'error');
      return;
    }
    try {
      if (donor.envelopeCodeStatus === 'active' && donor.envelopeCode) {
        state.selectedCode = donor.envelopeCode;
      } else {
        const data = await api(`/api/finances/donors/${encodeURIComponent(donor.id)}/envelope-code/issue`, {
          method:'POST',
          body: JSON.stringify({ reason: 'Envelope designer issue/reuse request.' })
        });
        state.selectedCode = String(data?.envelope?.envelopeCode || '');
        donor.envelopeCodeStatus = 'active';
      }
      state.oneTimeCode = '';
      setMsg('Member code ready for preview and printing.', 'ok');
      await searchDonors();
      await renderPreview();
    } catch (error) {
      setMsg(error.message, 'error');
    }
  }

  async function createOneTimeCode(){
    try {
      const data = await api('/api/finances/scan-codes/one-time', {
        method:'POST',
        body: JSON.stringify({ note: 'Envelope designer generated reusable one-time donor code.' })
      });
      state.oneTimeCode = String(data?.code?.codeValue || '');
      state.selectedCode = '';
      $('envelopeDesignerSelected').value = 'Reusable one-time donor envelope';
      setMsg('Reusable one-time donor code created.', 'ok');
      await renderPreview();
    } catch (error) {
      setMsg(error.message, 'error');
    }
  }

  function printPreview(){
    const html = $('envelopeDesignerPreview')?.innerHTML || '';
    if (!html) {
      setMsg('Create a preview before printing.', 'error');
      return;
    }
    const popup = window.open('', '_blank', 'width=1100,height=850');
    if (!popup) {
      setMsg('Allow popups to print the envelope preview.', 'error');
      return;
    }
    popup.document.write(`<!doctype html><html><head><title>Envelope Print Preview</title><style>body{margin:0;padding:0}main{padding:0}.envelopePreview{box-shadow:none;border:0 !important;margin:0 auto}button,.topBar,.panel h2{display:none !important}@page{margin:.25in}</style></head><body><main>${html}</main></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function bind(){
    $('envelopeDesignerSearchBtn')?.addEventListener('click', searchDonors);
    $('envelopeDesignerSearch')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      searchDonors();
    });
    $('envelopeDesignerIssueCodeBtn')?.addEventListener('click', ensureMemberCode);
    $('envelopeDesignerOneTimeBtn')?.addEventListener('click', createOneTimeCode);
    $('envelopeDesignerPrintBtn')?.addEventListener('click', printPreview);
    $('envelopeDesignerResults')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-select-donor]');
      if (!btn) return;
      state.selectedDonorId = String(btn.getAttribute('data-select-donor') || '');
      state.oneTimeCode = '';
      const donor = selectedDonor();
      $('envelopeDesignerSelected').value = donor ? `${donor.firstName} ${donor.lastName} (${donor.accountNumber || donor.id})` : '';
      state.selectedCode = String(donor?.envelopeCode || '');
      await renderPreview();
    });
    $('envelopeDesignerBackground')?.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      if (!file) {
        state.backgroundDataUrl = '';
        await renderPreview();
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        state.backgroundDataUrl = String(reader.result || '');
        await renderPreview();
      };
      reader.readAsDataURL(file);
    });
    for (const id of ['envelopeDesignerSize', 'envelopeDesignerHeading', 'envelopeDesignerMessage', 'envelopeDesignerOpacity']) {
      $(id)?.addEventListener('input', () => renderPreview());
      $(id)?.addEventListener('change', () => renderPreview());
    }
  }

  (async function init(){
    bind();
    try {
      await searchDonors();
      await renderPreview();
    } catch (error) {
      setMsg(error.message || 'Unable to initialize the envelope designer.', 'error');
    }
  })();
})();