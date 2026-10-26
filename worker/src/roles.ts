import type { Env } from './env';
import { adminIds, now } from './env';

/**
 * Роли площадки. Владелец — из секрета ADMIN_IDS, модераторы и продавцы — строки в D1.
 * Сотрудник и продавец — независимые признаки: владелец может быть и продавцом (удобно для проверки с одного аккаунта).
 */

export interface Person {
  id: number;
  username?: string;
  first_name?: string;
}

export interface SellerRow {
  tg_user_id: number;
  username: string | null;
  first_name: string | null;
  status: 'active' | 'blocked';
  invited_by: number | null;
  created_at: number;
}

export interface StaffRow {
  tg_user_id: number;
  username: string | null;
  first_name: string | null;
  active: number;
  created_at: number;
}

export const isOwner = (env: Env, userId: number) => adminIds(env).includes(userId);

export async function isMod(env: Env, userId: number): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 FROM staff WHERE tg_user_id = ? AND active = 1').bind(userId).first();
  return !!r;
}

export async function isStaff(env: Env, userId: number): Promise<boolean> {
  return isOwner(env, userId) || isMod(env, userId);
}

/** Кому слать служебные сообщения: владельцы и активные модераторы */
export async function staffIds(env: Env): Promise<number[]> {
  const { results } = await env.DB.prepare('SELECT tg_user_id FROM staff WHERE active = 1').all<{ tg_user_id: number }>();
  return [...new Set([...adminIds(env), ...results.map((r) => r.tg_user_id)])];
}

export async function getSeller(env: Env, userId: number) {
  return env.DB.prepare('SELECT * FROM sellers WHERE tg_user_id = ?').bind(userId).first<SellerRow>();
}

/** Ник продавца может смениться — обновляем при каждом его сообщении */
export async function touchSeller(env: Env, u: Person) {
  await env.DB.prepare('UPDATE sellers SET username = ?, first_name = ?, updated_at = ? WHERE tg_user_id = ?')
    .bind(u.username ?? null, u.first_name ?? null, now(), u.id)
    .run();
}

export type InviteRole = 'seller' | 'mod';
const INVITE_TTL = 86400;

/** Код из 10 символов base64url — угадать перебором нереально */
export async function createInvite(env: Env, role: InviteRole, createdBy: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 10);
  const ts = now();
  await env.DB.prepare('INSERT INTO invites (code, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(code, role, createdBy, ts, ts + INVITE_TTL)
    .run();
  return code;
}

export type InviteResult =
  | { ok: true; role: InviteRole }
  | { ok: false; reason: 'not_found' | 'used' | 'expired' | 'no_username' | 'already' };

/**
 * Принять приглашение. Ссылка одноразовая: «тратится» одним атомарным UPDATE, поэтому два перехода
 * по одной ссылке не сделают продавцами двоих. Продавцу без @username ссылку не тратим — ник выдаём покупателям.
 */
export async function acceptInvite(env: Env, code: string, role: InviteRole, u: Person): Promise<InviteResult> {
  if (role === 'seller') {
    if (!u.username) return { ok: false, reason: 'no_username' };
    const s = await getSeller(env, u.id);
    if (s?.status === 'active') return { ok: false, reason: 'already' };
  } else if (await isMod(env, u.id)) {
    return { ok: false, reason: 'already' };
  }
  const ts = now();
  const used = await env.DB.prepare(
    `UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND role = ? AND used_by IS NULL AND expires_at > ? RETURNING created_by`,
  )
    .bind(u.id, ts, code, role, ts)
    .first<{ created_by: number }>();
  if (!used) {
    const inv = await env.DB.prepare('SELECT used_by, expires_at FROM invites WHERE code = ? AND role = ?')
      .bind(code, role)
      .first<{ used_by: number | null; expires_at: number }>();
    return { ok: false, reason: !inv ? 'not_found' : inv.used_by ? 'used' : 'expired' };
  }
  if (role === 'seller') {
    await env.DB.prepare(
      `INSERT INTO sellers (tg_user_id, username, first_name, status, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (tg_user_id) DO UPDATE SET status = 'active', username = excluded.username,
         first_name = excluded.first_name, invited_by = excluded.invited_by, updated_at = excluded.updated_at`,
    )
      .bind(u.id, u.username ?? null, u.first_name ?? null, used.created_by, ts, ts)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO staff (tg_user_id, role, username, first_name, added_by, active, created_at)
       VALUES (?, 'mod', ?, ?, ?, 1, ?)
       ON CONFLICT (tg_user_id) DO UPDATE SET active = 1, username = excluded.username, first_name = excluded.first_name`,
    )
      .bind(u.id, u.username ?? null, u.first_name ?? null, used.created_by, ts)
      .run();
  }
  return { ok: true, role };
}

export async function listSellers(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM sellers ORDER BY status, created_at DESC').all<SellerRow>();
  return results;
}

export async function listMods(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM staff ORDER BY active DESC, created_at DESC').all<StaffRow>();
  return results;
}

export async function setSellerStatus(env: Env, userId: number, status: 'active' | 'blocked') {
  return env.DB.prepare('UPDATE sellers SET status = ?, updated_at = ? WHERE tg_user_id = ? RETURNING *')
    .bind(status, now(), userId)
    .first<SellerRow>();
}

export async function setModActive(env: Env, userId: number, active: boolean) {
  return env.DB.prepare('UPDATE staff SET active = ? WHERE tg_user_id = ? RETURNING *').bind(+active, userId).first<StaffRow>();
}

/** «@nick» или имя-ссылка, если ника нет; текст для parse_mode HTML */
export function personLink(p: { id: number; username?: string | null; first_name?: string | null }) {
  if (p.username) return `@${p.username}`;
  const name = (p.first_name ?? 'без имени').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `<a href="tg://user?id=${p.id}">${name}</a>`;
}
