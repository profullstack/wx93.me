import { checkShape } from './abuse.js';
import { HttpError } from './parse.js';

/**
 * What a QR code can carry, and the text each kind encodes.
 *
 * Two families. A DYNAMIC code encodes a wx93 short link, so every scan is
 * counted and the destination can change after the code is printed: a website,
 * or a page we host (a contact card, an event, a list of links). A STATIC code
 * encodes its content directly (Wi-Fi, a phone number, a payment address), so
 * the phone acts on it without asking us and nothing can be counted.
 *
 * Each field is [name, label, kind, required]. Kinds drive the form input and
 * the check: text, long (a textarea), url, email, tel, number, datetime, select,
 * check.
 */

const CRYPTO = ['bitcoin', 'ethereum', 'litecoin', 'bitcoincash', 'dogecoin', 'solana', 'monero'];

export const QR_TYPES = {
  url: {
    label: 'Website',
    dynamic: true,
    hint: 'Opens a web page. Change the destination any time; the printed code stays the same.',
    fields: [['url', 'URL', 'url', true]],
  },
  vcard: {
    label: 'Contact card',
    dynamic: true,
    hint: 'A contact page with a Save button (vCard). Edit it after printing.',
    fields: [
      ['first', 'First name', 'text', true],
      ['last', 'Last name', 'text', false],
      ['org', 'Company', 'text', false],
      ['title', 'Job title', 'text', false],
      ['phone', 'Phone', 'tel', false],
      ['email', 'Email', 'email', false],
      ['url', 'Website', 'url', false],
      ['address', 'Address', 'text', false],
      ['note', 'Note', 'long', false],
    ],
  },
  event: {
    label: 'Event',
    dynamic: true,
    hint: 'An event page with an Add to calendar button (.ics).',
    fields: [
      ['title', 'Title', 'text', true],
      ['start', 'Starts', 'datetime', true],
      ['end', 'Ends', 'datetime', false],
      ['tz', 'Time zone (e.g. America/New_York; blank = UTC)', 'tz', false],
      ['location', 'Where', 'text', false],
      ['description', 'About', 'long', false],
      ['url', 'Link', 'url', false],
    ],
  },
  links: {
    label: 'Link list',
    dynamic: true,
    hint: 'A page of links (link in bio). One per line: Label | https://…',
    fields: [
      ['title', 'Title', 'text', true],
      ['description', 'About', 'long', false],
      ['links', 'Links', 'long', true],
    ],
  },
  text: {
    label: 'Text',
    dynamic: false,
    hint: 'Plain text, shown by the scanner.',
    fields: [['text', 'Text', 'long', true]],
  },
  wifi: {
    label: 'Wi-Fi',
    dynamic: false,
    hint: 'Joins a Wi-Fi network. Static: it never touches wx93, so scans are not counted.',
    fields: [
      ['ssid', 'Network name', 'text', true],
      ['password', 'Password', 'text', false],
      ['encryption', 'Security', ['WPA', 'WEP', 'nopass'], false],
      ['hidden', 'Hidden network', 'check', false],
    ],
  },
  email: {
    label: 'Email',
    dynamic: false,
    hint: 'Starts an email.',
    fields: [
      ['to', 'To', 'email', true],
      ['subject', 'Subject', 'text', false],
      ['body', 'Message', 'long', false],
    ],
  },
  phone: { label: 'Phone', dynamic: false, hint: 'Calls a number.', fields: [['number', 'Number', 'tel', true]] },
  sms: {
    label: 'SMS',
    dynamic: false,
    hint: 'Starts a text message.',
    fields: [
      ['number', 'Number', 'tel', true],
      ['message', 'Message', 'long', false],
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    dynamic: false,
    hint: 'Opens a WhatsApp chat.',
    fields: [
      ['number', 'Number with country code', 'tel', true],
      ['message', 'Message', 'long', false],
    ],
  },
  geo: {
    label: 'Location',
    dynamic: false,
    hint: 'Opens a map at a point.',
    fields: [
      ['lat', 'Latitude', 'number', true],
      ['lng', 'Longitude', 'number', true],
      ['label', 'Label', 'text', false],
    ],
  },
  crypto: {
    label: 'Crypto payment',
    dynamic: false,
    hint: 'A wallet address, with an amount if you like (BIP 21 style).',
    fields: [
      ['coin', 'Coin', CRYPTO, true],
      ['address', 'Address', 'text', true],
      ['amount', 'Amount', 'number', false],
      ['label', 'Label', 'text', false],
    ],
  },
};

export const TYPE_NAMES = Object.keys(QR_TYPES);

const LIMIT = { long: 2000, text: 300 };

/** Validated data for `type` from API JSON or form fields. Unknown keys are dropped. */
export function parseQrData(type, input = {}) {
  const def = QR_TYPES[type];
  if (!def) throw new HttpError(400, `type is one of ${TYPE_NAMES.join(', ')}`);
  const out = {};
  for (const [name, label, kind, required] of def.fields) {
    let v = input[name];
    if (kind === 'check') {
      out[name] = v === true || /^(1|true|on|yes)$/i.test(String(v ?? ''));
      continue;
    }
    v = v === undefined || v === null ? '' : String(v).trim();
    if (!v) {
      if (required) throw new HttpError(400, `${label} is required for a ${def.label.toLowerCase()} code`);
      continue;
    }
    if (v.length > (LIMIT[kind] ?? LIMIT.text)) throw new HttpError(400, `${label} is too long`);
    if (Array.isArray(kind)) {
      const hit = kind.find((k) => k.toLowerCase() === v.toLowerCase());
      if (!hit) throw new HttpError(400, `${label} is one of ${kind.join(', ')}`);
      v = hit;
    } else if (kind === 'url') v = checkShape(v).url;
    else if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, `${label} is not an email address`);
    else if (kind === 'tel' && !/^\+?[0-9 ().-]{3,30}$/.test(v)) throw new HttpError(400, `${label} is not a phone number`);
    else if (kind === 'number' && !Number.isFinite(Number(v))) throw new HttpError(400, `${label} is a number`);
    else if (kind === 'datetime' && Number.isNaN(new Date(v).getTime())) throw new HttpError(400, `${label} is a date and time`);
    else if (kind === 'tz' && !validZone(v)) throw new HttpError(400, `${v} is not an IANA time zone`);
    out[name] = v;
  }
  if (type === 'geo' && (Math.abs(Number(out.lat)) > 90 || Math.abs(Number(out.lng)) > 180)) throw new HttpError(400, 'that is not a point on Earth');
  if (type === 'links') {
    const list = parseLinkList(out.links);
    if (!list.length) throw new HttpError(400, 'add at least one link: Label | https://…');
    if (list.length > 50) throw new HttpError(400, 'up to 50 links');
  }
  if (type === 'event' && out.end && new Date(out.end) < new Date(out.start)) throw new HttpError(400, 'the event ends before it starts');
  return out;
}

