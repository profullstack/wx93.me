/**
 * wx93: short links from the terminal.
 *
 *   wx93 <url> [--alias x] [--expires 7d] [--title t] [--redirect 301] [--domain d] [--qr] [--json]
 *   wx93 login [--manual] | login --key wx93_live_…
 *   wx93 ls | stats <code> | get <code> | rm <code> | qr <code> | expand <url> | bulk <file>
 *   wx93 keys [create NAME | revoke ID] | whoami | upgrade-plan pro|automation [month|year]
 *   wx93 redeem CODE | invites [create [NOTE]]
 *   wx93 tui | mcp | upgrade | uninstall | version
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as api from './client.js';
import { qrTerminal } from './qr.js';

const HELP = `wx93: short links for people and agents (https://wx93.me)

  wx93 <url> [--alias NAME] [--expires 7d] [--title T] [--redirect 301|302|307|308] [--domain wx93.me|9xq.me|yours] [--qr]
  wx93 login [--manual]          sign in through your browser (OAuth 2.1; --manual over SSH)
  wx93 login --key wx93_live_…   or use an API key from wx93.me/account
  wx93 logout | whoami
  wx93 ls [--limit N] [--q TEXT] your links
  wx93 stats CODE [--days 30] [--tz ZONE] [--source qr|link]
                                 clicks, scans, unique visitors, countries, cities, devices
  wx93 get CODE | rm CODE | qr CODE|URL | expand URL
  wx93 qr new TYPE key=value… [--name N] [--png|--svg|--pdf FILE] [--logo FILE] [style]
                                 a saved QR code (wx93 qr types lists TYPE and its keys)
  wx93 qr ls | qr get ID [--png|--svg|--pdf FILE] [--size N] | qr rm ID
  wx93 qr edit ID key=value… [--name N] [--logo FILE | --no-logo] [style]
  wx93 qr stats ID [--days 30] [--tz Europe/Berlin] [--source qr|link]
    style: --fg '#1d4ed8' --bg '#fff' --eye '#db2777' --dots square|rounded|dots
           --eye-frame square|rounded|circle --eye-ball square|rounded|circle --ecc L|M|Q|H
  wx93 edit CODE [--url U] [--title T] [--expires 7d] [--redirect 301]
  wx93 bulk FILE|-               one URL per line (Automation)
  wx93 keys [create NAME | revoke ID]
  wx93 plan pro|automation [month|year]   open a crypto checkout
  wx93 redeem CODE               redeem a credit code for days of Pro
  wx93 invites [create [NOTE]]   your invite links (3 per account; both sides get a week of Pro)
  wx93 tui                       everything above, as a screen
  wx93 mcp                       stdio MCP server for agents
  wx93 upgrade | uninstall | version

Flags: --json for machine output, --server URL, --key KEY.
Environment: WX93_API_KEY, WX93_URL. No sign-in needed for free links.`;

export function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const say = (line) => process.stderr.write(`${line}\n`);
const looksLikeUrl = (s) => /^https?:\/\//i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s);
const shareDir = () => join(process.env.WX93_PREFIX || join(homedir(), '.local'), 'share', 'wx93');

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (flags.version || cmd === 'version') {
    console.log(api.VERSION);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const auth = await api.resolveAuth({ server: flags.server, key: flags.key });
  const json = flags.json === true;
  const out = (data, text) => console.log(json ? JSON.stringify(data, null, 2) : text);

  switch (cmd) {
    case 'login': {
      const key = typeof flags.key === 'string' ? flags.key : rest[0];
      if (key) {
        if (!key.startsWith('wx93_live_')) throw new Error('that does not look like a wx93 key (wx93_live_…)');
        const m = await api.me({ ...auth, key });
        const file = await api.saveConfig({ key, server: auth.server });
        say(`Signed in as ${m.user.email} (${m.plan.name}) with an API key. Saved to ${file}.`);
        return 0;
      }
      const { login } = await import('@profullstack/auth-system/cli');
      const store = api.tokenStore();
      await login({
        issuer: auth.server,
        clientId: 'wx93-cli',
        scope: 'read write',
        store,
        manual: flags.manual === true ? true : undefined,
        manualRedirectUri: `${auth.server}/oauth/cli`,
      });
      const m = await api.me(await api.resolveAuth({ server: auth.server }));
      say(`Signed in as ${m.user.email} (${m.plan.name}). The CLI, TUI, MCP server and desktop app share this sign-in.`);
      return 0;
    }
    case 'logout': {
      const { logout } = await import('@profullstack/auth-system/cli');
      const had = await logout({ store: api.tokenStore() }).catch(() => false);
      const cfg = await api.loadConfig();
      if (cfg.key) await api.saveConfig({ key: undefined });
      say(had || cfg.key ? 'Signed out.' : 'Not signed in.');
      return 0;
    }
    case 'whoami':
    case 'me': {
      const m = await api.me(auth);
      out(m, `${m.user.email} · ${m.plan.name}${m.plan.paid_through ? ` (paid through ${String(m.plan.paid_through).slice(0, 10)})` : ''} · ${m.usage.links_this_month}/${m.limits.links_per_month} links this month · via ${auth.via}`);
      return 0;
    }
    case 'ls':
    case 'list': {
      const { links } = await api.list(auth, { limit: flags.limit, q: flags.q });
      out(links, links.map((l) => `${l.short_url.padEnd(30)} ${String(l.human_clicks).padStart(6)}  ${l.url}`).join('\n') || 'No links yet.');
      return 0;
    }
    case 'get': {
      const l = await api.getLink(auth, need(rest[0], 'wx93 get CODE'));
      out(l, `${l.short_url} -> ${l.url}\n${l.human_clicks} people, ${l.clicks - l.human_clicks} bots${l.expires_at ? ` · expires ${l.expires_at}` : ''}`);
      return 0;
    }
    case 'stats': {
      const s = await api.stats(auth, need(rest[0], 'wx93 stats CODE'), { days: flags.days, tz: flags.tz, source: flags.source });
      if (json) return out(s), 0;
      console.log(`${s.link.short_url} -> ${s.link.url}`);
      printStats(s);
      return 0;
    }
    case 'edit': {
      const patch = {};
      if (flags.url) patch.url = flags.url;
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.expires) patch.expires_in = flags.expires;
      if (flags.redirect) patch.redirect_type = Number(flags.redirect);
      const l = await api.updateLink(auth, need(rest[0], 'wx93 edit CODE --url …'), patch);
      out(l, `${l.short_url} -> ${l.url}`);
      return 0;
    }
    case 'rm':
    case 'delete': {
      const r = await api.deleteLink(auth, need(rest[0], 'wx93 rm CODE'));
      out(r, `deleted ${r.code}`);
      return 0;
    }
    case 'qr':
      return qrCommand(auth, rest, flags, { json, out });
    case 'expand': {
      const r = await api.expand(auth, need(rest[0], 'wx93 expand URL'));
      out(r, r.disabled ? `${r.code}: removed` : r.expired ? `${r.code}: expired (${r.url})` : r.url);
      return 0;
    }
    case 'bulk': {
      const src = need(rest[0], 'wx93 bulk FILE (or - for stdin)');
      const text = src === '-' ? await new Response(process.stdin).text() : await readFile(src, 'utf8');
      const urls = text.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
      const r = await api.bulk(auth, urls.map((url) => ({ url })));
      out(r, r.results.map((x) => (x.ok ? `${x.link.short_url}\t${x.link.url}` : `ERROR\t${x.error}\t${x.input?.url ?? ''}`)).join('\n'));
      say(`${r.created} created, ${r.failed} failed`);
      return r.failed ? 2 : 0;
    }
    case 'keys': {
      if (rest[0] === 'create') {
        const k = await api.createKey(auth, rest[1] ?? 'cli');
        out(k, `${k.key}\n(shown once; store it now)`);
      } else if (rest[0] === 'revoke') {
        out(await api.revokeKey(auth, need(rest[1], 'wx93 keys revoke ID')), 'revoked');
      } else {
        const { keys } = await api.keys(auth);
        out(keys, keys.map((k) => `${k.id}  ${k.prefix}…  ${k.name}`).join('\n') || 'No keys.');
      }
      return 0;
    }
    case 'plan': {
      const r = await api.checkout(auth, need(rest[0], 'wx93 plan pro|automation [month|year]'), rest[1] ?? 'month', flags.chain);
      out(r, `Pay here (crypto, ${(r.quote.amount_cents / 100).toFixed(2)} USD):\n${r.checkout_url}`);
      return 0;
    }
    case 'redeem': {
      const r = await api.redeem(auth, need(rest[0], 'wx93 redeem CR-XXXX-XXXX-XXXX-XXXX'));
      out(r, `Redeemed: ${r.days} days of Pro. Plan now: ${r.plan}.`);
      return 0;
    }
    case 'invites':
    case 'invite': {
      if (rest[0] === 'create' || rest[0] === 'new') {
        const r = await api.createInvite(auth, rest.slice(1).join(' ') || undefined);
        out(r, `${r.url}\n(works once, for one new account; shown once)`);
        return 0;
      }
      const r = await api.invites(auth);
      out(
        r,
        [`${r.quota.left} of ${r.quota.total} invites left; ${r.accepted} joined.`, ...r.invites.map((i) => `${i.id}  ${i.used ? 'joined' : i.revoked ? 'withdrawn' : 'open'}  ${i.note ?? ''}`)].join('\n'),
      );
      return 0;
    }
    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(auth);
      return 0;
    }
    case 'mcp': {
      const { serve } = await import('./mcp.js');
      serve(process.stdin, process.stdout, { server: flags.server, key: flags.key });
      await new Promise(() => {});
      return 0;
    }
    case 'upgrade':
    case 'update': {
      if (existsSync(join(shareDir(), 'uninstall.sh'))) {
        return spawnSync('sh', ['-c', `curl -fsSL ${auth.server}/install | sh -s -- --upgrade`], { stdio: 'inherit' }).status ?? 1;
      }
      return spawnSync('npm', ['install', '-g', '@profullstack/wx93@latest'], { stdio: 'inherit' }).status ?? 1;
    }
    case 'uninstall': {
      const script = join(shareDir(), 'uninstall.sh');
      if (existsSync(script)) return spawnSync('sh', [script], { stdio: 'inherit' }).status ?? 1;
      say('Not installed by the curl installer. If you used npm: npm uninstall -g @profullstack/wx93');
      return 1;
    }
    default: {
      if (!looksLikeUrl(cmd)) throw new Error(`unknown command "${cmd}" (wx93 help)`);
      const input = { url: cmd };
      if (flags.alias) input.alias = flags.alias;
      if (flags.expires) input.expires_in = flags.expires;
      if (flags.title) input.title = flags.title;
      if (flags.redirect) input.redirect_type = Number(flags.redirect);
      if (flags.domain) input.domain = flags.domain;
      const l = await api.shorten(auth, input);
      out(l, l.short_url);
      if (flags.qr && !json) console.log(qrTerminal(l.short_url));
      if (!l.ad_free && !json) say('Free link: people see a short ad page first. wx93 plan pro to skip it.');
      return 0;
    }
  }
}

function need(v, usage) {
  if (!v) throw new Error(`usage: ${usage}`);
  return v;
}

/* ---------------------------------------------------------------- QR codes -- */

