import { InlineKeyboard, type Composer, type Context } from 'grammy';
import type { ListingRow } from './db';
import { buildCaption, descriptionOverflow, MANAGER_USERNAME, SELLER_TEMPLATE, stripContacts } from '../../shared/caption';
import { formatPrice, listingTitle, parsePost } from '../../shared/parser';
import type { ParsedPost } from '../../shared/types';
import type { Env } from './env';
import { now } from './env';
import { llmFallback } from './llm';
import { api, esc, sendAlbum, toStaff } from './notify';
import { getSeller, personLink, touchSeller } from './roles';
import { getSettings } from './settings';
import { clearState, getState, setState, WIZARD_STATES, type StateKind } from './state';
import { sendToModeration } from './moderation';
import { sendWithCard } from './cards';
import { applyStatus } from './publish';
import {
  addPart,
  addPartTo,
  claimPreview,
  clearMedia,
  createWizard,
  getSubmission,
  getSubmissionMedia,
  moveStatus,
  recentDraftWithoutText,
  saveParsed,
  setRawText,
  setWizardFields,
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
  '',
  'Перед отправкой на проверку бот покажет, как пост увидят покупатели.',
  '',
  'Не iPhone? Нажмите /new → «Другой товар»: бот спросит название, цену, фото и описание.',
].join('\n');

/** Название другого товара — первая строка поста и заголовок карточки */
const TITLE_MAX = 60;

const CHOOSE_KB = new InlineKeyboard().text('📱 iPhone', 'new:iphone').text('📦 Другой товар', 'new:other');

/** Разбор цены продавца: «15000», «15 000 ₽», «15к» */
export function parseSellerPrice(text: string): number | null {
  const m = text.replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)(к|k|тыс)?/i);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1].replace(',', '.')) * (m[2] ? 1000 : 1));
  return n >= 100 && n <= 10_000_000 ? n : null;
}

