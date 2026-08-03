import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENVELOPE_SIZES,
  QR_SIZE_INCHES,
  getEnvelopeLayout,
  getQrStyleForSize,
  buildPrintDocumentHtml
} from '../admin/public/finance_envelope_layout.mjs';

const EXPECTED_QR_INCHES = {
  standard: { x: 5.1026, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES },
  '6_25': { x: 4.8526, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES },
  '6_75': { x: 5.3526, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES },
  no3: { x: 3.1026, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES },
  no3_slim: { x: 3.1026, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES },
  '9': { x: 7.7276, y: 0.3, width: QR_SIZE_INCHES, height: QR_SIZE_INCHES }
};

function almostEqual(actual, expected, epsilon = 1e-9){
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

test('QR layout inches are locked for all supported envelope sizes', () => {
  for (const sizeKey of Object.keys(EXPECTED_QR_INCHES)) {
    const size = ENVELOPE_SIZES[sizeKey];
    assert.ok(size, `missing size config for ${sizeKey}`);
    const layout = getEnvelopeLayout(size);
    const expected = EXPECTED_QR_INCHES[sizeKey];
    almostEqual(layout.qr.x, expected.x);
    almostEqual(layout.qr.y, expected.y);
    almostEqual(layout.qr.width, expected.width);
    almostEqual(layout.qr.height, expected.height);
  }
});

test('QR preview percentages stay unchanged for all supported envelope sizes', () => {
  const expectedPercent = {
    standard: { left: 81.6416, top: 9.6, width: 12.5984, height: 25.1968 },
    '6_25': { left: 80.87666666666667, top: 8.571428571428571, width: 13.123333333333335, height: 22.497142857142858 },
    '6_75': { left: 82.34769230769231, top: 8.275862068965518, width: 12.113846153846154, height: 21.721379310344827 },
    no3: { left: 73.00235294117647, top: 12, width: 18.527058823529412, height: 31.496 },
    no3_slim: { left: 73.00235294117647, top: 14.117647058823529, width: 18.527058823529412, height: 37.05411764705882 },
    '9': { left: 87.07154929577466, top: 7.741935483870968, width: 8.872112676056338, height: 20.32 }
  };

  for (const sizeKey of Object.keys(expectedPercent)) {
    const style = getQrStyleForSize(sizeKey);
    const exp = expectedPercent[sizeKey];
    almostEqual(style.leftPercent, exp.left);
    almostEqual(style.topPercent, exp.top);
    almostEqual(style.widthPercent, exp.width);
    almostEqual(style.heightPercent, exp.height);
  }
});

test('print document preserves physical size and QR block markup', () => {
  const previewHtml = '<div class="envelopePreview"><div data-qr-block="true" style="left:74.688%;top:5.913043478260869%;width:17.997714285714287%;height:13.693913043478261%"></div></div>';
  const htmlStandard = buildPrintDocumentHtml('standard', previewHtml);
  assert.ok(htmlStandard.includes('.envelopePreviewPrint{width:6.25in;height:3.125in;box-sizing:border-box}'));
  assert.ok(htmlStandard.includes('data-qr-block="true"'));
  assert.ok(htmlStandard.includes('left:74.688%'));

  const html9 = buildPrintDocumentHtml('9', previewHtml);
  assert.ok(html9.includes('.envelopePreviewPrint{width:8.875in;height:3.875in;box-sizing:border-box}'));
});
