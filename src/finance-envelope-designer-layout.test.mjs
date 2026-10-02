import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENVELOPE_SIZES, getEnvelopeLayout, buildPrintDocumentHtml } from '../admin/public/finance_envelope_layout.mjs';

test('manual envelope text uses the printable width for every supported size', () => {
  for (const size of Object.values(ENVELOPE_SIZES)) {
    const layout = getEnvelopeLayout(size);
    assert.equal(layout.textBounds.width, size.width - layout.leftPad - layout.rightPad);
    assert.ok(layout.textBounds.height > 0);
    assert.equal(layout.qr, undefined);
  }
});

test('print document preserves envelope dimensions and donor text', () => {
  const preview = '<div class="envelopePreview">Account: 0012</div>';
  for (const [key, size] of Object.entries(ENVELOPE_SIZES)) {
    const html = buildPrintDocumentHtml(key, preview);
    assert.ok(html.includes(`width:${size.width}in;height:${size.height}in;box-sizing:border-box`));
    assert.ok(html.includes(preview));
  }
});
