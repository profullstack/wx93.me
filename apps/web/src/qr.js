import qrcode from 'qrcode-generator';

/**
 * A QR code as a standalone SVG: one path, crisp at any size, no fonts, no
 * scripts. Error correction M survives a logo sticker or a scuffed print.
 */
export function qrSvg(text, { size = 320, margin = 4, dark = '#0b0d10', light = '#ffffff' } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>
`;
}
