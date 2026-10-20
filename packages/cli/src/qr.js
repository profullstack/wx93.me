import qrcode from 'qrcode-generator';

// The library's Byte mode keeps only the low byte of each character; scanners read UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

/** A QR code drawn with half-block characters: two modules per terminal row. */
export function qrTerminal(text, { margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -margin; r < n + margin; r += 2) {
    let line = '';
    for (let c = -margin; c < n + margin; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      // Light modules are drawn, dark ones left blank, so it scans on a dark terminal.
      line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