const STYLE_FLAGS = { fg: 'fg', bg: 'bg', eye: 'eye', dots: 'dots', 'eye-frame': 'eye_frame', 'eye-ball': 'eye_ball', ecc: 'ecc', margin: 'margin', transparent: 'transparent' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHADES = ' ░▒▓█';

function styleFlags(flags) {
  const style = {};
  for (const [flag, key] of Object.entries(STYLE_FLAGS)) if (flags[flag] !== undefined) style[key] = flags[flag];
  return Object.keys(style).length ? style : undefined;
}

/** key=value pairs; the value keeps any later "=" (URLs have them). */
function pairs(list) {
  const data = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at < 1) throw new Error(`expected key=value, got "${item}" (wx93 qr types lists the keys)`);
    data[item.slice(0, at)] = item.slice(at + 1);
  }
  return data;
}

const IMAGE_FLAGS = ['png', 'svg', 'pdf'];

async function saveImages(auth, id, flags) {
  const { writeFile } = await import('node:fs/promises');
  for (const f of IMAGE_FLAGS) {
    if (typeof flags[f] !== 'string') continue;
    await writeFile(flags[f], await api.qrImage(auth, id, f, { size: flags.size }));
    say(`wrote ${flags[f]}`);
  }
}

async function logoFlag(auth, id, flags) {
  if (flags['no-logo']) return api.removeQrLogo(auth, id);
  if (typeof flags.logo !== 'string') return null;
  const data = await readFile(flags.logo);
  return api.setQrLogo(auth, id, data, /\.jpe?g$/i.test(flags.logo) ? 'image/jpeg' : 'image/png');
}

