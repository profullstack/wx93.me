import postgres from 'postgres';

/**
 * One pool per process, created on first use so unit tests (and the CLI build)
 * can import the web app without a database. Production refuses to boot
 * without DATABASE_URL; see apps/web/src/main.js. The URL comes from the vault
 * via deploy-app.sh, never a committed .env.
 */
let client = null;

export const configured = () => Boolean(process.env.DATABASE_URL);

export function db() {
  if (!configured()) throw new Error('DATABASE_URL is not set');
  client ??= postgres(process.env.DATABASE_URL, {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return client;
}

/** True when `select 1` comes back through the SAME pool the requests use. */
export async function healthcheck() {
  const [row] = await db()`select 1 as ok`;
  return row?.ok === 1;
}

export async function close() {
  if (client) await client.end({ timeout: 5 });
  client = null;
}
