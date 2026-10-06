/**
 * wx93: short links from the terminal.
 *
 *   wx93 <url> [--alias x] [--expires 7d] [--title t] [--redirect 301] [--domain d] [--qr] [--json]
 *   wx93 login [--manual] | login --key wx93_live_…
 *   wx93 ls | stats <code> | get <code> | rm <code> | qr <code> | expand <url> | bulk <file>
 *   wx93 keys [create NAME | revoke ID] | whoami | upgrade-plan pro|automation [month|year]
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
  wx93 stats CODE [--days 30]    clicks, referrers, countries, devices
  wx93 get CODE | rm CODE | qr CODE|URL | expand URL
  wx93 edit CODE [--url U] [--title T] [--expires 7d] [--redirect 301]
  wx93 bulk FILE|-               one URL per line (Automation)
  wx93 keys [create NAME | revoke ID]
  wx93 plan pro|automation [month|year]   open a crypto checkout
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
      const s = await api.stats(auth, need(rest[0], 'wx93 stats CODE'), { days: flags.days });
      if (json) return out(s), 0;
      console.log(`${s.link.short_url} -> ${s.link.url}`);
      console.log(`last ${s.days} days: ${s.humans} people, ${s.bots} bots`);
      for (const k of ['referrers', 'countries', 'devices', 'browsers']) {
        if (!s[k]?.length) continue;
        console.log(`\n${k}`);
        for (const r of s[k].slice(0, 8)) console.log(`  ${String(r.clicks).padStart(6)}  ${r.key}`);
      }
      if (s.note) say(`\n${s.note}`);
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
    case 'qr': {
      const target = need(rest[0], 'wx93 qr CODE|URL');
      const url = /^https?:\/\//.test(target) ? target : `${auth.server}/${target}`;
      console.log(qrTerminal(url));
      console.log(url);
      return 0;
    }
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
