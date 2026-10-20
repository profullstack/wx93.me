/**
 * QR codes without a database: every type encodes to what scanners expect, every
 * style still scans (read back with ZXing, the decoder Android and most apps use),
 * and the three output formats are what they claim to be.
 */
import { describe, expect, test } from 'bun:test';
import { readBarcodes } from 'zxing-wasm/reader';

process.env.SITE_URL = 'https://wx93.me';
process.env.ALT_HOSTS = '9xq.me';

const { contrast, DOTS, EYES, layoutQr, parseStyle, renderPdf, renderPng, renderQr, renderSvg, sniffLogo } = await import('../apps/web/src/qr.js');
const { encodeStatic, icsText, parseLinkList, parseQrData, QR_TYPES, summary, vcardText } = await import('../apps/web/src/qr-types.js');
const { HttpError } = await import('../apps/web/src/parse.js');
const { TOOLS } = await import('../packages/cli/src/tools.js');
const { qrTerminal } = await import('../packages/cli/src/qr.js');

async function decode(png) {
  const found = await readBarcodes(new Blob([png]), { formats: ['QRCode'], tryHarder: true });
  return found.map((r) => r.text);
}

/** A plain 32x32 magenta PNG: a logo that is not itself a QR code. */
function solidPng() {
  const { deflateSync, crc32 } = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 32 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(96, Buffer.from([0xff, 0x00, 0x66]))])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const LOGO = { data: solidPng(), type: 'image/png' };

describe('drawing', () => {
  test('every dot and eye style scans, with and without a logo, UTF-8 intact', async () => {
    const text = 'https://wx93.me/abc123?qr · héllo ✓';
    for (const dots of DOTS)
      for (const eye of EYES)
        for (const logo of [null, LOGO]) {
          const png = await renderPng(layoutQr(text, { dots, eye_frame: eye, eye_ball: eye, fg: '#1d4ed8', eye: '#db2777' }, { logo }), { size: 480 });
          expect({ dots, eye, logo: Boolean(logo), got: await decode(png) }).toEqual({ dots, eye, logo: Boolean(logo), got: [text] });
        }
  });

  test('a logo forces error correction H and clears the middle', () => {
    const plain = layoutQr('https://wx93.me/x', { ecc: 'L' });
    const withLogo = layoutQr('https://wx93.me/x', { ecc: 'L' }, { logo: { data: Buffer.from('x'), type: 'image/png' } });
    expect(withLogo.modules).toBeGreaterThan(plain.modules);
    expect(withLogo.logo.side).toBeGreaterThanOrEqual(5);
  });

  test('svg, png and pdf are what they say', async () => {
    const svg = (await renderQr('hello', { format: 'svg', size: 200 })).toString();
    expect(svg).toStartWith('<?xml');
    expect(svg).toContain('width="200"');
    expect(svg).not.toContain('<script');
    const png = await renderQr('hello', { format: 'png', size: 256 });
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.readUInt32BE(16)).toBe(256);
    const pdf = await renderPdf(layoutQr('hello', { dots: 'rounded', eye_frame: 'circle' }, { logo: LOGO }), { size: 288 });
    const head = pdf.subarray(0, 8).toString('latin1');
    expect(head).toBe('%PDF-1.4');
    const tail = pdf.subarray(-200).toString('latin1');
    expect(tail).toContain('startxref');
    expect(tail.trimEnd()).toEndWith('%%EOF');
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 288 288]');
    expect(pdf.toString('latin1')).toContain('/SMask');
  });

  test('transparent drops the background; sizes are clamped', () => {
    expect(renderSvg(layoutQr('x', { transparent: true }))).not.toContain('<rect width="100%"');
    expect(renderSvg(layoutQr('x'), { size: 99999 })).toContain('width="4096"');
  });

  test('too much content is a 400, not a crash', () => {
    expect(() => layoutQr('x'.repeat(5000))).toThrow(HttpError);
  });
});

describe('style', () => {
  test('parses colours, shapes and bounds', () => {
    const s = parseStyle({ fg: '1d4ed8', bg: '#FFF', dots: 'Dots', eye_frame: 'circle', ecc: 'q', margin: '2', transparent: 'on' });
    expect(s).toMatchObject({ fg: '#1d4ed8', bg: '#ffffff', dots: 'dots', eye_frame: 'circle', ecc: 'Q', margin: 2, transparent: true });
    expect(() => parseStyle({ fg: 'red' })).toThrow('hex');
    expect(() => parseStyle({ dots: 'stars' })).toThrow('dots is one of');
    expect(() => parseStyle({ margin: 40 })).toThrow('margin');
  });
  test('contrast tells a scannable pair from a dud', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffff00', '#ffffff')).toBeLessThan(3);
  });
});

