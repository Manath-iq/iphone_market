import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { acceptInvite, createInvite, isMainOwner, isOwner, isStaff, setModActive } from '../src/roles';

/** Настоящий SQLite с миграциями проекта и тонкая обёртка с методами D1, которые нужны roles.ts */
function testEnv(): Env {
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

const MAIN = 1;
const client = { id: 2, username: 'client' };

describe('владелец по ссылке', () => {
  it('ссылка /invite_admin делает владельцем со всеми правами', async () => {
    const env = testEnv();
    expect(await isOwner(env, client.id)).toBe(false);
    const code = await createInvite(env, 'owner', MAIN);
    expect(await acceptInvite(env, code, 'owner', client)).toEqual({ ok: true, role: 'owner' });
    expect(await isOwner(env, client.id)).toBe(true);
    expect(await isStaff(env, client.id)).toBe(true);
    // главный владелец — только из ADMIN_IDS
    expect(isMainOwner(env, client.id)).toBe(false);
  });

  it('ссылка одноразовая, повторно владельцу не нужна', async () => {
    const env = testEnv();
    const code = await createInvite(env, 'owner', MAIN);
    await acceptInvite(env, code, 'owner', client);
    expect(await acceptInvite(env, code, 'owner', { id: 3 })).toEqual({ ok: false, reason: 'used' });
    const again = await createInvite(env, 'owner', MAIN);
    expect(await acceptInvite(env, again, 'owner', client)).toEqual({ ok: false, reason: 'already' });
    expect(await acceptInvite(env, await createInvite(env, 'owner', MAIN), 'owner', { id: MAIN })).toEqual({ ok: false, reason: 'already' });
  });

  it('модератор по ссылке владельца становится владельцем', async () => {
    const env = testEnv();
    await acceptInvite(env, await createInvite(env, 'mod', MAIN), 'mod', client);
    expect(await isOwner(env, client.id)).toBe(false);
    await acceptInvite(env, await createInvite(env, 'owner', MAIN), 'owner', client);
    expect(await isOwner(env, client.id)).toBe(true);
  });

  it('ссылка на модератора не понижает владельца, а отключённый владелец теряет права', async () => {
    const env = testEnv();
    await acceptInvite(env, await createInvite(env, 'owner', MAIN), 'owner', client);
    expect(await acceptInvite(env, await createInvite(env, 'mod', MAIN), 'mod', client)).toEqual({ ok: false, reason: 'already' });
    expect(await isOwner(env, client.id)).toBe(true);
    await setModActive(env, client.id, false);
    expect(await isOwner(env, client.id)).toBe(false);
    expect(await isStaff(env, client.id)).toBe(false);
    // по ссылке модератора отключённый владелец возвращается модератором, а не владельцем
    await acceptInvite(env, await createInvite(env, 'mod', MAIN), 'mod', client);
    expect(await isStaff(env, client.id)).toBe(true);
    expect(await isOwner(env, client.id)).toBe(false);
  });
});
