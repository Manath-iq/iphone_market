import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { InputMediaPhoto, InputMediaVideo } from 'grammy/types';
import { buildCaption, MANAGER_USERNAME, SELLER_TEMPLATE } from '../../shared/caption';
import { formatPrice, listingTitle, parsePost } from '../../shared/parser';
import type { ParsedPost } from '../../shared/types';
import type { Env } from './env';
import { now } from './env';
import { llmFallback } from './llm';
import { api, esc } from './notify';
import { getSeller, touchSeller } from './roles';
import { getSettings } from './settings';
import { clearState, getState, setState } from './state';
import {
  addPart,
  claimPreview,
  getSubmission,
  getSubmissionMedia,
  moveStatus,
  recentDraftWithoutText,
  saveParsed,
  setRawText,
  type SubmissionMedia,
  type SubmissionRow,
} from './submissions';

interface Deps {
  env: Env;
  waitUntil: (p: Promise<unknown>) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Через сколько после последней части альбома показываем превью */
const ALBUM_QUIET_MS = 1500;

export const TEMPLATE_TEXT = [
  '<b>Как выставить телефон</b>',
  '',
  'Пришлите сюда альбом до 10 фото и видео, а к нему подпись по шаблону (можно отдельным сообщением сразу после альбома):',
  '',
  `<pre>${esc(SELLER_TEMPLATE)}</pre>`,
  '',
  '• 💰 — сколько хотите получить вы. Комиссию площадки бот добавит сам и покажет итоговую цену.',
  '• Ники, ссылки и телефоны не пишите — бот их уберёт. Покупатель получит ваш контакт после оплаты.',
  '• Принимаем только iPhone.',
  '',
  'Перед отправкой на проверку бот покажет, как пост увидят покупатели.',
].join('\n');

const BLOCKED_TEXT = `Ваш доступ продавца отключён. Вопросы — @${MANAGER_USERNAME}`;

/** Подача товаров продавцом: альбом с подписью → превью → на проверку. Регистрируется до общего ответа «каталог». */
export function registerSeller(h: Composer<Context>, { env, waitUntil }: Deps) {
  /** Активный продавец в личке; заблокированному сразу отвечаем */
  async function activeSeller(ctx: Context): Promise<boolean | 'blocked'> {
    if (ctx.chat?.type !== 'private' || !ctx.from) return false;
    const s = await getSeller(env, ctx.from.id);
    if (!s) return false;
    if (s.status !== 'active') return 'blocked';
    waitUntil(touchSeller(env, ctx.from));
    return true;
  }

  h.on(['message:photo', 'message:video'], async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    const msg = ctx.message;
    const photo = msg.photo?.[msg.photo.length - 1];
    const part = photo
      ? { msg_id: msg.message_id, kind: 'photo' as const, file_id: photo.file_id, file_size: photo.file_size, width: photo.width, height: photo.height }
      : {
          msg_id: msg.message_id,
          kind: 'video' as const,
          file_id: msg.video!.file_id,
          file_size: msg.video!.file_size,
          width: msg.video!.width,
          height: msg.video!.height,
        };
    const groupKey = msg.media_group_id ?? `m${msg.message_id}`;
    const sub = await addPart(env, ctx.from.id, groupKey, part, msg.caption?.trim() || null);
    if (sub.status !== 'draft') return;
    // превью — когда части альбома перестали приходить; отправит его ровно один из параллельных апдейтов
    waitUntil(
      sleep(ALBUM_QUIET_MS + 500)
        .then(() => previewIfReady(sub.id))
        .catch((e) => console.error('seller preview failed', sub.id, e)),
    );
  });

