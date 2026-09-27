export const DEFAULT_SIZE_KEY = 'standard';
export const QR_SIZE_INCHES = 0.7874; // 2 cm

export const ENVELOPE_SIZES = {
  standard: { width: 6.25, height: 3.125 },
  '6_25': { width: 6, height: 3.5 },
  '6_75': { width: 6.5, height: 3.625 },
  no3: { width: 4.25, height: 2.5 },
  no3_slim: { width: 4.25, height: 2.125 },
  '9': { width: 8.875, height: 3.875 }
};

export function getEnvelopeSize(sizeKey){
  return ENVELOPE_SIZES[sizeKey] || ENVELOPE_SIZES[DEFAULT_SIZE_KEY];
}

export function inchesToPercent(valueInches, totalInches){
  if (!Number.isFinite(totalInches) || totalInches <= 0) return 0;
  return (Number(valueInches || 0) / totalInches) * 100;
}

export function getEnvelopeLayout(size){
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

export function getQrPlacementForSize(sizeKey){
  const size = getEnvelopeSize(sizeKey);
  const layout = getEnvelopeLayout(size);
  return {
    size,
    layout,
    leftPercent: inchesToPercent(layout.qr.x, size.width),
    topPercent: inchesToPercent(layout.qr.y, size.height),
    widthPercent: inchesToPercent(layout.qr.width, size.width),
    heightPercent: inchesToPercent(layout.qr.height, size.height)
  };
}

export function getQrStyleFromLayout(size, layout){
  return {
    leftPercent: inchesToPercent(layout.qr.x, size.width),
    topPercent: inchesToPercent(layout.qr.y, size.height),
    widthPercent: inchesToPercent(layout.qr.width, size.width),
    heightPercent: inchesToPercent(layout.qr.height, size.height)
  };
}

export function getQrStyleForSize(sizeKey){
  const size = getEnvelopeSize(sizeKey);
  const layout = getEnvelopeLayout(size);
  return getQrStyleFromLayout(size, layout);
}

export function getPrintDimensionsStyle(sizeKey){
  const size = getEnvelopeSize(sizeKey);
  return `width:${size.width}in;height:${size.height}in;box-sizing:border-box`;
}

export function buildPrintDocumentHtml(sizeKey, previewInnerHtml){
  const size = getEnvelopeSize(sizeKey);
  const body = String(previewInnerHtml || '');
  return `<!doctype html><html><head><title>Envelope Print Preview</title><style>@page{size:auto;margin:.25in}html,body{margin:0;padding:0}body{display:grid;place-items:start center;background:#fff;padding:.1in}.envelopePreviewPrint{width:${size.width}in;height:${size.height}in;box-sizing:border-box}</style></head><body><main><div class="envelopePreviewPrint">${body}</div></main></body></html>`;
}
