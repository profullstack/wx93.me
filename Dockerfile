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
# DB-IP Lite databases (CC BY 4.0, attributed in the footer). This month's, or
# last month's early in a month. The city one (~130 MB, memory-mapped at run time)
# gives country and city; the small country one is the fallback if it is missing.
# Without either, every country reads XX. Kept outside /app: see the COPY below.
RUN mkdir -p /geo && for db in city country; do for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"; do \
      curl -fsSL "https://download.db-ip.com/free/dbip-$db-lite-$m.mmdb.gz" | gunzip > /geo/dbip-$db-lite.mmdb && break; \
    done; done; find /geo -size 0 -delete; ls -la /geo
# dev2's umask 007 leaves copied files unreadable to the bun user otherwise.
RUN chmod -R a+rX /app

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /app /app
# Bun.mmap opens its file read-write even for a private mapping, so the databases
# belong to the runtime user; the app's own code stays root-owned.
COPY --from=build --chown=bun:bun /geo /app/data
USER bun
ENV NODE_ENV=production PORT=3000 GEOIP_DB=/app/data/dbip-country-lite.mmdb GEOIP_CITY_DB=/app/data/dbip-city-lite.mmdb
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/web/src/main.js"]
