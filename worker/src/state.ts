import type { Env } from './env';
import { now } from './env';

/**
 * Чего бот ждёт от человека следующим сообщением: подпись к заявке, причину отказа, новую цену.
 * Одна строка на человека: новое ожидание заменяет старое.
 */
export type StateKind = 'await_caption' | 'await_reason' | 'await_price';

export interface BotState {
  kind: StateKind;
  ref_id: number;
  created_at: number;
}

/** ожидание забывается через сутки, чтобы случайное сообщение через неделю не ушло не туда */
const TTL = 86400;

export async function setState(env: Env, userId: number, kind: StateKind, refId: number) {
  await env.DB.prepare(
    `INSERT INTO bot_state (tg_user_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (tg_user_id) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, created_at = excluded.created_at`,
  )
    .bind(userId, kind, refId, now())
    .run();
}

export async function getState(env: Env, userId: number): Promise<BotState | null> {
  const s = await env.DB.prepare('SELECT kind, ref_id, created_at FROM bot_state WHERE tg_user_id = ?').bind(userId).first<BotState>();
  return s && now() - s.created_at < TTL ? s : null;
}

export async function clearState(env: Env, userId: number) {
  await env.DB.prepare('DELETE FROM bot_state WHERE tg_user_id = ?').bind(userId).run();
}
