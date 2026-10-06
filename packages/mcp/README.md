# @profullstack/wx93-mcp

MCP server for [wx93.me](https://wx93.me): shorten URLs, list links and read click stats from any MCP client.

```json
{ "mcpServers": { "wx93": { "command": "npx", "args": ["-y", "@profullstack/wx93-mcp"] } } }
```

Auth: run `wx93 login` once (OAuth 2.1), or set `WX93_API_KEY`. Without either, free links still work. Hosted alternative: `POST https://wx93.me/mcp`.

Tools: shorten_url, bulk_shorten, list_links, get_link, link_stats, update_link, delete_link, expand_link, whoami.

Docs: https://wx93.me/docs · Source: https://github.com/profullstack/wx93.me · MIT
