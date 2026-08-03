const DEFAULT_SIZE_KEY = 'standard';
const QR_SIZE_INCHES = 0.7874; // 2 cm

const ENVELOPE_SIZES = {
  standard: { width: 6.25, height: 3.125 },
  '6_25': { width: 6, height: 3.5 },
  '6_75': { width: 6.5, height: 3.625 },
  no3: { width: 4.25, height: 2.5 },
  no3_slim: { width: 4.25, height: 2.125 },
  '9': { width: 8.875, height: 3.875 }
};

function getEnvelopeSize(sizeKey){
  return ENVELOPE_SIZES[sizeKey] || ENVELOPE_SIZES[DEFAULT_SIZE_KEY];
}

function inchesToPercent(valueInches, totalInches){
  if (!Number.isFinite(totalInches) || totalInches <= 0) return 0;
  return (Number(valueInches || 0) / totalInches) * 100;
}

function getEnvelopeLayout(size){
  const isLandscape = size.width > size.height;
  const leftPad = isLandscape ? 0.42 : 0.34;
  const topPad = isLandscape ? 0.3 : 0.34;
  const rightPad = isLandscape ? 0.36 : 0.32;
  const bottomPad = isLandscape ? 0.28 : 0.32;
  const qrWidth = QR_SIZE_INCHES;
  const qrX = size.width - rightPad - qrWidth;
  const textRightEdge = qrX - (isLandscape ? 0.24 : 0.18);
  const textWidth = Math.max(1.6, textRightEdge - leftPad);

  return {
    isLandscape,
    leftPad,
    topPad,
    rightPad,
    bottomPad,
    qr: {
      x: qrX,
      y: topPad,
      width: qrWidth,
      height: qrWidth
    },
    heading: {
      x: leftPad,
      y: topPad,
      width: textWidth
    },
    textBounds: {
      x: leftPad,
      y: topPad,
      width: textWidth,
      height: size.height - topPad - bottomPad
    }
  };
}

function getQrStyleFromLayout(size, layout){
  return {
    leftPercent: inchesToPercent(layout.qr.x, size.width),
    topPercent: inchesToPercent(layout.qr.y, size.height),
    widthPercent: inchesToPercent(layout.qr.width, size.width),
    heightPercent: inchesToPercent(layout.qr.height, size.height)
  };
}