/** Другой товар в виде разобранного поста: название в model_raw, характеристик iPhone нет */
export function otherParsed(title: string, price: number): ParsedPost {
  return {
    category: 'other', model_raw: title, family: null, storage_gb: null, status: 'active', condition: null, sim: null,
    has_physical_sim: null, battery_pct: null, battery_cycles: null, ios: null, pluses: [], nuances: [], kit: null,
    full_kit: false, price_rub: price, parse_ok: true,
  };
}

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
    const caption = msg.caption?.trim() || null;
    // идёт мастер «другой товар» — фото ложатся в его заявку, иначе это альбом iPhone по шаблону
    const wizard = await wizardSubmission(ctx.from.id);
    if (wizard) await addPartTo(env, wizard.id, groupKey, part, caption);
    const sub = wizard ?? (await addPart(env, ctx.from.id, groupKey, part, caption));
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

  /** Заявка мастера, к которой сейчас относятся сообщения продавца; null — мастер не идёт */
  async function wizardSubmission(sellerId: number): Promise<SubmissionRow | null> {
    const st = await getState(env, sellerId);
    if (!st || !WIZARD_STATES.includes(st.kind)) return null;
    const sub = await getSubmission(env, st.ref_id);
    return sub?.seller_id === sellerId && sub.status === 'draft' && sub.category === 'other' ? sub : null;
  }

  h.command('new', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    await ctx.reply('Что выставляем?', { reply_markup: CHOOSE_KB });
  });

  h.callbackQuery(/^new:(iphone|other)$/, async (ctx) => {
    const seller = await activeSeller(ctx);
    if (seller !== true) return ctx.answerCallbackQuery(seller === 'blocked' ? BLOCKED_TEXT : 'Выставлять товары могут только продавцы');
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (ctx.match[1] === 'iphone') {
      await clearState(env, ctx.from.id);
      await sendWithCard(env, ctx.chat!.id, 'seller', TEMPLATE_TEXT);
      return;
    }
    const sub = await createWizard(env, ctx.from.id);
    await setState(env, ctx.from.id, 'await_title', sub.id);
    await ctx.reply(`📦 <b>Другой товар</b>\n\n${QUESTIONS.await_title}`, { parse_mode: 'HTML' });
  });

  h.command('template', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    await sendWithCard(env, ctx.chat!.id, 'seller', TEMPLATE_TEXT);
  });

  h.command('my', async (ctx, next) => {
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    const { text, kb } = await myView(env, ctx.from!.id);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
  });

  // «Продан» и «Снять» из /my: бот правит подпись поста в канале, карточка уходит из каталога
  h.callbackQuery(/^my_(sold|hide):(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match;
    const l = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(+idStr).first<ListingRow>();
    if (!l || l.seller_id !== ctx.from.id || l.status !== 'active') return ctx.answerCallbackQuery('Этот товар уже снят');
    await applyStatus(env, l.id, action === 'sold' ? 'sold' : 'hidden');
    await ctx.answerCallbackQuery(action === 'sold' ? 'Отмечено: продан' : 'Снято с продажи');
    const { text, kb } = await myView(env, ctx.from.id);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => {});
    waitUntil(
      toStaff(env, `${action === 'sold' ? '✅' : '⛔️'} ${personLink(ctx.from)} ${action === 'sold' ? 'отметил проданным' : 'снял с продажи'} <a href="${l.post_url}">лот №${l.id}</a> — ${esc(listingTitle(l))}`),
    );
  });

  // Текст от продавца: шаг мастера, подпись к заявке, которую бот попросил, или описание сразу после альбома
  h.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const seller = await activeSeller(ctx);
    if (!seller) return next();
    if (seller === 'blocked') return ctx.reply(BLOCKED_TEXT);
    const state = await getState(env, ctx.from.id);
    if (state && WIZARD_STATES.includes(state.kind)) {
      const wizard = await wizardSubmission(ctx.from.id);
      if (wizard) return wizardText(ctx, wizard, state.kind, ctx.message.text);
      await clearState(env, ctx.from.id);
    }
    let subId: number | null = null;
    if (state?.kind === 'await_caption') {
      subId = state.ref_id;
      await clearState(env, ctx.from.id);
    } else if (!state || WIZARD_STATES.includes(state.kind)) {
      subId = (await recentDraftWithoutText(env, ctx.from.id))?.id ?? null;
    }
    if (!subId) return ctx.reply('Чтобы выставить товар, нажмите /new. Ваши товары — /my');
    await setRawText(env, subId, ctx.message.text.trim());
    await previewIfReady(subId);
  });

  /** Ответ на шаг мастера: проверить, сохранить и перейти к следующему недостающему полю (или к превью) */
  async function wizardText(ctx: Context, sub: SubmissionRow, kind: StateKind, raw: string) {
    const text = raw.trim();
    if (kind === 'await_title') {
      const title = stripContacts(text.replace(/\s+/g, ' '));
      if (!title) return ctx.reply('Напишите название товара одной строкой, например «AirPods Pro 2».');
      if (title.length > TITLE_MAX) return ctx.reply(`Название длинновато: ${title.length} символов, а можно до ${TITLE_MAX}. Подробности напишете в описании.`);
      await setWizardFields(env, sub.id, { title });
    } else if (kind === 'await_seller_price') {
      const price = parseSellerPrice(text);
      if (!price) return ctx.reply('Не понял цену. Пришлите число в рублях, например 15000.');
      await setWizardFields(env, sub.id, { seller_price_rub: price });
    } else if (kind === 'await_desc') {
      if (!text) return ctx.reply(QUESTIONS.await_desc);
      // описание сохраняем как написано, с переносами строк; контакты вычистит подпись поста
      await setWizardFields(env, sub.id, { description: raw.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '') });
    } else {
      return ctx.reply('Жду фото и видео — пришлите их одним альбомом. Начать заново — /new');
    }
    await previewIfReady(sub.id);
  }

  /** Что спросить на каждом шаге мастера */
  const QUESTIONS: Record<string, string> = {
    await_title: `Как называется товар? Одной строкой, до ${TITLE_MAX} символов. Например: «AirPods Pro 2» или «Apple Watch Series 9 45 мм».`,
    await_seller_price: 'Сколько хотите получить за товар, в рублях? Комиссию площадки бот добавит сам.',
    await_media: 'Пришлите фото и видео товара одним альбомом — до 10 штук.',
    await_desc:
      'Теперь описание. Пишите как удобно: состояние, комплект, нюансы. Переносы строк сохранятся, а ники, ссылки и телефоны бот уберёт — покупатель получит ваш контакт после оплаты.',
  };

  /** Следующий шаг мастера: спросить первое недостающее поле или показать превью */
  async function wizardNext(sub: SubmissionRow) {
    const sellerId = sub.seller_id;
    const ask = async (kind: StateKind, text: string) => {
      await setState(env, sellerId, kind, sub.id);
      await api(env).sendMessage(sellerId, text, { parse_mode: 'HTML' });
    };
    if (!sub.title) return ask('await_title', QUESTIONS.await_title);
    if (!sub.seller_price_rub) return ask('await_seller_price', QUESTIONS.await_seller_price);
    const media = await getSubmissionMedia(env, sub.id);
    if (!media.length) {
      const { fee_rub } = await getSettings(env);
      return ask(
        'await_media',
        `Цена для покупателя с комиссией площадки: <b>${formatPrice(sub.seller_price_rub + fee_rub)}</b>.\n\n${QUESTIONS.await_media}`,
      );
    }
    if (!sub.description) return ask('await_desc', QUESTIONS.await_desc);
    const over = descriptionOverflow(sub.title, sub.description, sub.seller_price_rub + (await getSettings(env)).fee_rub);
    if (over) {
      await setWizardFields(env, sub.id, { description: null });
      return ask(
        'await_desc',
        `Описание не помещается в пост: Telegram разрешает подпись до 1024 символов, нужно сократить ещё на ${over}. Пришлите описание целиком заново, покороче.`,
      );
    }
    await clearState(env, sellerId);
    const p = otherParsed(sub.title, sub.seller_price_rub);
    await saveParsed(env, sub.id, p);
    await sendPreview(sub, p, media);
  }

  /** Разбор подписи и превью «так увидят покупатели»; если чего-то не хватает — переспрашиваем */
  async function previewIfReady(id: number) {
    const sub = await claimPreview(env, id, ALBUM_QUIET_MS);
    if (!sub) return;
    if (sub.category === 'other') return wizardNext(sub);
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
      await api(env).sendMessage(
        sellerId,
        'Не нашёл в подписи модель iPhone. Если это iPhone, укажите модель в первой строке: «📱 iPhone 15 Pro 256GB». Другой товар — /new → «Другой товар».',
      );
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

  async function sendPreview(sub: SubmissionRow, p: ParsedPost, media?: SubmissionMedia[]) {
    const { fee_rub } = await getSettings(env);
    const sellerPrice = p.price_rub!;
    const caption = buildCaption({ ...p, description: sub.description }, { price: sellerPrice + fee_rub });
    media ??= await getSubmissionMedia(env, sub.id);
    await sendAlbum(env, sub.seller_id, media, caption);
    await api(env).sendMessage(
      sub.seller_id,
      [
        `Так покупатели увидят ваш ${p.category === 'other' ? 'товар' : 'телефон'} 👆`,
        ...(media.length > 10 ? ['', `В пост попадут первые 10 фото и видео из ${media.length}.`] : []),
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
          .text(p.category === 'other' ? '✏️ Исправить' : '✏️ Исправить подпись', `sub_edit:${sub.id}`)
          .text('Отменить', `sub_cancel:${sub.id}`),
      },
    );
  }
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

/** /my — заявки и товары продавца со статусами; у товаров в каталоге — кнопки «Продан» и «Снять» */
async function myView(env: Env, sellerId: number): Promise<{ text: string; kb: InlineKeyboard }> {
  const kb = new InlineKeyboard();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.status, s.parsed, s.seller_price_rub, l.id AS lot, l.status AS l_status, l.reserved_until
     FROM submissions s LEFT JOIN listings l ON l.id = s.listing_id
     WHERE s.seller_id = ? AND s.status != 'cancelled' AND NOT (s.status = 'draft' AND s.parsed IS NULL)
     ORDER BY s.id DESC LIMIT 20`,
  )
    .bind(sellerId)
    .all<MyRow>();
  if (!results.length) return { text: `Пока ничего нет.\n\n${TEMPLATE_TEXT}`, kb };
  const ts = now();
  const lines = results.map((r) => {
    const p = r.parsed ? (JSON.parse(r.parsed) as ParsedPost) : null;
    const title = esc(p ? listingTitle(p) : 'Товар');
    const price = r.seller_price_rub ? ` · ${formatPrice(r.seller_price_rub)}` : '';
    let status: string;
    if (r.lot && r.l_status === 'active' && r.reserved_until && r.reserved_until > ts) {
      status = `🔒 забронирован до ${new Date(r.reserved_until * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    } else if (r.lot && r.l_status) {
      status = { active: '🟢 в каталоге', sold: '✅ продан', hidden: '⚪️ снят' }[r.l_status];
    } else {
      status = { draft: '✏️ черновик', pending: '⏳ на проверке', publishing: '⏳ публикуется', published: '🟢 опубликован', rejected: '❌ отклонён', cancelled: 'отменён' }[r.status];
    }
    if (r.lot && r.l_status === 'active') kb.text(`✅ Продан №${r.lot}`, `my_sold:${r.lot}`).text(`⛔️ Снять №${r.lot}`, `my_hide:${r.lot}`).row();
    return `${r.lot ? `<b>Лот №${r.lot}</b> · ` : ''}${title}${price} — ${status}`;
  });
  return { text: `<b>Ваши товары</b>\n\n${lines.join('\n')}`, kb };
}

