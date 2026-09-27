(function (root) {
  'use strict';

  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizePhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (national.length !== 10) return '';
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }

  function normalizePostalCode(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 5) return digits;
    if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    return '';
  }

  function normalizeState(value) {
    return String(value || '').trim().toUpperCase().slice(0, 2);
  }

  function isValidEmail(value) {
    const email = normalizeEmail(value);
    return email.length <= 254 && EMAIL_PATTERN.test(email);
  }

  function isValidPhone(value) {
    return !String(value || '').trim() || Boolean(normalizePhone(value));
  }

  function isValidPostalCode(value) {
    return !String(value || '').trim() || Boolean(normalizePostalCode(value));
  }

  function formatInput(input, normalizer) {
    if (!input) return;
    input.addEventListener('blur', () => {
      const raw = String(input.value || '').trim();
      if (!raw) return;
      const normalized = normalizer(raw);
      if (normalized) input.value = normalized;
    });
  }

  function wireFormatting(form) {
    if (!form) return;
    formatInput(form.querySelector('[data-format="phone"]'), normalizePhone);
    formatInput(form.querySelector('[data-format="postal-code"]'), normalizePostalCode);
  }

  let turnstileLoader;

  function loadTurnstile(form, siteKey) {
    const key = String(siteKey || '').trim();
    const container = form?.querySelector('[data-turnstile-container]');
    if (!form || !container || !key) return Promise.resolve(false);
    container.hidden = false;
    container.dataset.sitekey = key;
    const render = () => {
      if (!root.turnstile || container.dataset.widgetId) return Boolean(root.turnstile);
      const widgetId = root.turnstile.render(container, {
        sitekey: key,
        callback: (token) => { form.dataset.turnstileToken = String(token || ''); },
        'expired-callback': () => { form.dataset.turnstileToken = ''; },
        'error-callback': () => { form.dataset.turnstileToken = ''; }
      });
      container.dataset.widgetId = String(widgetId || '');
      return true;
    };
    if (render()) return Promise.resolve(true);
    if (!turnstileLoader) {
      turnstileLoader = new Promise((resolve) => {
        const existing = document.querySelector('script[data-mmmbc-turnstile]');
        if (existing) {
          existing.addEventListener('load', () => resolve(true), { once: true });
          existing.addEventListener('error', () => resolve(false), { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.dataset.mmmbcTurnstile = 'true';
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      });
    }
    return turnstileLoader.then(() => render());
  }

  function getTurnstileToken(form) {
    return String(form?.dataset?.turnstileToken || '').trim();
  }

  function resetTurnstile(form) {
    const container = form?.querySelector('[data-turnstile-container]');
    form.dataset.turnstileToken = '';
    if (container?.dataset?.widgetId && root.turnstile) root.turnstile.reset(container.dataset.widgetId);
  }

  root.MMmbcForms = {
    normalizeEmail,
    normalizePhone,
    normalizePostalCode,
    normalizeState,
    isValidEmail,
    isValidPhone,
    isValidPostalCode,
    wireFormatting,
    loadTurnstile,
    getTurnstileToken,
    resetTurnstile
  };
})(window);