function buildPrintDocumentHtml(sizeKey, previewInnerHtml){
  const size = getEnvelopeSize(sizeKey);
  const body = String(previewInnerHtml || '');
  return `<!doctype html><html><head><title>Envelope Print Preview</title><style>@page{size:auto;margin:.25in}html,body{margin:0;padding:0}body{display:grid;place-items:start center;background:#fff;padding:.1in}.envelopePreviewPrint{width:${size.width}in;height:${size.height}in;box-sizing:border-box}</style></head><body><main><div class="envelopePreviewPrint">${body}</div></main></body></html>`;
}

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

  function escapeHtml(value){
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
    const sizeKey = $('envelopeDesignerSize')?.value || DEFAULT_SIZE_KEY;
    const size = getEnvelopeSize(sizeKey);
    const layout = getEnvelopeLayout(size);
    const opacity = Math.max(0, Math.min(100, Number($('envelopeDesignerOpacity')?.value || 15))) / 100;
    const codeValue = selectedCodeValue();
    const qrSvg = await fetchQrSvg(codeValue);
    const heading = 'Mt.Moriah Missionary Baptist Church';
    const churchLine1 = '1201 S 8th St';
    const churchLine2 = 'Paducah, KY 42003 · (270) 443-3714';
    const offeringTitle = 'TITHES & OFFERINGS';
    const message = 'Thank you for your faithful giving. Please complete the lines below.';
    const background = state.backgroundDataUrl
      ? `<img src="${state.backgroundDataUrl}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center;opacity:${opacity};" />`
      : '';
    const donorName = donor ? `${donor.firstName} ${donor.lastName}` : 'Blank One-Time Envelope';
    const accountNumber = donor?.accountNumber || '';
    const envelopeNumber = donor?.envelopeNumber || '';
    const donorDisplay = escapeHtml(donorName);
    const accountDisplay = escapeHtml(accountNumber || 'Not assigned');
    const envelopeDisplay = escapeHtml(envelopeNumber || 'Not assigned');
    const todayIso = new Date().toISOString().slice(0, 10);
    const todayDisplay = `${todayIso.slice(5, 7)}/${todayIso.slice(8, 10)}/${todayIso.slice(0, 4)}`;
    const messageDisplay = message;
    const dateLabel = escapeHtml($('envelopeDesignerDateLabel')?.value || 'Date:');
    const nameLabel = escapeHtml($('envelopeDesignerNameLabel')?.value || 'Name:');
    const accountLabel = escapeHtml($('envelopeDesignerAccountLabel')?.value || 'Acct #:');
    const envelopeLabel = escapeHtml($('envelopeDesignerEnvelopeLabel')?.value || 'Env #:');
    const amountLabel = escapeHtml($('envelopeDesignerAmountLabel')?.value || 'Amount:');
    const checkLabel = escapeHtml($('envelopeDesignerCheckLabel')?.value || 'Check');
    const cashLabel = escapeHtml($('envelopeDesignerCashLabel')?.value || 'Cash');
    const verseLine1 = 'Bring ye all the tithes into the storehouse, that there may be meat in mine house,';
    const verseLine2 = 'and prove me now herewith, saith the LORD of hosts. Malachi 3:10';
    const gridR1C1 = escapeHtml($('envelopeDesignerGridR1C1')?.value || 'Tithe');
    const gridR1C2 = escapeHtml($('envelopeDesignerGridR1C2')?.value || 'Annual Day');
    const gridR1C3 = escapeHtml($('envelopeDesignerGridR1C3')?.value || 'Discipleship Training');
    const gridR1C4 = escapeHtml($('envelopeDesignerGridR1C4')?.value || 'Missionary');
    const gridR1C5 = escapeHtml($('envelopeDesignerGridR1C5')?.value || 'Pastor Anniversary');
    const gridR2C1 = escapeHtml($('envelopeDesignerGridR2C1')?.value || 'Offering');
    const gridR2C2 = escapeHtml($('envelopeDesignerGridR2C2')?.value || 'Benevolent');
    const gridR2C3 = escapeHtml($('envelopeDesignerGridR2C3')?.value || 'Building Fund');
    const gridR2C4 = escapeHtml($('envelopeDesignerGridR2C4')?.value || 'Youth');
    const gridR2C5 = escapeHtml($('envelopeDesignerGridR2C5')?.value || 'Other');
    const codeDisplay = escapeHtml(codeValue || 'No QR code selected');
    const headingFontRem = layout.isLandscape ? '0.84rem' : '0.95rem';
    const bodyFontRem = layout.isLandscape ? '0.62rem' : '0.68rem';
    const detailsFontRem = layout.isLandscape ? '0.62rem' : '0.7rem';
    const gridFontRem = layout.isLandscape ? '0.56rem' : '0.62rem';
    const workingWidth = layout.textBounds.width;
    const workingHeight = layout.textBounds.height;
    // Padding presets make section movement easy: adjust these values directly.
    const sectionPadding = layout.isLandscape
      ? {
          headerCenterPercent: 60,
          headerWidthPercent: 86,
          donorLeftInches: 0.5,
          donorTopPercent: 29.5,
          donorWidthPercent: 68,
          donorLineGapPercent: 5.6,
          scriptureCenterPercent: 60,
          scriptureTopPercent: 73,
          scriptureWidthPercent: 86,
          gridCenterPercent: 60,
          gridTopPercent: 87.5,
          gridWidthPercent: 90,
          gridRowGapPercent: 2.8,
          thankYouCenterPercent: 60,
          thankYouBottomPercent: 1.1,
          thankYouWidthPercent: 86
        }
      : {
          headerCenterPercent: 50,
          headerWidthPercent: 86,
          donorLeftInches: null,
          donorTopPercent: 29.5,
          donorWidthPercent: 80,
          donorLineGapPercent: 5,
          scriptureCenterPercent: 50,
          scriptureTopPercent: 73,
          scriptureWidthPercent: 86,
          gridCenterPercent: 50,
          gridTopPercent: 87.5,
          gridWidthPercent: 90,
          gridRowGapPercent: 2.8,
          thankYouCenterPercent: 50,
          thankYouBottomPercent: 1.6,
          thankYouWidthPercent: 86
        };
    const detailBlockWidth = workingWidth * (sectionPadding.donorWidthPercent / 100);
    const detailBlockLeft = Number.isFinite(sectionPadding.donorLeftInches)
      ? sectionPadding.donorLeftInches
      : layout.textBounds.x + ((workingWidth - detailBlockWidth) / 2);
    const headerBlockWidth = workingWidth * (sectionPadding.headerWidthPercent / 100);
    const donorTop = layout.textBounds.y + (workingHeight * (sectionPadding.donorTopPercent / 100));
    const donorLineGap = workingHeight * (sectionPadding.donorLineGapPercent / 100);
    const verseTop = layout.textBounds.y + (workingHeight * (sectionPadding.scriptureTopPercent / 100));
    const verseBlockWidth = workingWidth * (sectionPadding.scriptureWidthPercent / 100);
    const rowGap = workingHeight * (sectionPadding.gridRowGapPercent / 100);
    const gridTop = layout.textBounds.y + (workingHeight * (sectionPadding.gridTopPercent / 100));
    const gridBlockWidth = workingWidth * (sectionPadding.gridWidthPercent / 100);
    const thankYouBottomPercent = sectionPadding.thankYouBottomPercent;
    const thankYouBlockWidth = workingWidth * (sectionPadding.thankYouWidthPercent / 100);
    const scriptureRaisePx = 75;
    const gridRaisePx = 75;
    const ratio = `${size.width}/${size.height}`;
    const qrMarkup = qrSvg || '<div style="width:100%;height:100%;display:grid;place-items:center;color:#444;font-size:.72rem;">Issue or select a code</div>';
    const qrStyle = getQrStyleFromLayout(size, layout);

    const contentHtml = `
      <div class="envelopePreviewSheet" style="position:relative;width:100%;height:100%;background:#fff;color:#111;overflow:hidden;">
        ${background}
        <div style="position:absolute;inset:0;border:1px solid rgba(0,0,0,.28);"></div>
        <div style="position:absolute;left:${inchesToPercent(layout.textBounds.x, size.width)}%;top:${inchesToPercent(layout.textBounds.y, size.height)}%;width:${inchesToPercent(layout.textBounds.width, size.width)}%;height:${inchesToPercent(layout.textBounds.height, size.height)}%;font-family:'Times New Roman', Times, serif;display:block;z-index:1;">
          <div style="position:absolute;left:${sectionPadding.headerCenterPercent}%;transform:translateX(-50%);top:0;width:${inchesToPercent(headerBlockWidth, layout.textBounds.width)}%;display:grid;justify-items:center;text-align:center;">
            <div style="text-align:center;font-size:${headingFontRem};font-weight:900;line-height:1.2;letter-spacing:.01em;width:100%;">${heading}</div>
            <div style="text-align:center;font-size:${bodyFontRem};font-weight:800;line-height:1.22;margin-top:${layout.isLandscape ? '1px' : '2px'};width:100%;">${churchLine1}</div>
            <div style="text-align:center;font-size:${bodyFontRem};font-weight:800;line-height:1.2;width:100%;">${churchLine2}</div>
            <div style="text-align:center;font-size:${layout.isLandscape ? '0.74rem' : '0.82rem'};font-weight:900;letter-spacing:.07em;margin-top:${layout.isLandscape ? '4px' : '6px'};width:100%;">${offeringTitle}</div>
          </div>

          <div style="position:absolute;left:${inchesToPercent(detailBlockLeft - layout.textBounds.x, layout.textBounds.width)}%;top:${inchesToPercent(donorTop - layout.textBounds.y, layout.textBounds.height)}%;width:${inchesToPercent(detailBlockWidth, layout.textBounds.width)}%;display:grid;grid-template-columns:1fr;grid-template-rows:auto ${inchesToPercent(donorLineGap, layout.textBounds.height)}% auto ${inchesToPercent(donorLineGap, layout.textBounds.height)}% auto ${inchesToPercent(donorLineGap, layout.textBounds.height)}% auto;font-size:${detailsFontRem};font-weight:700;line-height:1.15;">
            <div><strong>${dateLabel}</strong> ${todayDisplay}</div>
            <div aria-hidden="true"></div>
            <div><strong>${nameLabel}</strong> ${donorDisplay}</div>
            <div aria-hidden="true"></div>
            <div><strong>${accountLabel}</strong> ${accountDisplay} &nbsp;&nbsp;&nbsp; <strong>${envelopeLabel}</strong> ${envelopeDisplay}</div>
            <div aria-hidden="true"></div>
            <div><strong>${amountLabel}</strong> ___________________ &nbsp;&nbsp; <strong>${checkLabel}</strong> [ ] &nbsp; <strong>${cashLabel}</strong> [ ]</div>
          </div>

          <div style="position:absolute;left:${sectionPadding.scriptureCenterPercent}%;transform:translateX(-50%);top:calc(${inchesToPercent(verseTop - layout.textBounds.y, layout.textBounds.height)}% - ${scriptureRaisePx}px);width:${inchesToPercent(verseBlockWidth, layout.textBounds.width)}%;text-align:center;font-size:${layout.isLandscape ? '0.54rem' : '0.6rem'};line-height:1.2;font-weight:700;">
            <div>${verseLine1}</div>
            <div>${verseLine2}</div>
            <div aria-hidden="true">&nbsp;</div>
          </div>

          <div style="position:absolute;left:${sectionPadding.gridCenterPercent}%;transform:translateX(-50%);top:calc(${inchesToPercent(gridTop - layout.textBounds.y, layout.textBounds.height)}% - ${gridRaisePx}px);width:${inchesToPercent(gridBlockWidth, layout.textBounds.width)}%;display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));grid-template-rows:auto ${inchesToPercent(rowGap, layout.textBounds.height)}% auto ${inchesToPercent(rowGap, layout.textBounds.height)}% auto;row-gap:0;column-gap:${inchesToPercent(Math.min(0.12, workingWidth * 0.04), layout.textBounds.width)}%;font-size:${gridFontRem};line-height:1.22;font-weight:700;justify-items:center;text-align:center;">
            <div>${gridR1C1}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR1C2}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR1C3}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR1C4}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR1C5}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div aria-hidden="true"></div>
            <div>${gridR2C1}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR2C2}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR2C3}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR2C4}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
            <div>${gridR2C5}<br /><span aria-hidden="true">&nbsp;</span><br />__________</div>
          </div>

          <div style="position:absolute;left:${sectionPadding.thankYouCenterPercent}%;transform:translateX(-50%);bottom:${thankYouBottomPercent}%;width:${inchesToPercent(thankYouBlockWidth, layout.textBounds.width)}%;text-align:center;font-size:${layout.isLandscape ? '0.53rem' : '0.58rem'};line-height:1.15;font-weight:700;">${messageDisplay}</div>
        </div>
        <div data-qr-block="true" style="position:absolute;left:${qrStyle.leftPercent}%;top:${qrStyle.topPercent}%;width:${qrStyle.widthPercent}%;height:${qrStyle.heightPercent}%;background:#fff;border:1px solid rgba(0,0,0,.2);padding:${layout.isLandscape ? '5px' : '8px'};z-index:1;box-sizing:border-box;display:grid;place-items:center;">${qrMarkup}</div>
        <div style="position:absolute;left:${qrStyle.leftPercent}%;top:${inchesToPercent(layout.qr.y + layout.qr.height + 0.08, size.height)}%;width:${qrStyle.widthPercent}%;font-size:${layout.isLandscape ? '0.58rem' : '0.66rem'};line-height:1.2;text-align:center;word-break:break-all;z-index:1;">${codeDisplay}</div>
      </div>
    `;

    preview.innerHTML = `
      <div style="display:grid;gap:10px;">
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:.85rem;color:#555;">
          <span><strong>Model size:</strong> ${size.width.toFixed(3)} in × ${size.height.toFixed(3)} in</span>
          <span><strong>Layout:</strong> ${layout.isLandscape ? 'Landscape' : 'Portrait'}</span>
        </div>
        <div class="envelopePreview" style="position:relative;aspect-ratio:${ratio};width:min(100%, 940px);margin:0 auto;box-shadow:0 10px 28px rgba(0,0,0,.12);">
          ${contentHtml}
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
    const sizeKey = $('envelopeDesignerSize')?.value || DEFAULT_SIZE_KEY;
    const html = $('envelopeDesignerPreview')?.querySelector('.envelopePreview')?.innerHTML || '';
    if (!html) {
      setMsg('Create a preview before printing.', 'error');
      return;
    }

    const popup = window.open('', '_blank', 'width=1200,height=900');
    if (!popup) {
      setMsg('Allow popups to print the envelope preview.', 'error');
      return;
    }
    popup.document.write(buildPrintDocumentHtml(sizeKey, html));
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
    for (const id of [
      'envelopeDesignerSize',
      'envelopeDesignerDateLabel',
      'envelopeDesignerNameLabel',
      'envelopeDesignerAccountLabel',
      'envelopeDesignerEnvelopeLabel',
      'envelopeDesignerAmountLabel',
      'envelopeDesignerCheckLabel',
      'envelopeDesignerCashLabel',
      'envelopeDesignerGridR1C1',
      'envelopeDesignerGridR1C2',
      'envelopeDesignerGridR1C3',
      'envelopeDesignerGridR1C4',
      'envelopeDesignerGridR1C5',
      'envelopeDesignerGridR2C1',
      'envelopeDesignerGridR2C2',
      'envelopeDesignerGridR2C3',
      'envelopeDesignerGridR2C4',
      'envelopeDesignerGridR2C5',
      'envelopeDesignerOpacity'
    ]) {
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