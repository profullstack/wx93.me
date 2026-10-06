/**
 * wx93 over MCP on stdio: newline-delimited JSON-RPC 2.0. Auth is the `wx93 login`
 * sign-in or WX93_API_KEY; with neither, free links still work.
 */
import { createInterface } from 'node:readline';
import { resolveAuth } from './client.js';
import { handle } from './tools.js';

export function serve(input = process.stdin, output = process.stdout, { server, key } = {}) {
  const rl = createInterface({ input });
  const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const auth = () => resolveAuth({ server, key });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    if (req.id === undefined || req.id === null) return; // a notification
    try {
      write({ jsonrpc: '2.0', id: req.id, result: await handle(req, { auth }) });
    } catch (err) {
      write({ jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32603, message: String(err.message) } });
    }
  });
  return rl;
}
