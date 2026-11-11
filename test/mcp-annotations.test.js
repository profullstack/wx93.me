import { describe, expect, test } from 'bun:test';
import { handle } from '../packages/cli/src/tools.js';

// Claude + ChatGPT directory rules: a human title and explicit hint booleans on every tool.
describe('mcp tool annotations', () => {
  test('every tool in tools/list has a title and readOnly/destructive/openWorld hints', async () => {
    const { tools } = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: async () => null });
    expect(tools.length).toBe(25);
    for (const t of tools) {
      expect(typeof t.title === 'string' && t.title.length > 0).toBe(true);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof t.annotations?.[hint]).toBe('boolean');
      }
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint).toBe(false);
    }
  });
});
