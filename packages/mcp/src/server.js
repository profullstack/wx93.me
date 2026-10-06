/**
 * @profullstack/wx93-mcp: the stdio MCP server. The tools live in the CLI package
 * (@profullstack/wx93/tools) so `wx93 mcp`, this package and the hosted
 * https://wx93.me/mcp serve exactly the same thing.
 */
export { serve } from '@profullstack/wx93/mcp';
export { handle, TOOLS } from '@profullstack/wx93/tools';
