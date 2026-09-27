(function (root) {
  'use strict';

  function checkedValues(form, name) {
    return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((element) => element.value);
  }

  function radioValue(form, name) {
    return form.querySelector(`input[name="${name}"]:checked`)?.value || '';
  }

  function value(form, id) {
    return String(form.querySelector(`#${id}`)?.value || '').trim();
  }

  function formatLine(label, input) {
    const text = input && String(input).trim() ? String(input).trim() : '(blank)';
    return `${label}: ${text}`;
  }

  function addressValue(form) {
    return [value(form, 'addressLine1'), value(form, 'addressLine2'), value(form, 'city'), value(form, 'state'), value(form, 'postalCode')]
      .filter(Boolean)
      .join(', ');
  }

  function buildSummary(form, isNonMember) {
    const facilities = checkedValues(form, 'facility');
    const lines = [
      'MT. MORIAH MISSIONARY BAPTIST CHURCH',
      `RESERVATION FOR USE OF MT. MORIAH CHURCH FACILITIES (${isNonMember ? 'NON-MEMBERS' : 'MEMBERS ONLY'})`,
      'Call: JOHN BURNETT @ (270) 210-3809 OR WELDON STOKES @ (270) 519-9017',
      '',
      formatLine('Name(s) of Event/Group', value(form, 'eventGroup')),
      formatLine('First name', value(form, 'firstName')),
      formatLine('Last name', value(form, 'lastName')),
      formatLine('Email', value(form, 'contactEmail')),
      formatLine('Address', addressValue(form)),
      formatLine('Phone Number', value(form, 'phone')),
      formatLine('Purpose', value(form, 'purpose')),
      formatLine('Date of Use', value(form, 'dateOfUse')),
      formatLine('Time (From)', value(form, 'timeFrom')),
      formatLine('Time (To)', value(form, 'timeTo')),
      formatLine('Number of People (Approximately)', value(form, 'numberOfPeople')),
      formatLine('Facility(s) Needed', facilities.length ? facilities.join(', ') : '(none selected)'),
      formatLine('A/V Will Be Utilized', radioValue(form, 'avUtilized')),
      '',
      'Classroom or Nursery Will Not Be Utilized Under "Any Circumstance".',
      'Security Deposits - Refund based on condition facility is returned',
      formatLine('Signature of Responsible Person', value(form, 'responsibleSignature')),
      formatLine('Signature Date', value(form, 'responsibleSignatureDate')),
      formatLine('Signature of Mt. Moriah Responsible Person', value(form, 'churchSignature')),
      formatLine('Church Signature Date', value(form, 'churchSignatureDate')),
      '',
      'Notes (optional):',
      value(form, 'notes') || '(blank)'
    ];
    return lines.join('\n');
  }

  function getPayload(form) {
    const firstName = value(form, 'firstName');
    const lastName = value(form, 'lastName');
    return {
      eventGroup: value(form, 'eventGroup'),
      firstName,
      lastName,
      personResponsible: `${firstName} ${lastName}`.trim(),
      addressLine1: value(form, 'addressLine1'),
      addressLine2: value(form, 'addressLine2'),
      city: value(form, 'city'),
      state: value(form, 'state'),
      postalCode: value(form, 'postalCode'),
      phone: value(form, 'phone'),
      purpose: value(form, 'purpose'),
      dateOfUse: value(form, 'dateOfUse'),
      timeFrom: value(form, 'timeFrom'),
      timeTo: value(form, 'timeTo'),
      numberOfPeople: value(form, 'numberOfPeople'),
      facilities: checkedValues(form, 'facility'),
      avUtilized: radioValue(form, 'avUtilized'),
      responsibleSignature: value(form, 'responsibleSignature'),
      responsibleSignatureDate: value(form, 'responsibleSignatureDate'),
      churchSignature: value(form, 'churchSignature'),
      churchSignatureDate: value(form, 'churchSignatureDate'),
      notes: value(form, 'notes'),
      contactEmail: value(form, 'contactEmail')
    };
  }

  function setStatus(status, message) {
    if (status) status.textContent = message;
  }

  function validate(form) {
    const forms = root.MMmbcForms || {};
    const phone = value(form, 'phone');
    const phoneInput = form.querySelector('#phone');
    const postalCode = value(form, 'postalCode');
    const postalInput = form.querySelector('#postalCode');
    const stateInput = form.querySelector('#state');
    const emailInput = form.querySelector('#contactEmail');
    const email = typeof forms.normalizeEmail === 'function' ? forms.normalizeEmail(value(form, 'contactEmail')) : value(form, 'contactEmail').toLowerCase();
    const normalizedPhone = typeof forms.normalizePhone === 'function' ? forms.normalizePhone(phone) : phone;
    const normalizedPostalCode = typeof forms.normalizePostalCode === 'function' ? forms.normalizePostalCode(postalCode) : postalCode;

    if (phoneInput) phoneInput.setCustomValidity(normalizedPhone ? '' : 'Enter a valid 10-digit phone number.');
    if (postalInput) postalInput.setCustomValidity(postalCode && !normalizedPostalCode ? 'Enter a 5-digit ZIP code or ZIP+4.' : '');
    if (stateInput) stateInput.setCustomValidity(value(form, 'state') && !/^[A-Za-z]{2}$/.test(value(form, 'state')) ? 'Enter a two-letter state abbreviation.' : '');
    if (emailInput) emailInput.setCustomValidity(typeof forms.isValidEmail === 'function' && !forms.isValidEmail(email) ? 'Enter a valid email address.' : '');
    if (!form.reportValidity()) return false;

    if (phoneInput && normalizedPhone) phoneInput.value = normalizedPhone;
    if (postalInput && normalizedPostalCode) postalInput.value = normalizedPostalCode;
    if (stateInput) stateInput.value = typeof forms.normalizeState === 'function' ? forms.normalizeState(value(form, 'state')) : value(form, 'state').toUpperCase();
    if (emailInput) emailInput.value = email;

    const date = value(form, 'dateOfUse');
    const timeFrom = value(form, 'timeFrom');
    const timeTo = value(form, 'timeTo');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      form.querySelector('#dateOfUse')?.setCustomValidity('Choose a valid date.');
    } else {
      form.querySelector('#dateOfUse')?.setCustomValidity('');
    }
    if (timeFrom && timeTo && timeTo <= timeFrom) {
      form.querySelector('#timeTo')?.setCustomValidity('The end time must be later than the start time.');
    } else {
      form.querySelector('#timeTo')?.setCustomValidity('');
    }
    if (!checkedValues(form, 'facility').length) {
      form.querySelector('input[name="facility"]')?.setCustomValidity('Select at least one facility.');
    } else {
      form.querySelector('input[name="facility"]')?.setCustomValidity('');
    }
    if (!form.reportValidity()) return false;
    return true;
  }

  function init(form) {
    if (!form || form.dataset.facilityFormReady === 'true') return;
    form.dataset.facilityFormReady = 'true';
    const isNonMember = form.id === 'facilityRentalNonMembersForm';
    const status = form.querySelector('#facilityRentalFormStatus');
    const submitButton = form.querySelector('button[type="submit"]');
    const copyButton = form.querySelector('#copySummaryBtn');
    const forms = root.MMmbcForms || {};
    if (typeof forms.wireFormatting === 'function') forms.wireFormatting(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!validate(form)) {
        setStatus(status, 'Please correct the highlighted fields before sending.');
        return;
      }
      const turnstileToken = typeof forms.getTurnstileToken === 'function' ? forms.getTurnstileToken(form) : '';
      if (form.querySelector('[data-turnstile-container]')?.hidden === false && !turnstileToken) {
        setStatus(status, 'Please complete the Cloudflare verification before sending.');
        return;
      }

      const originalLabel = submitButton?.textContent || 'Send Request';
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Sending...';
      }
      setStatus(status, 'Sending your request securely...');
      try {
        const response = await fetch('/api/public/facility-rental-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audience: isNonMember ? 'non_member' : 'member',
            turnstileToken,
            form: getPayload(form)
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(data?.error || 'Unable to send your request.'));
        setStatus(status, 'Your request was sent. A confirmation email is on its way.');
        form.reset();
        if (typeof forms.resetTurnstile === 'function') forms.resetTurnstile(form);
      } catch (error) {
        setStatus(status, String(error?.message || 'Unable to send your request. Please try again.'));
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.textContent = originalLabel;
        }
      }
    });

    copyButton?.addEventListener('click', async () => {
      const summary = buildSummary(form, isNonMember);
      try {
        await navigator.clipboard.writeText(summary);
        setStatus(status, 'Request summary copied to clipboard.');
      } catch {
        window.prompt('Copy the request summary:', summary);
      }
    });
  }

  root.MMmbcFacilityForms = { init };
  document.addEventListener('DOMContentLoaded', () => {
    init(document.getElementById('facilityRentalMembersForm'));
    init(document.getElementById('facilityRentalNonMembersForm'));
  });
})(window);
