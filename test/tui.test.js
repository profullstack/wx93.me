import { expect, test } from 'bun:test';
import { initialState, renderScreen } from '../packages/cli/src/tui.js';

test('the TUI renders links and a link\'s numbers without a terminal', async () => {
  const state = initialState();
  state.who = { user: { email: 'a@example.test' }, plan: { name: 'Pro' }, usage: { links_this_month: 3 }, limits: { links_per_month: 5000 } };
  state.links = [{ id: '1', code: 'abc123', short_url: 'https://wx93.me/abc123', url: 'https://example.com/long', human_clicks: 42 }];
  state.detail = {
    link: { ...state.links[0], ad_free: true, redirect_type: 302, created_at: '2026-10-06T00:00:00Z' },
    days: 30,
    humans: 42,
    bots: 7,
    referrers: [{ key: 'news.example.com', clicks: 30 }],
    countries: [{ key: 'US', clicks: 20 }],
  };
  const text = await renderScreen(state, { width: 120, height: 30 });
  expect(text).toContain('wx93.me/abc123');
  expect(text).toContain('42 people, 7 bots');
  expect(text).toContain('news.example.com');
});
