import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import qrcode from 'qrcode-generator';
import { HttpError } from './parse.js';

// The library's Byte mode keeps only the low byte of each character; scanners read UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

/**
 * QR codes, drawn once as geometry and written out three ways: SVG (one file,
 * no fonts, no scripts), PDF (vector, for print) and PNG (the SVG rasterised by
 * resvg). Every shape is a rounded rectangle: a square has radius 0, a dot has
 * radius half its side, and an eye frame is two of them filled even-odd.
 */

export const DOTS = ['square', 'rounded', 'dots'];
export const EYES = ['square', 'rounded', 'circle'];
export const ECC = ['L', 'M', 'Q', 'H'];
export const DEFAULT_STYLE = Object.freeze({
  fg: '#0b0d10',
  bg: '#ffffff',
  eye: null,
  transparent: false,
  dots: 'square',
  eye_frame: 'square',
  eye_ball: 'square',
  ecc: 'M',
  margin: 4,
});

const HEX = /^#[0-9a-f]{6}$/i;
const color = (v, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const full = /^#?[0-9a-f]{3}$/i.test(s) ? `#${s.replace('#', '').replace(/./g, (x) => x + x)}` : s.startsWith('#') ? s : `#${s}`;
  if (!HEX.test(full)) throw new HttpError(400, `${name} is a hex colour like #0b0d10`);
  return full.toLowerCase();
};
const pick = (v, list, name) => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const hit = list.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!hit) throw new HttpError(400, `${name} is one of ${list.join(', ')}`);
  return hit;
};
const truthy = (v) => v === true || v === 1 || /^(1|true|on|yes)$/i.test(String(v ?? ''));

/** A style from API JSON or flat form fields. Unknown keys are ignored; bad values are a 400. */
export function parseStyle(input = {}, base = DEFAULT_STYLE) {
  const s = { ...DEFAULT_STYLE, ...base };
  const set = (k, v) => {
    if (v !== undefined) s[k] = v;
  };
  set('fg', color(input.fg, 'fg'));
  set('bg', color(input.bg, 'bg'));
  if (input.eye === null || input.eye === '') s.eye = null;
  else {
    const eye = color(input.eye ?? input.eye_color, 'eye');
    // A form always sends the eye picker: left as it was, the eyes keep following fg.
    if (eye !== undefined && !(base.eye == null && eye === (base.fg ?? DEFAULT_STYLE.fg))) s.eye = eye;
  }
  if (s.eye === s.fg) s.eye = null;
  set('dots', pick(input.dots, DOTS, 'dots'));
  set('eye_frame', pick(input.eye_frame, EYES, 'eye_frame'));
  set('eye_ball', pick(input.eye_ball, EYES, 'eye_ball'));
  set('ecc', pick(input.ecc, ECC, 'ecc'));
  if (input.transparent !== undefined) s.transparent = truthy(input.transparent);
  if (input.margin !== undefined && input.margin !== '') {
    const m = Number(input.margin);
    if (!Number.isInteger(m) || m < 0 || m > 10) throw new HttpError(400, 'margin is 0 to 10 modules');
    s.margin = m;
  }
  return s;
}

/** Contrast is what a camera reads. Refuse a pairing that will not scan rather than print a dud. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* -------------------------------------------------------------- geometry -- */

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * The code as shapes in module units: { size, groups: [{ fill, evenodd, shapes }], logo }.
 * Each shape is [x, y, w, h, radius]; an evenodd group pairs outer and inner rings.
 */
export function layoutQr(text, style = DEFAULT_STYLE, { logo = null } = {}) {
  const st = { ...DEFAULT_STYLE, ...style };
  // A logo hides modules, so it needs the strongest error correction.
  const qr = qrcode(0, logo ? 'H' : st.ecc);
  try {
    qr.addData(String(text), 'Byte');
    qr.make();
  } catch {
    throw new HttpError(400, 'that is too much for one QR code; shorten the content');
  }
  const n = qr.getModuleCount();
  const m = st.margin;
  const size = n + m * 2;
  const inEye = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  // The logo's square, in modules, with a module of quiet space around it.
  let hole = null;
  if (logo) {
    const side = Math.max(5, Math.floor(n * 0.22) | 1);
    const at = (n - side) / 2;
    hole = { x: at + m, y: at + m, side };
  }
  const covered = (r, c) =>
    hole && c + m + 1 > hole.x - 0.5 && c + m < hole.x + hole.side + 0.5 && r + m + 1 > hole.y - 0.5 && r + m < hole.y + hole.side + 0.5;

  const radius = st.dots === 'dots' ? 0.45 : st.dots === 'rounded' ? 0.3 : 0;
  const inset = st.dots === 'dots' ? 0.05 : 0;
  const modules = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c) && !inEye(r, c) && !covered(r, c)) modules.push([c + m + inset, r + m + inset, 1 - 2 * inset, 1 - 2 * inset, radius]);

  const frameR = { square: [0, 0], rounded: [2, 1], circle: [3.5, 2.5] }[st.eye_frame];
  const ballR = { square: 0, rounded: 0.9, circle: 1.5 }[st.eye_ball];
  const frames = [];
  const balls = [];
  for (const [er, ec] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ]) {
    const x = ec + m;
    const y = er + m;
    frames.push([x, y, 7, 7, frameR[0]], [x + 1, y + 1, 5, 5, frameR[1]]);
    balls.push([x + 2, y + 2, 3, 3, ballR]);
  }
  const eye = st.eye ?? st.fg;
  return {
    size,
    modules: n,
    background: st.transparent ? null : st.bg,
    groups: [
      { fill: st.fg, evenodd: false, shapes: modules },
      { fill: eye, evenodd: true, shapes: frames },
      { fill: eye, evenodd: false, shapes: balls },
    ],
    logo: logo && hole ? { ...logo, x: hole.x, y: hole.y, side: hole.side, pad: st.transparent ? null : st.bg } : null,
  };
}