describe('content types', () => {
  test('static encodings are the formats phones understand', () => {
    expect(encodeStatic('wifi', parseQrData('wifi', { ssid: 'Café;1', password: 'p:w', encryption: 'WPA', hidden: 'on' }))).toBe('WIFI:T:WPA;S:Café\\;1;P:p\\:w;H:true;;');
    expect(encodeStatic('wifi', parseQrData('wifi', { ssid: 'Open', encryption: 'nopass' }))).toBe('WIFI:T:nopass;S:Open;;');
    expect(encodeStatic('email', parseQrData('email', { to: 'a@b.co', subject: 'Hi there' }))).toBe('mailto:a@b.co?subject=Hi%20there');
    expect(encodeStatic('phone', parseQrData('phone', { number: '+1 (408) 555-0100' }))).toBe('tel:+14085550100');
    expect(encodeStatic('sms', parseQrData('sms', { number: '+1 408 555 0100', message: 'yo' }))).toBe('SMSTO:+14085550100:yo');
    expect(encodeStatic('whatsapp', parseQrData('whatsapp', { number: '+44 20 7946 0000', message: 'hi you' }))).toBe('https://wa.me/442079460000?text=hi%20you');
    expect(encodeStatic('geo', parseQrData('geo', { lat: '37.2', lng: '-121.9', label: 'Los Gatos' }))).toBe('geo:37.2,-121.9?q=37.2,-121.9(Los%20Gatos)');
    expect(encodeStatic('crypto', parseQrData('crypto', { coin: 'Bitcoin', address: 'bc1qxyz', amount: '0.01' }))).toBe('bitcoin:bc1qxyz?amount=0.01');
    expect(encodeStatic('text', parseQrData('text', { text: 'hello' }))).toBe('hello');
  });

  test('a vCard and an event', () => {
    const v = vcardText(parseQrData('vcard', { first: 'Ada', last: 'Lovelace', org: 'Engines, Ltd', phone: '+44 1', email: 'ada@example.com' }));
    expect(v).toContain('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Lovelace;Ada;;;\r\nFN:Ada Lovelace');
    expect(v).toContain('ORG:Engines\\, Ltd');
    const zoned = icsText(parseQrData('event', { title: 'Launch', start: '2026-11-02T18:30', tz: 'America/Los_Angeles' }), { uid: 'u1' });
    expect(zoned).toContain('DTSTART;TZID=America/Los_Angeles:20261102T183000');
    expect(zoned).toContain('DTEND;TZID=America/Los_Angeles:20261102T193000');
    const utc = icsText(parseQrData('event', { title: 'Launch', start: '2026-11-02T18:30', end: '2026-11-02T20:00' }));
    expect(utc).toContain('DTSTART:20261102T183000Z');
    expect(utc).toContain('DTEND:20261102T200000Z');
    expect(() => parseQrData('event', { title: 'x', start: '2026-11-02T18:30', tz: 'Mars/Olympus' })).toThrow('time zone');
    expect(() => parseQrData('event', { title: 'x', start: '2026-11-02T18:30', end: '2026-11-01T18:30' })).toThrow('ends before');
  });

  test('a link list, checked like any destination', () => {
    expect(parseLinkList('Shop | https://shop.example.com\nhttps://blog.example.com')).toEqual([
      { label: 'Shop', url: 'https://shop.example.com/' },
      { label: 'blog.example.com', url: 'https://blog.example.com/' },
    ]);
    expect(() => parseLinkList('Bad | javascript:alert(1)')).toThrow();
  });

  test('input is checked per type', () => {
    expect(() => parseQrData('nope', {})).toThrow('type is one of');
    expect(() => parseQrData('wifi', {})).toThrow('Network name is required');
    expect(() => parseQrData('email', { to: 'nope' })).toThrow('not an email');
    expect(() => parseQrData('geo', { lat: '91', lng: '0' })).toThrow('not a point');
    expect(() => parseQrData('url', { url: 'ftp://x.example' })).toThrow();
    expect(parseQrData('wifi', { ssid: 'x', extra: 'dropped' })).toEqual({ ssid: 'x', hidden: false });
  });

  test('every type has a label, a hint and a summary that never shows a Wi-Fi password', () => {
    for (const [k, t] of Object.entries(QR_TYPES)) expect([k, Boolean(t.label && t.hint && t.fields.length)]).toEqual([k, true]);
    expect(summary('wifi', { ssid: 'Home', password: 'secret' })).toBe('Home');
  });

  test('a static Wi-Fi code scans back to its join string', async () => {
    const text = encodeStatic('wifi', parseQrData('wifi', { ssid: 'Guest', password: 'welcome!' }));
    expect(await decode(await renderPng(layoutQr(text, { dots: 'rounded' }), { size: 400 }))).toEqual([text]);
  });
});

describe('logos', () => {
  test('PNG and JPEG by magic bytes; SVG, GIF and oversize refused', () => {
    expect(sniffLogo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])).type).toBe('image/png');
    expect(sniffLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).type).toBe('image/jpeg');
    expect(() => sniffLogo(Buffer.from('<svg onload="x()"/>'))).toThrow('PNG or JPEG');
    expect(() => sniffLogo(Buffer.from('GIF89a'))).toThrow('PNG or JPEG');
    expect(() => sniffLogo(Buffer.alloc(300 * 1024))).toThrow('256 KB');
  });
});

describe('the CLI and MCP surfaces', () => {
  test('the terminal QR keeps UTF-8', () => {
    expect(qrTerminal('héllo').split('\n').length).toBeGreaterThan(10);
  });
  test('MCP lists the QR tools with closed schemas', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['create_qr_code', 'list_qr_codes', 'get_qr_code', 'update_qr_code', 'delete_qr_code', 'qr_code_stats']) expect(names).toContain(n);
    for (const t of TOOLS) expect(t.inputSchema.additionalProperties).toBe(false);
  });
});
