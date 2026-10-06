import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Forward-only migrations, one transaction each, run on every boot before the
 * server listens, so a deploy cannot skip one. The advisory lock makes two
 * containers booting together safe. There is no `down`: the fix goes forward.
 */
export async function migrate({ log = console.log } = {}) {
  const sql = db();
  await sql`select pg_advisory_lock(9009001)`;
  try {
    await sql`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )`;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await sql`select filename from schema_migrations`).map((r) => r.filename));
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[migrate] applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (filename) values (${file})`;
      });
      ran++;
    }
    log(ran ? `[migrate] applied ${ran} migration(s)` : '[migrate] up to date');
    return ran;
  } finally {
    await sql`select pg_advisory_unlock(9009001)`;
  }
}
