import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../src/env';

/** Настоящий SQLite с миграциями проекта и тонкая обёртка с методами D1, которые нужны модулям воркера */
export function testEnv(): Env {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => prepare(sql, a),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => db.prepare(sql).run(...(args as never[])),
  });
  return { DB: { prepare }, ADMIN_IDS: '1' } as unknown as Env;
}
