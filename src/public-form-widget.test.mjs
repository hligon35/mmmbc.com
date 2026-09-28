import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

test('Turnstile widget with id zero supplies and refreshes the token', async () => {
  const source = fs.readFileSync(new URL('../public-form-utils.js', import.meta.url), 'utf8');
  let callbacks;
  let resetId;
  const window = {
    turnstile: {
      render(_container, config) { callbacks = config; return 0; },
      reset(id) { resetId = id; }
    }
  };
  vm.runInNewContext(source, { window });
  const container = { dataset: {}, hidden: true };
  const form = { dataset: {}, querySelector: () => container };
  const forms = window.MMmbcForms;
  assert.equal(await forms.loadTurnstile(form, 'public-key'), true);
  assert.equal(container.hidden, false);
  assert.equal(container.dataset.widgetId, '0');
  callbacks.callback('fresh-token');
  assert.equal(forms.getTurnstileToken(form), 'fresh-token');
  forms.resetTurnstile(form);
  assert.equal(forms.getTurnstileToken(form), '');
  assert.equal(resetId, '0');
});
