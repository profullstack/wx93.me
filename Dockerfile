# One image: the Bun web app, its REST API, the hosted MCP endpoint, and the
# bundled CLI the curl installer downloads. dev2 builds this on every merge to main.
FROM oven/bun:1.4.2-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gzip && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock* ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
RUN bun install --production --frozen-lockfile || bun install --production
COPY . .
# The CLI as one file for `curl -fsSL https://wx93.me/install | sh`.
RUN bun build packages/cli/bin/wx93.mjs --target=node --outfile=apps/web/public/dl/wx93.mjs
# DB-IP Lite country database (CC BY 4.0, attributed in the footer). This month's,
# or last month's early in a month; without it every country reads XX.
RUN mkdir -p data && for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do \
      curl -fsSL "https://download.db-ip.com/free/dbip-country-lite-$m.mmdb.gz" | gunzip > data/dbip-country-lite.mmdb && break; \
    done; ls -la data
# dev2's umask 007 leaves copied files unreadable to the bun user otherwise.
RUN chmod -R a+rX /app

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /app /app
USER bun
ENV NODE_ENV=production PORT=3000 GEOIP_DB=/app/data/dbip-country-lite.mmdb
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/web/src/main.js"]
