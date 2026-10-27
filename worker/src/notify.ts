import { Api, InlineKeyboard } from 'grammy';
import type { InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import { formatPrice, listingTitle } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { staffIds } from './roles';
import type { SubmissionMedia } from './submissions';

export const api = (env: Env) => new Api(env.BOT_TOKEN);

export const cardUrl = (origin: string, id: number) => `${origin}/?l=${id}`;

export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export function shortLine(l: ListingRow): string {
  const parts = [listingTitle(l)];
  if (l.battery_pct) parts.push(`АКБ ${l.battery_pct}%`);
  if (l.price_rub) parts.push(formatPrice(l.price_rub));
  return parts.join(', ');
}

/** Первое фото карточки для сообщения: file_id из Telegram, своё хранилище или ссылка CDN импорта */
async function coverPhoto(env: Env, origin: string, listingId: number): Promise<string | null> {
  const m = await env.DB.prepare(
    `SELECT source, storage_key FROM media WHERE listing_id = ? AND kind = 'photo' ORDER BY position LIMIT 1`,
  )
    .bind(listingId)
    .first<{ source: string; storage_key: string | null }>();
  if (!m) return null;
  if (m.source.startsWith('tg:')) return m.source.slice(3);
  if (m.storage_key && m.storage_key !== 'skip') return `${origin}/media/${m.storage_key}`;
  return m.source;
}

/** Сообщение с фото телефона, а если фото нет или Telegram его не принял — обычным текстом */
async function sendCard(env: Env, chatId: number, text: string, keyboard?: InlineKeyboard, photo?: string | null) {
  if (photo) {
    try {
      await api(env).sendPhoto(chatId, photo, { caption: text, parse_mode: 'HTML', reply_markup: keyboard });
      return;
    } catch (e) {
      console.warn('photo send failed, falling back to text', chatId, String(e));
    }
  }
  await api(env).sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } });
}

/** Владельцу и модераторам */
export async function toStaff(env: Env, text: string, keyboard?: InlineKeyboard, photo?: string | null) {
  await Promise.all(
    (await staffIds(env)).map((id) => sendCard(env, id, text, keyboard, photo).catch((e) => console.warn('staff send failed', id, String(e)))),
  );
}

/** Превью новой карточки из канала сотрудникам с кнопками подтверждения */
export async function sendAdminPreview(env: Env, origin: string, l: ListingRow) {
  const nuances: string[] = JSON.parse(l.nuances);
  const lines = [
    l.parse_ok ? '🆕 <b>Новая карточка в каталоге</b>' : '⚠️ <b>Проверьте карточку</b> — пост разобран не полностью',
    '',
    `<b>${esc(listingTitle(l))}</b> — ${l.price_rub ? formatPrice(l.price_rub) : 'цена не найдена'}`,
    [l.condition, l.battery_pct && `АКБ ${l.battery_pct}%`, l.sim].filter(Boolean).map((s) => esc(String(s))).join(' · '),
    nuances.length ? `Нюансы: ${esc(nuances.join('; '))}` : '',
    '',
    `<a href="${l.post_url}">Пост в канале</a> · id ${l.id}`,
  ].filter((s, i, a) => s !== '' || a[i - 1] !== '');
  const kb = new InlineKeyboard()
    .text('✅ Всё верно', `ok:${l.id}`)
    .text('🙈 Скрыть', `hide:${l.id}`)
    .row()
    .webApp('Открыть в каталоге', cardUrl(origin, l.id));
  await toStaff(env, lines.join('\n'), kb, await coverPhoto(env, origin, l.id));
}

/**
 * Разослать новую карточку подписчикам, у которых совпали модель, память и потолок цены.
 * limit держит запуск в бесплатном лимите (50 подзапросов): остальным разошлёт часовой cron (catchUpNotifications) —
 * кому уже отправили, видно по таблице notifications. Возвращает число отправленных.
 */