export function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "Label | https://…" lines, or bare URLs. Every URL passes the same shape check as a short link. */
export function parseLinkList(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.lastIndexOf('|');
      const label = bar >= 0 ? line.slice(0, bar).trim() : '';
      const raw = bar >= 0 ? line.slice(bar + 1).trim() : line;
      const { url } = checkShape(raw);
      return { label: (label || new URL(url).hostname).slice(0, 100), url };
    });
}

/* --------------------------------------------------------------- encoders -- */

// MECARD-style escaping, which the Wi-Fi format borrows.
const wifiEsc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
const vEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const digits = (s) => String(s).replace(/[^\d+]/g, '');
const q = (o) => {
  const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString().replace(/\+/g, '%20');
  return s ? `?${s}` : '';
};

/** iCalendar UTC stamp: 20261020T153000Z. */
export const icsTime = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function vcardText(d) {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${vEsc(d.last ?? '')};${vEsc(d.first ?? '')};;;`,
    `FN:${vEsc([d.first, d.last].filter(Boolean).join(' '))}`,
    d.org && `ORG:${vEsc(d.org)}`,
    d.title && `TITLE:${vEsc(d.title)}`,
    d.phone && `TEL;TYPE=CELL:${digits(d.phone)}`,
    d.email && `EMAIL:${vEsc(d.email)}`,
    d.url && `URL:${d.url}`,
    d.address && `ADR:;;${vEsc(d.address)};;;;`,
    d.note && `NOTE:${vEsc(d.note)}`,
    'END:VCARD',
  ]
    .filter(Boolean)
    .join('\r\n');
}

/**
 * A form's "2026-10-20T15:30" has no zone. With `tz` it is wall time there
 * (DTSTART;TZID=…); without, UTC. A value that names its own offset is UTC'd.
 */
function icsWhen(name, value, tz) {
  const v = String(value);
  if (tz && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return `${name};TZID=${tz}:${v.replace(/[-:]/g, '').padEnd(15, '0')}`;
  return `${name}:${icsTime(OFFSET.test(v) ? v : `${v}Z`)}`;
}

const OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export function icsText(d, { uid = 'wx93', calendar = true } = {}) {
  // No end: an hour after the start, in the start's own terms (wall time stays wall time).
  const zoned = !OFFSET.test(d.start);
  const plusHour = new Date(new Date(zoned ? `${d.start}Z` : d.start).getTime() + 3600_000).toISOString();
  const end = d.end ?? (zoned ? plusHour.slice(0, 16) : plusHour);
  const ev = [
    'BEGIN:VEVENT',
    `UID:${uid}@wx93.me`,
    `DTSTAMP:${icsTime(new Date())}`,
    icsWhen('DTSTART', d.start, d.tz),
    icsWhen('DTEND', end, d.tz),
    `SUMMARY:${vEsc(d.title)}`,
    d.location && `LOCATION:${vEsc(d.location)}`,
    d.description && `DESCRIPTION:${vEsc(d.description)}`,
    d.url && `URL:${d.url}`,
    'END:VEVENT',
  ].filter(Boolean);
  return (calendar ? ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//wx93.me//QR//EN', ...ev, 'END:VCALENDAR'] : ev).join('\r\n');
}

/**
 * The text a STATIC code carries. A dynamic code carries its short link instead;
 * vcard, event and links only reach here when made without saving (the public
 * generator), where the content itself goes in the code.
 */
export function encodeStatic(type, d) {
  switch (type) {
    case 'url':
      return d.url;
    case 'text':
      return d.text;
    case 'wifi':
      return `WIFI:T:${d.encryption && d.encryption !== 'nopass' ? d.encryption : d.password ? 'WPA' : 'nopass'};S:${wifiEsc(d.ssid)};${d.password ? `P:${wifiEsc(d.password)};` : ''}${d.hidden ? 'H:true;' : ''};`;
    case 'email':
      return `mailto:${d.to}${q({ subject: d.subject, body: d.body })}`;
    case 'phone':
      return `tel:${digits(d.number)}`;
    case 'sms':
      return `SMSTO:${digits(d.number)}:${d.message ?? ''}`;
    case 'whatsapp':
      return `https://wa.me/${digits(d.number).replace(/^\+/, '')}${q({ text: d.message })}`;
    case 'geo':
      return `geo:${Number(d.lat)},${Number(d.lng)}${d.label ? `?q=${Number(d.lat)},${Number(d.lng)}(${encodeURIComponent(d.label)})` : ''}`;
    case 'crypto':
      return `${d.coin}:${d.address}${q({ amount: d.amount, label: d.label })}`;
    case 'vcard':
      return vcardText(d);
    case 'event':
      return icsText(d, { calendar: false });
    case 'links':
      return parseLinkList(d.links)
        .map((l) => `${l.label}: ${l.url}`)
        .join('\n');
    default:
      throw new HttpError(400, `type is one of ${TYPE_NAMES.join(', ')}`);
  }
}

/** A short human summary of a code's content, for lists. Never the Wi-Fi password. */
export function summary(type, d) {
  switch (type) {
    case 'url':
      return d.url;
    case 'vcard':
      return [d.first, d.last].filter(Boolean).join(' ') + (d.org ? `, ${d.org}` : '');
    case 'event':
      return `${d.title}, ${String(d.start).slice(0, 16).replace('T', ' ')}`;
    case 'links':
      return d.title;
    case 'wifi':
      return d.ssid;
    case 'email':
      return d.to;
    case 'phone':
    case 'sms':
    case 'whatsapp':
      return d.number;
    case 'geo':
      return d.label || `${d.lat}, ${d.lng}`;
    case 'crypto':
      return `${d.coin} ${String(d.address).slice(0, 12)}…`;
    default:
      return String(d.text ?? '').slice(0, 80);
  }
}
