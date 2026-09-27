(function(){
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    csrf: '',
    funds: [],
    resolved: null,
    batchId: '',
    detector: null,
    stream: null,
    rafId: 0,
    scanning: false
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

  function setStatus(text, kind){
    const el = $('scanStatus');
    if (!el) return;
    el.className = `scanStatus${kind ? ` scanStatus--${kind}` : ''}`;
    el.textContent = String(text || '');
  }

  function money(cents){
    return new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(Number(cents || 0) / 100);
  }

  function amountToCents(value){
    const num = Number(String(value || '').trim());
    if (!Number.isFinite(num)) return NaN;
    return Math.round(num * 100);
  }

  function renderSummary(){
    const box = $('scanDonorSummary');
    if (!box) return;
    if (!state.resolved) {
      box.textContent = 'No code resolved yet.';
      return;
    }
    const donor = state.resolved.code?.donor;
    if (state.resolved.code?.codeFamily === 'one_time') {
      box.innerHTML = `One-time donor code validated.<br />Batch: ${state.batchId || 'pending'}<br />Enter account number or exact donor name only if the donor should be linked now.`;
      return;
    }
    box.innerHTML = `Registered member code validated.<br />Donor: ${String(donor?.displayName || 'Unknown')}<br />Account #: ${String(donor?.accountNumber || 'Not set')}<br />Envelope #: ${String(donor?.envelopeNumber || 'Not set')}<br />Batch: ${state.batchId || 'pending'}`;
  }

  function populateFunds(){
    const select = $('scanFund');
    if (!select) return;
    const options = ['<option value="">Select fund</option>'].concat(state.funds.map((fund) => {
      const label = `${fund.fundName}${fund.fundCode ? ` (${fund.fundCode})` : ''}`;
      return `<option value="${String(fund.id)}">${label}</option>`;
    }));
    select.innerHTML = options.join('');
  }

  async function loadFunds(){
    const data = await api('/api/finances/funds', { method:'GET' });
    state.funds = Array.isArray(data.funds) ? data.funds : [];
    populateFunds();
  }

  async function resolveCodeValue(codeValue){
    const trimmed = String(codeValue || '').trim();
    if (!trimmed) {
      setStatus('Enter or scan a QR code first.', 'error');
      return;
    }
    try {
      const data = await api('/api/finances/scans/resolve', {
        method:'POST',
        body: JSON.stringify({ codeValue: trimmed })
      });
      state.resolved = data;
      state.batchId = String(data.batchId || '');
      renderSummary();
      setStatus(data.duplicateEntry ? 'Code validated. This registered envelope is already in the current batch.' : 'Code validated. Complete the gift details and save.', data.duplicateEntry ? 'warn' : 'ok');
      $('scanAmount')?.focus();
    } catch (error) {
      state.resolved = null;
      renderSummary();
      setStatus(error.message, 'error');
    }
  }

  function stopCamera(){
    state.scanning = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    const video = $('scanCamera');
    if (video) video.srcObject = null;
  }

  async function tickCamera(){
    if (!state.scanning || !state.detector) return;
    try {
      const results = await state.detector.detect($('scanCamera'));
      if (results && results.length) {
        const text = String(results[0].rawValue || '').trim();
        if (text) {
          $('scanCodeInput').value = text;
          stopCamera();
          await resolveCodeValue(text);
          return;
        }
      }
    } catch {
      // keep polling quietly
    }
    state.rafId = requestAnimationFrame(tickCamera);
  }

  async function startCamera(){
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      setStatus('Camera scanning is unavailable in this browser. Use keyboard-scanner input or manual entry.', 'warn');
      return;
    }
    stopCamera();
    try {
      state.detector = new window.BarcodeDetector({ formats:['qr_code'] });
      state.stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' } }, audio:false });
      const video = $('scanCamera');
      if (!video) return;
      video.srcObject = state.stream;
      state.scanning = true;
      setStatus('Camera started. Hold the QR code inside the frame.', 'ok');
      state.rafId = requestAnimationFrame(tickCamera);
    } catch (error) {
      stopCamera();
      setStatus(error.message || 'Unable to start the camera.', 'error');
    }
  }

  async function saveGift(event){
    event.preventDefault();
    if (!state.resolved?.code?.codeValue) {
      setStatus('Validate a QR code before saving a gift.', 'error');
      return;
    }
    const amountCents = amountToCents($('scanAmount')?.value || '');
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      setStatus('Enter a gift amount greater than $0.00.', 'error');
      return;
    }
    try {
      const result = await api('/api/finances/scans/record', {
        method:'POST',
        body: JSON.stringify({
          codeValue: state.resolved.code.codeValue,
          accountNumber: $('scanAccountNumber')?.value || '',
          donorName: $('scanDonorName')?.value || '',
          fundId: $('scanFund')?.value || '',
          amountCents,
          paymentMethod: $('scanPaymentMethod')?.value || 'cash',
          checkNumber: $('scanCheckNumber')?.value || '',
          note: $('scanNote')?.value || ''
        })
      });
      setStatus(`Saved ${money(amountCents)} to the current batch. Ready for the next scan.`, 'ok');
      state.batchId = String(result.batchId || state.batchId || '');
      state.resolved = null;
      renderSummary();
      $('scanGiftForm')?.reset();
      $('scanCodeInput').value = '';
      $('scanCodeInput').focus();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function bind(){
    $('scanResolveForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await resolveCodeValue($('scanCodeInput')?.value || '');
    });
    $('scanCodeInput')?.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      await resolveCodeValue($('scanCodeInput')?.value || '');
    });
    $('scanStartCameraBtn')?.addEventListener('click', startCamera);
    $('scanStopCameraBtn')?.addEventListener('click', stopCamera);
    $('scanGiftForm')?.addEventListener('submit', saveGift);
    window.addEventListener('beforeunload', stopCamera);
    window.addEventListener('pagehide', stopCamera);
  }

  (async function init(){
    bind();
    try {
      await loadFunds();
      setStatus('Ready.', 'ok');
      $('scanCodeInput')?.focus();
    } catch (error) {
      setStatus(error.message || 'Unable to initialize the scanner page.', 'error');
    }
  })();
})();