const qrLine = (q) => `${q.id}  ${q.type.padEnd(8)} ${q.dynamic ? String(q.scans).padStart(6) : '     -'}  ${q.name}${q.short_url ? `  ${q.short_url}` : ''}`;

function printStats(s) {
  console.log(`last ${s.days} days: ${s.humans} people, ${s.scans ?? 0} QR scans, ${s.visitors ?? 0} unique, ${s.bots} bots`);
  if (s.week) console.log(`this week ${s.week.this_week} (${s.week.change_pct === null ? 'new' : `${s.week.change_pct > 0 ? '+' : ''}${s.week.change_pct}%`}) · last hour ${s.live.last_hour}`);
  for (const k of ['sources', 'countries', 'cities', 'devices', 'os', 'browsers', 'referrers']) {
    if (!s[k]?.length) continue;
    console.log(`\n${k}`);
    for (const r of s[k].slice(0, 8)) console.log(`  ${String(r.clicks).padStart(6)}  ${r.key}`);
  }
  if (s.heatmap) {
    const peak = Math.max(1, ...s.heatmap.flat());
    console.log(`\nwhen (${s.tz})\n      0     6     12    18`);
    s.heatmap.forEach((row, d) => console.log(`  ${DAYS[d]} ${row.map((n) => (n ? SHADES[Math.max(1, Math.ceil((4 * n) / peak))] : '·')).join('')}`));
  }
  if (s.note) say(`\n${s.note}`);
}

