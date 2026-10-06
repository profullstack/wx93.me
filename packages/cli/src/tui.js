/**
 * wx93 tui: your short links in a terminal, on hqtui.
 *
 * Left: a box to shorten into, and your links. Right: the selected link and its
 * numbers. One click (or ↑/↓) selects. `n` or `/` types a new URL, Enter shortens
 * it; `o` opens the link, `d` twice deletes it, `r` refreshes, `q` quits.
 */
import { createApp } from '@profullstack/hqtui';
import { deleteLink, list, me, shorten, stats } from './client.js';

export function initialState() {
  return { draft: '', editing: false, links: null, selected: 0, detail: null, who: null, status: 'Loading…', confirm: false };
}

/** The whole screen as a pure function of state, so tests can render it. */
export function view(state) {
  return ({ ui, theme }) => {
    const links = state.links ?? [];
    ui.column({ gap: 0 }, (root) => {
      root.row({ gap: 1, size: '1fr' }, (row) => {
        row.column({ size: '48%', gap: 0 }, (left) => {
          left.panel({ title: 'wx93 · short links', subtitle: state.who ? `${state.who.user.email} · ${state.who.plan.name}` : 'not signed in', titleColor: theme.accent, size: 4 }, (p) => {
            p.textInput({ value: state.draft, placeholder: 'press n, paste a long URL, Enter', focused: state.editing, label: 'new ' });
            p.text(state.who ? `${state.who.usage.links_this_month}/${state.who.limits.links_per_month} links this month` : 'Free links work without signing in: wx93 login for yours', { fg: theme.muted });
          });
          left.panel({ title: 'Your links', size: '1fr' }, (p) => {
            if (!links.length) p.text(state.links ? 'None yet. Press n.' : state.who ? 'Loading…' : 'Sign in (wx93 login) to list your links.', { fg: theme.muted });
            else
              p.list({
                items: links.map((l) => ({ label: `${l.short_url.replace(/^https?:\/\//, '').padEnd(22).slice(0, 22)} ${String(l.human_clicks).padStart(6)}  ${l.url}` })),
                selected: state.selected,
                followSelection: true,
                scrollbar: true,
                size: '1fr',
                onSelectRow: (i) => state.onPick?.(i),
              });
          });
        });
        row.panel({ title: state.detail?.link?.short_url?.replace(/^https?:\/\//, '') ?? 'Details', size: '1fr' }, (p) => {
          const d = state.detail;
          if (!d) return p.text(links.length ? 'Pick a link with ↑/↓ or a click.' : '', { fg: theme.muted });
          p.text(`→ ${d.link.url}`, { wrap: true });
          p.text(`${d.link.ad_free ? 'direct redirect' : 'free: people see the ad page'} · ${d.link.redirect_type} · created ${String(d.link.created_at).slice(0, 10)}`, { fg: theme.muted });
          p.text('');
          p.text(`last ${d.days} days: ${d.humans} people, ${d.bots} bots`, { fg: theme.accent });
          for (const k of ['referrers', 'countries', 'devices', 'browsers']) {
            if (!d[k]?.length) continue;
            p.text('');
            p.text(k, { fg: theme.muted });
            for (const r of d[k].slice(0, 5)) p.text(`${String(r.clicks).padStart(6)}  ${r.key}`);
          }
          if (d.note) p.text(d.note, { fg: theme.muted, wrap: true });
        });
      });
      root.statusBar({
        items: [
          { key: 'n', label: 'new' },
          { key: 'o', label: 'open' },
          { key: 'd', label: state.confirm ? 'press d again to delete' : 'delete' },
          { key: 'r', label: 'refresh' },
          { key: 'q', label: 'quit' },
        ],
        right: [{ label: state.status }],
      });
    });
  };
}

export async function runTui(auth) {
  const state = initialState();
  const app = await createApp({ fps: 20, quitKeys: [], mouse: true });
  const redraw = () => app.invalidate();

  const loadDetail = async () => {
    const l = state.links?.[state.selected];
    state.detail = null;
    if (!l) return redraw();
    try {
      state.detail = await stats(auth, l.id, { days: 30 });
    } catch (err) {
      state.status = err.message;
    }
    redraw();
  };
  const load = async () => {
    if (!auth.key) {
      state.status = `anonymous · ${auth.server.replace(/^https?:\/\//, '')}`;
      return redraw();
    }
    try {
      state.who = await me(auth);
      state.links = (await list(auth, { limit: 200 })).links;
      state.selected = Math.min(state.selected, Math.max(0, state.links.length - 1));
      state.status = `${state.links.length} links · ${auth.server.replace(/^https?:\/\//, '')}`;
      await loadDetail();
    } catch (err) {
      state.status = err.message;
    }
    redraw();
  };
  state.onPick = (i) => {
    state.selected = i;
    state.confirm = false;
    void loadDetail();
  };

  const create = async () => {
    const url = state.draft.trim();
    if (!url) return;
    state.status = 'Shortening…';
    redraw();
    try {
      const l = await shorten(auth, url);
      state.draft = '';
      state.status = `✓ ${l.short_url}${l.ad_free ? '' : ' (free: ad page for people)'}`;
      if (state.links) {
        state.links.unshift(l);
        state.selected = 0;
        await loadDetail();
      }
    } catch (err) {
      state.status = err.message;
    }
    redraw();
  };

  app.on('key', (ev) => {
    if (state.editing) {
      if (ev.name === 'enter') {
        state.editing = false;
        void create();
      } else if (ev.name === 'escape') state.editing = false;
      else if (ev.name === 'backspace') state.draft = state.draft.slice(0, -1);
      else if (ev.char && !ev.ctrl) state.draft += ev.char;
      return redraw();
    }
    if (ev.key === 'ctrl+c' || ev.char === 'q') return app.quit();
    const n = state.links?.length ?? 0;
    if ((ev.name === 'up' || ev.name === 'down' || ev.char === 'k' || ev.char === 'j') && n) {
      const up = ev.name === 'up' || ev.char === 'k';
      state.onPick((state.selected + (up ? -1 : 1) + n) % n);
    } else if (ev.char === 'n' || ev.char === '/') state.editing = true;
    else if (ev.char === 'r') void load();
    else if (ev.char === 'o' && state.detail) {
      import('node:child_process').then(({ spawn }) => {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
        spawn(cmd, [state.detail.link.short_url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      });
    } else if (ev.char === 'd' && state.detail) {
      if (!state.confirm) state.confirm = true;
      else {
        state.confirm = false;
        deleteLink(auth, state.detail.link.id)
          .then(() => {
            state.status = `deleted ${state.detail.link.code}`;
            return load();
          })
          .catch((err) => {
            state.status = err.message;
            redraw();
          });
      }
    }
    redraw();
  });

  app.render(view(state));
  void load();
  await app.start();
}

/** The screen as plain text, for tests and screenshots without a terminal. */
export async function renderScreen(state, options = { width: 120, height: 30 }) {
  const { renderToText } = await import('@profullstack/hqtui/testing');
  return renderToText(view(state), options);
}
