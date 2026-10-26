import type { ParsedPost } from '../../shared/types';
import type { Env } from './env';
import { now } from './env';

export type SubmissionStatus = 'draft' | 'pending' | 'publishing' | 'published' | 'rejected' | 'cancelled';

export interface SubmissionRow {
  id: number;
  seller_id: number;
  group_key: string;
  status: SubmissionStatus;
  raw_text: string | null;
  parsed: string | null;
  seller_price_rub: number | null;
  preview_sent: number;
  last_part_at: number;
  decided_by: number | null;
  reject_reason: string | null;
  listing_id: number | null;
  created_at: number;
  updated_at: number;
}

export interface SubmissionMedia {
  id: number;
  msg_id: number;
  kind: 'photo' | 'video';
  file_id: string;
  file_size: number | null;
  width: number | null;
  height: number | null;
}

export interface IncomingPart {
  msg_id: number;
  kind: 'photo' | 'video';
  file_id: string;
  file_size?: number | null;
  width?: number | null;
  height?: number | null;
}

/**
 * Часть альбома от продавца. Части приходят отдельными апдейтами в любом порядке, поэтому заявка
 * создаётся или находится по (продавец, альбом), а время последней части сдвигается — превью шлём, когда части кончились.
 * Если превью уже ушло, а часть пришла позже, превью отправится заново.
 */
export async function addPart(env: Env, sellerId: number, groupKey: string, part: IncomingPart, caption: string | null) {
  const ts = now();
  const sub = await env.DB.prepare(
    `INSERT INTO submissions (seller_id, group_key, status, raw_text, last_part_at, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?)
     ON CONFLICT (seller_id, group_key) DO UPDATE SET
       raw_text = COALESCE(excluded.raw_text, raw_text),
       last_part_at = excluded.last_part_at,
       preview_sent = CASE WHEN status = 'draft' THEN 0 ELSE preview_sent END,
       updated_at = excluded.updated_at
     RETURNING id, status`,
  )
    .bind(sellerId, groupKey, caption, Date.now(), ts, ts)
    .first<{ id: number; status: SubmissionStatus }>();
  if (!sub) throw new Error('submission upsert failed');
  await env.DB.prepare(
    `INSERT OR IGNORE INTO submission_media (submission_id, msg_id, kind, file_id, file_size, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(sub.id, part.msg_id, part.kind, part.file_id, part.file_size ?? null, part.width ?? null, part.height ?? null)
    .run();
  return sub;
}

/**
 * «Захватить» отправку превью: вернёт заявку, только если части не приходили quietMs и превью ещё не отправлено.
 * Один атомарный UPDATE — из нескольких параллельных апдейтов альбома превью отправит ровно один.
 */
export async function claimPreview(env: Env, id: number, quietMs = 1500) {
  return env.DB.prepare(
    `UPDATE submissions SET preview_sent = 1, updated_at = ?
     WHERE id = ? AND status = 'draft' AND preview_sent = 0 AND last_part_at <= ? RETURNING *`,
  )
    .bind(now(), id, Date.now() - quietMs)
    .first<SubmissionRow>();
}

/** Новая подпись от продавца: превью можно отправлять сразу */
export async function setRawText(env: Env, id: number, text: string) {
  await env.DB.prepare(`UPDATE submissions SET raw_text = ?, preview_sent = 0, last_part_at = 0, updated_at = ? WHERE id = ? AND status = 'draft'`)
    .bind(text, now(), id)
    .run();
}

export async function saveParsed(env: Env, id: number, parsed: ParsedPost | null) {
  await env.DB.prepare('UPDATE submissions SET parsed = ?, seller_price_rub = ?, updated_at = ? WHERE id = ?')
    .bind(parsed ? JSON.stringify(parsed) : null, parsed?.price_rub ?? null, now(), id)
    .run();
}

/** Перевод заявки из одного статуса в другой; null — заявка уже в другом статусе (кто-то успел раньше) */
export async function moveStatus(env: Env, id: number, from: SubmissionStatus[], to: SubmissionStatus, sellerId?: number) {
  return env.DB.prepare(
    `UPDATE submissions SET status = ?, updated_at = ?
     WHERE id = ? AND status IN (${from.map(() => '?').join(', ')}) ${sellerId ? 'AND seller_id = ?' : ''} RETURNING *`,
  )
    .bind(to, now(), id, ...from, ...(sellerId ? [sellerId] : []))
    .first<SubmissionRow>();
}

export async function getSubmission(env: Env, id: number) {
  return env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first<SubmissionRow>();
}

export async function getSubmissionMedia(env: Env, id: number) {
  const { results } = await env.DB.prepare('SELECT * FROM submission_media WHERE submission_id = ? ORDER BY msg_id')
    .bind(id)
    .all<SubmissionMedia>();
  return results;
}

/** Свежий черновик без подписи: продавцы часто шлют альбом, а описание — следующим сообщением */
export async function recentDraftWithoutText(env: Env, sellerId: number) {
  return env.DB.prepare(
    `SELECT * FROM submissions WHERE seller_id = ? AND status = 'draft' AND (raw_text IS NULL OR raw_text = '')
       AND last_part_at > ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(sellerId, Date.now() - 10 * 60 * 1000)
    .first<SubmissionRow>();
}

export const parsedOf = (s: SubmissionRow): ParsedPost | null => (s.parsed ? JSON.parse(s.parsed) : null);