async function qrCommand(auth, rest, flags, { json, out }) {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'types': {
      const t = await api.qrTypes(auth);
      out(t, t.types.map((x) => `${x.type.padEnd(9)} ${x.dynamic ? 'dynamic' : 'static '}  ${x.fields.map((f) => `${f.name}${f.required ? '*' : ''}`).join(' ')}`).join('\n'));
      return 0;
    }
    case 'new':
    case 'create': {
      const type = need(args[0], 'wx93 qr new TYPE key=value…');
      const input = { type, data: pairs(args.slice(1)), style: styleFlags(flags) };
      for (const k of ['name', 'domain', 'alias']) if (typeof flags[k] === 'string') input[k] = flags[k];
      let q = await api.createQr(auth, input);
      if (flags.logo) q = await logoFlag(auth, q.id, flags);
      await saveImages(auth, q.id, flags);
      out(q, `${q.id}\n${q.short_url ?? q.encodes}`);
      if (!json && !IMAGE_FLAGS.some((f) => flags[f])) console.log(qrTerminal(q.encodes));
      return 0;
    }
    case 'ls':
    case 'list': {
      const r = await api.listQr(auth, { limit: flags.limit, q: flags.q });
      out(r.qr_codes, r.qr_codes.map(qrLine).join('\n') || 'No QR codes yet.');
      if (!json) say(`${r.total} of ${r.limit}`);
      return 0;
    }
    case 'get':
    case 'show': {
      const q = await api.getQr(auth, need(args[0], 'wx93 qr get ID'));
      await saveImages(auth, q.id, flags);
      out(q, `${qrLine(q)}\nencodes ${q.encodes}`);
      if (!json && !IMAGE_FLAGS.some((f) => flags[f])) console.log(qrTerminal(q.encodes));
      return 0;
    }
    case 'edit': {
      const id = need(args[0], 'wx93 qr edit ID key=value…');
      const patch = {};
      if (args.length > 1) patch.data = pairs(args.slice(1));
      if (typeof flags.name === 'string') patch.name = flags.name;
      const style = styleFlags(flags);
      if (style) patch.style = style;
      let q = Object.keys(patch).length ? await api.updateQr(auth, id, patch) : await api.getQr(auth, id);
      q = (await logoFlag(auth, id, flags)) ?? q;
      await saveImages(auth, id, flags);
      out(q, qrLine(q));
      return 0;
    }
    case 'stats': {
      const s = await api.qrStats(auth, need(args[0], 'wx93 qr stats ID'), { days: flags.days, tz: flags.tz, source: flags.source });
      if (json) return out(s), 0;
      console.log(qrLine(s.qr));
      if (s.static) say(s.note);
      else printStats(s);
      return 0;
    }
    case 'rm':
    case 'delete': {
      const r = await api.deleteQr(auth, need(args[0], 'wx93 qr rm ID'));
      out(r, `deleted ${r.id}`);
      return 0;
    }
    default: {
      // wx93 qr CODE|URL: any link's code, in the terminal.
      const target = need(sub, 'wx93 qr CODE|URL');
      const url = /^https?:\/\//.test(target) ? target : `${auth.server}/${target}`;
      console.log(qrTerminal(url));
      console.log(url);
      return 0;
    }
  }
}