/* ------------------------------------------------------------------- SVG -- */

function svgRect([x, y, w, h, r]) {
  if (!r) return `M${r3(x)} ${r3(y)}h${r3(w)}v${r3(h)}h${r3(-w)}z`;
  const k = Math.min(r, w / 2, h / 2);
  return `M${r3(x + k)} ${r3(y)}h${r3(w - 2 * k)}a${r3(k)} ${r3(k)} 0 0 1 ${r3(k)} ${r3(k)}v${r3(h - 2 * k)}a${r3(k)} ${r3(k)} 0 0 1 ${r3(-k)} ${r3(k)}h${r3(-(w - 2 * k))}a${r3(k)} ${r3(k)} 0 0 1 ${r3(-k)} ${r3(-k)}v${r3(-(h - 2 * k))}a${r3(k)} ${r3(k)} 0 0 1 ${r3(k)} ${r3(-k)}z`;
}

const dataUri = (logo) => `data:${logo.type};base64,${Buffer.from(logo.data).toString('base64')}`;

export function renderSvg(layout, { size = 320 } = {}) {
  const px = clampSize(size);
  const paths = layout.groups
    .filter((g) => g.shapes.length)
    .map((g) => `<path d="${g.shapes.map(svgRect).join('')}" fill="${g.fill}"${g.evenodd ? ' fill-rule="evenodd"' : ''}/>`)
    .join('');
  const bg = layout.background ? `<rect width="100%" height="100%" fill="${layout.background}"/>` : '';
  let logo = '';
  if (layout.logo) {
    const { x, y, side, pad } = layout.logo;
    logo = `${pad ? `<rect x="${r3(x - 0.5)}" y="${r3(y - 0.5)}" width="${side + 1}" height="${side + 1}" rx="1" fill="${pad}"/>` : ''}<image x="${r3(x)}" y="${r3(y)}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid meet" href="${dataUri(layout.logo)}"/>`;
  }
  const crisp = layout.groups[0].shapes.every((s) => !s[4]) ? ' shape-rendering="crispEdges"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.size} ${layout.size}" width="${px}" height="${px}"${crisp}>${bg}${paths}${logo}</svg>
`;
}

/** The plain code the site has always served: square modules, black on white. */
export function qrSvg(text, { size = 320, margin = 4, dark = '#0b0d10', light = '#ffffff' } = {}) {
  return renderSvg(layoutQr(text, { ...DEFAULT_STYLE, fg: dark, bg: light, margin }), { size });
}

export const clampSize = (size) => Math.min(Math.max(Math.round(Number(size) || 320), 64), 4096);

/* ------------------------------------------------------------------- PNG -- */

let resvg = null;
async function engine() {
  if (resvg) return resvg;
  const mod = await import('@resvg/resvg-wasm');
  const wasm = readFileSync(fileURLToPath(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  try {
    await mod.initWasm(wasm);
  } catch (err) {
    // A second init (tests, hot reload) is harmless; anything else is not.
    if (!/already been initialized/i.test(String(err?.message ?? err))) throw err;
  }
  resvg = mod;
  return resvg;
}

async function raster(svg, px) {
  const { Resvg } = await engine();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: px } });
  try {
    return r.render();
  } finally {
    r.free?.();
  }
}

export async function renderPng(layout, { size = 1024 } = {}) {
  const px = clampSize(size);
  const img = await raster(renderSvg(layout, { size: px }), px);
  try {
    return Buffer.from(img.asPng());
  } finally {
    img.free?.();
  }
}

/* ------------------------------------------------------------------- PDF -- */

const K = 0.5523;
const n4 = (x) => (Math.round(x * 10000) / 10000).toString();

function pdfRect([x, y, w, h, r]) {
  if (!r) return `${n4(x)} ${n4(y)} ${n4(w)} ${n4(h)} re\n`;
  const k = Math.min(r, w / 2, h / 2);
  const c = k * K;
  const p = (...v) => v.map(n4).join(' ');
  return [
    `${p(x + k, y)} m`,
    `${p(x + w - k, y)} l`,
    `${p(x + w - k + c, y, x + w, y + k - c, x + w, y + k)} c`,
    `${p(x + w, y + h - k)} l`,
    `${p(x + w, y + h - k + c, x + w - k + c, y + h, x + w - k, y + h)} c`,
    `${p(x + k, y + h)} l`,
    `${p(x + k - c, y + h, x, y + h - k + c, x, y + h - k)} c`,
    `${p(x, y + k)} l`,
    `${p(x, y + k - c, x + k - c, y, x + k, y)} c`,
    'h',
  ].join('\n') + '\n';
}

const rgb = (hex) => [1, 3, 5].map((i) => n4(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

/**
 * A one-page PDF, the code drawn as vector paths so it prints sharp at any size.
 * `size` is the page side in points (72 to the inch); the default is 4 inches.
 * A logo goes in as an image (rasterised once by resvg, with its alpha as a soft mask).
 */
export async function renderPdf(layout, { size = 288 } = {}) {
  const pt = Math.min(Math.max(Math.round(Number(size) || 288), 72), 2880);
  const s = pt / layout.size;
  let ops = `q\n${n4(s)} 0 0 ${n4(-s)} 0 ${pt} cm\n`;
  if (layout.background) ops += `${rgb(layout.background)} rg\n0 0 ${layout.size} ${layout.size} re\nf\n`;
  for (const g of layout.groups) {
    if (!g.shapes.length) continue;
    ops += `${rgb(g.fill)} rg\n${g.shapes.map(pdfRect).join('')}${g.evenodd ? 'f*' : 'f'}\n`;
  }
  const objects = [];
  let image = null;
  if (layout.logo) {
    const { x, y, side, pad } = layout.logo;
    if (pad) ops += `${rgb(pad)} rg\n${pdfRect([x - 0.5, y - 0.5, side + 1, side + 1, 1])}f\n`;
    const px = 512;
    const img = await raster(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="${px}" height="${px}"><image width="1" height="1" preserveAspectRatio="xMidYMid meet" href="${dataUri(layout.logo)}"/></svg>`,
      px,
    );
    const rgba = Buffer.from(img.pixels);
    const w = img.width;
    const h = img.height;
    img.free?.();
    const color = Buffer.alloc(w * h * 3);
    const alpha = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) {
      // resvg hands back premultiplied alpha; undo it so edges are not darkened.
      const a = rgba[i * 4 + 3];
      for (let ch = 0; ch < 3; ch++) color[i * 3 + ch] = a ? Math.min(255, Math.round((rgba[i * 4 + ch] * 255) / a)) : 0;
      alpha[i] = a;
    }
    image = { w, h, color: deflateSync(color), alpha: deflateSync(alpha) };
    // Unit square to the logo's box, flipped back so the picture is upright.
    ops += `q\n${n4(side)} 0 0 ${n4(-side)} ${n4(x)} ${n4(y + side)} cm\n/Logo Do\nQ\n`;
  }
  ops += 'Q\n';
  const content = deflateSync(Buffer.from(ops, 'latin1'));

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt} ${pt}] /Contents 4 0 R /Resources << ${image ? '/XObject << /Logo 5 0 R >> ' : ''}>> >>`,
  );
  objects.push({ dict: `<< /Length ${content.length} /Filter /FlateDecode >>`, data: content });
  if (image) {
    objects.push({
      dict: `<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 6 0 R /Length ${image.color.length} >>`,
      data: image.color,
    });
    objects.push({
      dict: `<< /Type /XObject /Subtype /Image /Width ${image.w} /Height ${image.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.alpha.length} >>`,
      data: image.alpha,
    });
  }

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(at);
    const chunk =
      typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/* ----------------------------------------------------------------- output -- */

export const FORMATS = {
  svg: 'image/svg+xml',
  png: 'image/png',
  pdf: 'application/pdf',
};

/** One call for every route that serves a code. */
export async function renderQr(text, { style, logo = null, format = 'svg', size } = {}) {
  const layout = layoutQr(text, style, { logo });
  if (format === 'png') return renderPng(layout, { size: size ?? 1024 });
  if (format === 'pdf') return renderPdf(layout, { size });
  return Buffer.from(renderSvg(layout, { size }));
}

/* ------------------------------------------------------------------ logos -- */

export const LOGO_MAX_BYTES = 256 * 1024;

/**
 * A logo upload, checked by its magic bytes, not its name or header. PNG and
 * JPEG only: an SVG logo could carry script into a file people download.
 */
export function sniffLogo(bytes) {
  const b = Buffer.from(bytes ?? []);
  if (!b.length) throw new HttpError(400, 'the logo is empty');
  if (b.length > LOGO_MAX_BYTES) throw new HttpError(413, `logos are up to ${LOGO_MAX_BYTES / 1024} KB`);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { data: b, type: 'image/png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { data: b, type: 'image/jpeg' };
  throw new HttpError(415, 'logos are PNG or JPEG');
}
