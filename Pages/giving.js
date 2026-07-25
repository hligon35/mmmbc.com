(() => {
  const form = document.getElementById('givingForm');
  const amountInput = document.getElementById('givingAmount');
  const submitBtn = document.getElementById('givingSubmit');
  const status = document.getElementById('givingStatus');
  const amountButtons = Array.from(document.querySelectorAll('[data-amount]'));

  if (!form || !amountInput || !submitBtn || !status) return;

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };

  const selectAmountButton = (activeButton) => {
    amountButtons.forEach((button) => button.classList.toggle('is-selected', button === activeButton));
  };

  amountButtons.forEach((button) => {
    button.addEventListener('click', () => {
      amountInput.value = String(button.dataset.amount || '');
      selectAmountButton(button);
      amountInput.focus();
    });
  });

  amountInput.addEventListener('input', () => {
    const current = Number(amountInput.value);
    const match = amountButtons.find((button) => Number(button.dataset.amount) === current);
    selectAmountButton(match || null);
  });

  if (new URLSearchParams(window.location.search).get('canceled') === '1') {
    setStatus('Checkout was canceled. Your information has not been submitted.', true);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');

    const amount = Number(amountInput.value);
    const donorEmail = String(document.getElementById('givingEmail')?.value || '').trim();
    const fund = String(new FormData(form).get('fund') || '');
    const frequency = String(new FormData(form).get('frequency') || 'one_time');

    if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
      setStatus('Enter an amount between $1 and $100,000.', true);
      amountInput.focus();
      return;
    }

    if (!/^\S+@\S+\.\S+$/.test(donorEmail)) {
      setStatus('Enter a valid email address.', true);
      document.getElementById('givingEmail')?.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Opening secure checkout...';

    try {
      const response = await fetch('/api/giving/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountCents: Math.round(amount * 100),
          fund,
          frequency,
          donorName: String(document.getElementById('givingName')?.value || '').trim(),
          donorEmail,
          note: String(document.getElementById('givingNote')?.value || '').trim()
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.checkoutUrl) {
        throw new Error(data.error || 'Unable to open secure checkout.');
      }

      window.location.assign(data.checkoutUrl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to open secure checkout.', true);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue to secure checkout';
    }
  });
})();
