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
  /** iphone — подпись по шаблону, other — мастер: название, цена, фото, описание */
  category: 'iphone' | 'other';
  title: string | null;
  description: string | null;
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
  await insertMedia(env, sub.id, part);
  return sub;
}

const insertMedia = (env: Env, subId: number, part: IncomingPart) =>
  env.DB.prepare(
    `INSERT OR IGNORE INTO submission_media (submission_id, msg_id, kind, file_id, file_size, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(subId, part.msg_id, part.kind, part.file_id, part.file_size ?? null, part.width ?? null, part.height ?? null)
    .run();

/** Ключ заявки мастера, пока к ней не пришли фото: уникален и не совпадает ни с одним альбомом */
const wizardKey = () => `w${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * Новая заявка «другой товар». Брошенные незаконченные заявки мастера этого продавца отменяем,
 * чтобы в /my и в ответах бота не путались старые черновики.
 */
export async function createWizard(env: Env, sellerId: number) {
  const ts = now();
  await env.DB.prepare(
    `UPDATE submissions SET status = 'cancelled', updated_at = ?
     WHERE seller_id = ? AND status = 'draft' AND category = 'other' AND parsed IS NULL`,
  )
    .bind(ts, sellerId)
    .run();
  const sub = await env.DB.prepare(
    `INSERT INTO submissions (seller_id, group_key, status, category, last_part_at, created_at, updated_at)
     VALUES (?, ?, 'draft', 'other', 0, ?, ?) RETURNING *`,
  )
    .bind(sellerId, wizardKey(), ts, ts)
    .first<SubmissionRow>();
  if (!sub) throw new Error('wizard insert failed');
  return sub;
}

/**
 * Фото к заявке мастера. Первая часть отдаёт заявке ключ альбома: части, пришедшие уже после того,
 * как бот перестал ждать фото, найдут ту же заявку через addPart, а не создадут новую.
 * Подпись к альбому считаем описанием, если его ещё нет.
 */
export async function addPartTo(env: Env, subId: number, groupKey: string, part: IncomingPart, caption: string | null) {
  await env.DB.prepare(
    `UPDATE submissions SET
       group_key = CASE WHEN group_key LIKE 'w%' AND NOT EXISTS (
         SELECT 1 FROM submissions o WHERE o.seller_id = submissions.seller_id AND o.group_key = ?) THEN ? ELSE group_key END,
       description = COALESCE(description, ?), last_part_at = ?, preview_sent = 0, parsed = NULL, updated_at = ?
     WHERE id = ? AND status = 'draft'`,
  )
    .bind(groupKey, groupKey, caption, Date.now(), now(), subId)
    .run();
  await insertMedia(env, subId, part);
}

/** Поля заявки мастера. Сбрасываем разбор и превью: отправить на проверку можно только после нового превью */
export async function setWizardFields(env: Env, id: number, f: { title?: string; seller_price_rub?: number; description?: string | null }) {
  const sets = Object.keys(f).map((k) => `${k} = ?`);
  await env.DB.prepare(
    `UPDATE submissions SET ${sets.join(', ')}, parsed = NULL, preview_sent = 0, last_part_at = 0, updated_at = ?
     WHERE id = ? AND status = 'draft'`,
  )
    .bind(...Object.values(f), now(), id)
    .run();
}

/** «Исправить фото»: старые убираем, новый альбом ляжет на их место */
export async function clearMedia(env: Env, id: number) {
  await env.DB.prepare('DELETE FROM submission_media WHERE submission_id = ?').bind(id).run();
  await env.DB.prepare(`UPDATE submissions SET group_key = ?, parsed = NULL, updated_at = ? WHERE id = ? AND status = 'draft'`)
    .bind(wizardKey(), now(), id)
    .run();
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
    `SELECT * FROM submissions WHERE seller_id = ? AND status = 'draft' AND category = 'iphone' AND (raw_text IS NULL OR raw_text = '')
       AND last_part_at > ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(sellerId, Date.now() - 10 * 60 * 1000)
    .first<SubmissionRow>();
}

export const parsedOf = (s: SubmissionRow): ParsedPost | null => (s.parsed ? JSON.parse(s.parsed) : null);
