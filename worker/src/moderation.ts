import { InlineKeyboard } from 'grammy';
import { CAPTION_LIMIT, stripContacts } from '../../shared/caption';
import { formatPrice, listingTitle } from '../../shared/parser';
import type { Env } from './env';
import { api, esc } from './notify';
import { getSeller, personLink, staffIds } from './roles';
import { getSettings } from './settings';
import { getSubmission, getSubmissionMedia, parsedOf, type SubmissionRow } from './submissions';

export const modKeyboard = (id: number) =>
  new InlineKeyboard()
    .text('✅ Опубликовать', `mod_pub:${id}`)
    .row()
    .text('💰 Изменить цену', `mod_price:${id}`)
    .text('❌ Отклонить', `mod_rej:${id}`)
    .row()
    .text('🖼 Все фото', `mod_media:${id}`);

/**
 * Карточка заявки для сотрудников: разобранные поля, цены и продавец (его видят только сотрудники).
 * footer — строка о решении («Опубликовал @…»). Текст режется под лимит подписи к фото.
 */
export async function modCardText(env: Env, sub: SubmissionRow, footer?: string): Promise<string> {
  const p = parsedOf(sub);
  const seller = await getSeller(env, sub.seller_id);
  const { fee_rub } = await getSettings(env);
  const sellerPrice = sub.seller_price_rub ?? 0;
  const head = [
    `🆕 <b>Заявка №${sub.id}</b>`,
    '',
    `<b>${esc(p ? listingTitle(p) : 'Телефон')}</b>`,
    [p?.condition, p?.battery_pct && `АКБ ${p.battery_pct}%`, p?.sim].filter(Boolean).map((s) => esc(String(s))).join(' · '),
  ];
  const tail = [
    '',
    `Цена продавца: ${formatPrice(sellerPrice)}`,
    `Комиссия: ${formatPrice(fee_rub)}`,
    `Для покупателя: <b>${formatPrice(sellerPrice + fee_rub)}</b>`,
    '',
    `Продавец: ${personLink({ id: sub.seller_id, username: seller?.username, first_name: seller?.first_name })} · <code>${sub.seller_id}</code>`,
    ...(footer ? ['', footer] : []),
  ];
  // плюсы и нюансы — уже без контактов, как в посте; лишнее отрезаем с конца
  const items = [
    ...(p?.pluses ?? []).map((x) => `✅ ${esc(stripContacts(x))}`),
    ...(p?.nuances ?? []).map((x) => `✖️ ${esc(stripContacts(x))}`),
  ];
  const plainLen = (lines: string[]) => lines.join('\n').replace(/<[^>]+>/g, '').length;
  while (items.length && plainLen([...head, ...items, ...tail]) > CAPTION_LIMIT) items.pop();
  return [...head, ...items, ...tail].filter((s, i, a) => s !== '' || a[i - 1] !== '').join('\n');
}

/** Разослать карточку заявки всем сотрудникам: первое фото + поля + кнопки решения */
export async function sendToModeration(env: Env, subId: number) {
  const sub = await getSubmission(env, subId);
  if (!sub || sub.status !== 'pending') return;
  const [first] = await getSubmissionMedia(env, subId);
  const caption = await modCardText(env, sub);
  const kb = modKeyboard(subId);
  for (const chatId of await staffIds(env)) {
    try {
      const opts = { caption, parse_mode: 'HTML' as const, reply_markup: kb };
      const msg = first?.kind === 'video' ? await api(env).sendVideo(chatId, first.file_id, opts) : await api(env).sendPhoto(chatId, first!.file_id, opts);
      await env.DB.prepare('INSERT OR REPLACE INTO mod_messages (submission_id, chat_id, message_id) VALUES (?, ?, ?)')
        .bind(subId, chatId, msg.message_id)
        .run();
    } catch (e) {
      console.warn('moderation send failed', chatId, String(e));
    }
  }
}

/** Обновить карточку заявки у всех сотрудников: новый текст и кнопки (без кнопок — решение принято) */
export async function refreshModCards(env: Env, subId: number, footer?: string, keyboard?: InlineKeyboard) {
  const sub = await getSubmission(env, subId);
  if (!sub) return;
  const caption = await modCardText(env, sub, footer);
  const { results } = await env.DB.prepare('SELECT chat_id, message_id FROM mod_messages WHERE submission_id = ?')
    .bind(subId)
    .all<{ chat_id: number; message_id: number }>();
  await Promise.all(
    results.map((m) =>
      api(env)
        .editMessageCaption(m.chat_id, m.message_id, { caption, parse_mode: 'HTML', reply_markup: keyboard ?? { inline_keyboard: [] } })
        .catch((e) => console.warn('mod card edit failed', m.chat_id, String(e))),
    ),
  );
}