  h.on('message:document', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    await ctx.reply('Пришлите, пожалуйста, фото и видео как медиа, а не файлом — так их увидят покупатели.');
  });

  h.command('template', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    await ctx.reply(seller === 'blocked' ? BLOCKED_TEXT : TEMPLATE_TEXT, { parse_mode: 'HTML' });
  });

  h.command('my', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    await ctx.reply(await myText(env, ctx.from!.id), { parse_mode: 'HTML' });
  });

  // Текст от продавца: подпись к заявке, которую бот попросил, или описание сразу после альбома
  h.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    const state = await getState(env, ctx.from.id);
    let subId: number | null = null;
    if (state?.kind === 'await_caption') {
      subId = state.ref_id;
      await clearState(env, ctx.from.id);
    } else if (!state) {
      subId = (await recentDraftWithoutText(env, ctx.from.id))?.id ?? null;
    }
    if (!subId) return ctx.reply('Чтобы выставить телефон, пришлите альбом фото с подписью по шаблону — /template. Ваши товары — /my');
    await setRawText(env, subId, ctx.message.text.trim());
    await previewIfReady(subId);
  });

  h.callbackQuery(/^sub_(send|edit|cancel):(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match;
    const id = +idStr;
    const sellerId = ctx.from.id;
    if (action === 'send') {
      const sub = await moveStatus(env, id, ['draft'], 'pending', sellerId);
      if (!sub?.parsed) return ctx.answerCallbackQuery('Эта заявка уже отправлена или отменена');
      await ctx.answerCallbackQuery('Отправлено на проверку');
      await ctx.editMessageText('📤 Отправлено на проверку. Как только модератор опубликует телефон, пришлём номер лота. Ваши товары — /my');
    } else if (action === 'edit') {
      const sub = await getSubmission(env, id);
      if (sub?.seller_id !== sellerId || sub.status !== 'draft') return ctx.answerCallbackQuery('Эту заявку уже нельзя изменить');
      await setState(env, sellerId, 'await_caption', id);
      await ctx.answerCallbackQuery();
      await ctx.reply('Пришлите подпись целиком одним сообщением — фото останутся те же. Шаблон — /template');
    } else {
      const sub = await moveStatus(env, id, ['draft', 'pending'], 'cancelled', sellerId);
      await ctx.answerCallbackQuery(sub ? 'Заявка отменена' : 'Эту заявку уже нельзя отменить');
      if (sub) await ctx.editMessageText('Заявка отменена. Чтобы выставить телефон заново, пришлите альбом с подписью.');
    }
  });

  /** Разбор подписи и превью «так увидят покупатели»; если чего-то не хватает — переспрашиваем */
  async function previewIfReady(id: number) {
    const sub = await claimPreview(env, id, ALBUM_QUIET_MS);
    if (!sub) return;
    const sellerId = sub.seller_id;
    const text = sub.raw_text?.trim() ?? '';
    if (!text) {
      await setState(env, sellerId, 'await_caption', sub.id);
      await api(env).sendMessage(sellerId, 'Фото получили 👍 Теперь пришлите подпись по шаблону одним сообщением. Шаблон — /template');
      return;
    }
    let p: ParsedPost = parsePost(text);
    if (!p.parse_ok) p = await llmFallback(env, text, p);
    if (!p.family && !/iphone|айфон/i.test(text)) {
      await moveStatus(env, sub.id, ['draft'], 'cancelled');
      await api(env).sendMessage(sellerId, 'Пока принимаем только iPhone. Если это iPhone, укажите модель в первой строке: «📱 iPhone 15 Pro 256GB».');
      return;
    }
    const missing = [!p.family && 'модель', !p.storage_gb && 'память', !p.price_rub && 'цену'].filter(Boolean);
    if (missing.length) {
      await saveParsed(env, sub.id, null);
      await setState(env, sellerId, 'await_caption', sub.id);
      await api(env).sendMessage(
        sellerId,
        `Не нашёл в подписи: ${missing.join(', ')}. Пришлите подпись целиком ещё раз одним сообщением, как в шаблоне — /template`,
      );
      return;
    }
    await saveParsed(env, sub.id, p);
    await sendPreview(sub, p);
  }

  async function sendPreview(sub: SubmissionRow, p: ParsedPost) {
    const { fee_rub } = await getSettings(env);
    const sellerPrice = p.price_rub!;
    const caption = buildCaption(p, { price: sellerPrice + fee_rub });
    const media = await getSubmissionMedia(env, sub.id);
    await sendAlbum(env, sub.seller_id, media, caption);
    await api(env).sendMessage(
      sub.seller_id,
      [
        'Так покупатели увидят ваш телефон 👆',
        '',
        `Ваша цена: <b>${formatPrice(sellerPrice)}</b>`,
        `Комиссия площадки: ${formatPrice(fee_rub)}`,
        `Цена для покупателя: <b>${formatPrice(sellerPrice + fee_rub)}</b>`,
        '',
        'Всё верно?',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('📤 Отправить на проверку', `sub_send:${sub.id}`)
          .row()
          .text('✏️ Исправить подпись', `sub_edit:${sub.id}`)
          .text('Отменить', `sub_cancel:${sub.id}`),
      },
    );
  }
}

/** Альбом с подписью на первом элементе; одно фото или видео — обычным сообщением (в альбоме их минимум 2) */
export async function sendAlbum(env: Env, chatId: number | string, media: SubmissionMedia[], caption: string) {
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

interface MyRow {
  id: number;
  status: SubmissionRow['status'];
  parsed: string | null;
  seller_price_rub: number | null;
  lot: number | null;
  l_status: 'active' | 'sold' | 'hidden' | null;
  reserved_until: number | null;
}

/** /my — заявки и товары продавца со статусами */
async function myText(env: Env, sellerId: number): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.status, s.parsed, s.seller_price_rub, l.id AS lot, l.status AS l_status, l.reserved_until
     FROM submissions s LEFT JOIN listings l ON l.id = s.listing_id
     WHERE s.seller_id = ? AND s.status != 'cancelled' AND NOT (s.status = 'draft' AND s.parsed IS NULL)
     ORDER BY s.id DESC LIMIT 20`,
  )
    .bind(sellerId)
    .all<MyRow>();
  if (!results.length) return `Пока ничего нет.\n\n${TEMPLATE_TEXT}`;
  const ts = now();
  const lines = results.map((r) => {
    const p = r.parsed ? (JSON.parse(r.parsed) as ParsedPost) : null;
    const title = esc(p ? listingTitle(p) : 'Телефон');
    const price = r.seller_price_rub ? ` · ${formatPrice(r.seller_price_rub)}` : '';
    let status: string;
    if (r.lot && r.l_status === 'active' && r.reserved_until && r.reserved_until > ts) {
      status = `🔒 забронирован до ${new Date(r.reserved_until * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    } else if (r.lot && r.l_status) {
      status = { active: '🟢 в каталоге', sold: '✅ продан', hidden: '⚪️ снят' }[r.l_status];
    } else {
      status = { draft: '✏️ черновик', pending: '⏳ на проверке', publishing: '⏳ публикуется', published: '🟢 опубликован', rejected: '❌ отклонён', cancelled: 'отменён' }[r.status];
    }
    return `${r.lot ? `<b>Лот №${r.lot}</b> · ` : ''}${title}${price} — ${status}`;
  });
  return `<b>Ваши товары</b>\n\n${lines.join('\n')}`;
}