export async function notifySubscribers(env: Env, origin: string, l: ListingRow, limit = 15): Promise<number> {
  if (l.status !== 'active' || !l.family) return 0;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.tg_user_id FROM subscriptions s
     WHERE s.active = 1 AND s.family = ?
       AND (s.storage_gb IS NULL OR s.storage_gb = ?)
       AND (s.max_price IS NULL OR ? <= s.max_price)
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.listing_id = ? AND n.tg_user_id = s.tg_user_id)
     LIMIT ?`,
  )
    .bind(l.family, l.storage_gb, l.price_rub ?? 0, l.id, limit)
    .all<{ tg_user_id: number }>();
  if (!results.length) return 0;
  const kb = new InlineKeyboard().webApp('Открыть карточку', cardUrl(origin, l.id));
  const photo = await coverPhoto(env, origin, l.id);
  let sent = 0;
  for (const { tg_user_id } of results) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO notifications (listing_id, tg_user_id, sent_at) VALUES (?, ?, ?)')
      .bind(l.id, tg_user_id, now())
      .run();
    if (!r.meta.changes) continue;
    sent++;
    await sendCard(env, tg_user_id, `🔔 Появился <b>${esc(shortLine(l))}</b>`, kb, photo).catch((e) =>
      console.warn('notify failed', tg_user_id, String(e)),
    );
  }
  return sent;
}

/** Дорассылка подписчикам по карточкам за последние сутки, которым не хватило лимита при публикации */
export async function catchUpNotifications(env: Env, origin: string, budget = 10) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM listings WHERE status = 'active' AND family IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(now() - 86400)
    .all<ListingRow>();
  let sent = 0;
  for (const l of results) {
    if (sent >= budget) break;
    sent += await notifySubscribers(env, origin, l, budget - sent);
  }
  return { sent };
}

export async function statsText(env: Env, days = 7): Promise<string> {
  const since = now() - days * 86400;
  const { results } = await env.DB.prepare(
    `SELECT type, COUNT(*) AS c, COUNT(DISTINCT tg_user_id) AS u FROM events WHERE created_at >= ? GROUP BY type`,
  )
    .bind(since)
    .all<{ type: string; c: number; u: number }>();
  const by = Object.fromEntries(results.map((r) => [r.type, r]));
  const top = await env.DB.prepare(
    `SELECT l.family, l.storage_gb, COUNT(*) AS c FROM events e JOIN listings l ON l.id = e.listing_id
     WHERE e.type = 'card_view' AND e.created_at >= ? AND l.family IS NOT NULL GROUP BY l.family ORDER BY c DESC LIMIT 3`,
  )
    .bind(since)
    .all<{ family: string; c: number }>();
  const active = await env.DB.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'active'`).first<{ c: number }>();
  const sold = await env.DB.prepare(`SELECT COUNT(*) AS c FROM listings WHERE sold_at >= ?`).bind(since).first<{ c: number }>();
  // сделки площадки: оплаченные комиссии, брони без продажи, топ продавцов (ники видят только сотрудники)
  const pays = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(amount_rub), 0) AS sum, COALESCE(SUM(mode = 'test'), 0) AS test
     FROM payments WHERE status = 'paid' AND paid_at >= ?`,
  )
    .bind(since)
    .first<{ c: number; sum: number; test: number }>();
  const expired = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM listings WHERE status = 'active' AND reserve_paid = 1 AND reserve_notified = 1 AND reserved_until >= ?`,
  )
    .bind(since)
    .first<{ c: number }>();
  const sellers = await env.DB.prepare(
    `SELECT l.seller_id, s.username, s.first_name, COUNT(*) AS c FROM payments p
     JOIN listings l ON l.id = p.listing_id LEFT JOIN sellers s ON s.tg_user_id = l.seller_id
     WHERE p.status = 'paid' AND p.paid_at >= ? GROUP BY l.seller_id ORDER BY c DESC LIMIT 3`,
  )
    .bind(since)
    .all<{ seller_id: number | null; username: string | null; first_name: string | null; c: number }>();
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS c FROM submissions WHERE status = 'pending'`).first<{ c: number }>();
  const sellerName = (r: { seller_id: number | null; username: string | null; first_name: string | null }) =>
    r.seller_id ? (r.username ? `@${esc(r.username)}` : esc(r.first_name ?? String(r.seller_id))) : 'ваши посты в канале';
  const n = (t: string) => by[t]?.c ?? 0;
  return [
    `📊 <b>Статистика за ${days} дней</b>`,
    '',
    `Открытий каталога: <b>${n('app_open')}</b> (${by.app_open?.u ?? 0} чел.)`,
    `Просмотров карточек: <b>${n('card_view')}</b>`,
    `Оформлений покупки: <b>${n('buy_click')}</b> (${by.buy_click?.u ?? 0} чел.)`,
    `Новых подписок: <b>${n('subscribe')}</b>`,
    '',
    `В наличии сейчас: ${active?.c ?? 0} · продано за период: ${sold?.c ?? 0}`,
    '',
    `💳 Оплат: <b>${pays?.c ?? 0}</b> на ${formatPrice(pays?.sum ?? 0)}${pays?.test ? ` (из них тестовых: ${pays.test})` : ''}`,
    `Броней без продажи: ${expired?.c ?? 0} · заявок ждут проверки: ${pending?.c ?? 0}`,
    sellers.results.length ? `Топ продавцов по оплатам:\n${sellers.results.map((r, i) => `${i + 1}. ${sellerName(r)} — ${r.c}`).join('\n')}` : '',
    top.results.length ? `\nТоп моделей по просмотрам:\n${top.results.map((t, i) => `${i + 1}. iPhone ${esc(t.family)} — ${t.c}`).join('\n')}` : '',
  ].join('\n');
}

export async function sendWeeklyStats(env: Env) {
  await toStaff(env, await statsText(env));
}

/** Альбом с подписью на первом элементе; одно фото или видео — обычным сообщением (в альбоме их минимум 2) */
export async function sendAlbum(env: Env, chatId: number | string, media: Pick<SubmissionMedia, 'kind' | 'file_id'>[], caption: string) {
  if (media.length === 1) {
    const [m] = media;
    const opts = { caption, parse_mode: 'HTML' as const };
    return [m.kind === 'video' ? await api(env).sendVideo(chatId, m.file_id, opts) : await api(env).sendPhoto(chatId, m.file_id, opts)];
  }
  return api(env).sendMediaGroup(
    chatId,
    media.slice(0, 10).map(
      (m, i): InputMediaPhoto | InputMediaVideo => ({
        type: m.kind,
        media: m.file_id,
        ...(i === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
      }),
    ),
  );
}
