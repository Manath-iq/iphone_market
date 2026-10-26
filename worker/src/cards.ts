import type { InlineKeyboard } from 'grammy';
import type { Env } from './env';
import { now } from './env';
import { PUBLIC_ORIGIN } from './config';
import { api } from './notify';
import { CARD_VERSIONS, type CardName } from './cards-version';

/** Лимит подписи к фото в Telegram */
const CAPTION_LIMIT = 1024;

/**
 * Сообщение с картинкой-обложкой (app/public/cards/<имя>.jpg, рисует scripts/render-cards.ts).
 * В первый раз Telegram скачивает картинку по ссылке, её file_id запоминается в settings —
 * дальше шлём по нему, без повторной загрузки. Новая версия картинки — новый ключ, загрузится заново.
 * Длинный текст не влезает в подпись — тогда картинка и текст уходят двумя сообщениями.
 * Если фото не отправилось, шлём просто текст; ошибка отправки текста пробрасывается вызывающему.
 */
export async function sendWithCard(env: Env, chatId: number, card: CardName, html: string, keyboard?: InlineKeyboard) {
  const ver = CARD_VERSIONS[card];
  const key = `card:${card}:${ver}`;
  const saved = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  const fits = html.replace(/<[^>]+>/g, '').length <= CAPTION_LIMIT;
  const textOpts = { parse_mode: 'HTML' as const, reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  try {
    const msg = await api(env).sendPhoto(
      chatId,
      saved?.value ?? `${PUBLIC_ORIGIN}/cards/${card}.jpg?v=${ver}`,
      fits ? { caption: html, parse_mode: 'HTML', reply_markup: keyboard } : {},
    );
    const fileId = msg.photo?.[msg.photo.length - 1]?.file_id;
    if (!saved && fileId) {
      await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(key, fileId, now()).run();
    }
    if (fits) return;
  } catch (e) {
    console.warn('card photo failed, sending text', card, String(e));
  }
  await api(env).sendMessage(chatId, html, textOpts);
}
