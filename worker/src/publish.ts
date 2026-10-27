import type { Message } from 'grammy/types';
import { buildCaption, stripContactsMultiline, type CaptionFields } from '../../shared/caption';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { addMedia, setStatus } from './ingest';
import { api, sendAlbum } from './notify';
import { getSettings } from './settings';
import { getSubmissionMedia, moveStatus, parsedOf, type SubmissionRow } from './submissions';

export const postUrl = (chat: Message['chat'], id: number) =>
  'username' in chat && chat.username
    ? `https://t.me/${chat.username}/${id}`
    : `https://t.me/c/${String(chat.id).replace(/^-100/, '')}/${id}`;

/** Ключ канала в базе: @имя публичного канала или числовой id приватного */
export const channelKey = (chat: Message['chat']) => ('username' in chat && chat.username ? chat.username : String(chat.id));

/** chat_id для Bot API по ключу канала из базы */
const chatRef = (key: string) => (/^-?\d+$/.test(key) ? key : `@${key}`);

/**
 * Ссылка «Купить лот» под постом. APP_LINK — шаблон с {id}: например, t.me/<бот>?startapp=l_{id} открывает
 * карточку в мини-аппе сразу, если в BotFather настроено Main Mini App. По умолчанию — t.me/<бот>?start=l_{id}:
 * бот присылает кнопку «Открыть карточку».
 */
export const appLink = (env: Env, id: number) =>
  (env.APP_LINK || `https://t.me/${env.BOT_USERNAME}?start=l_{id}`).replace('{id}', String(id));

/** Поля подписи из карточки — чтобы пересобрать пост при «Продан» и «Снять» */
export function captionFields(l: ListingRow): CaptionFields {
  return {
    family: l.family,
    model_raw: l.model_raw,
    storage_gb: l.storage_gb,
    condition: l.condition,
    sim: l.sim,
    battery_pct: l.battery_pct,
    battery_cycles: l.battery_cycles,
    ios: l.ios,
    pluses: JSON.parse(l.pluses),
    nuances: JSON.parse(l.nuances),
    category: l.category === 'other' ? 'other' : 'iphone',
    description: l.description,
  };
}

/**
 * Публикация одобренной заявки в канал от имени канала.
 * Telegram не присылает боту его собственные посты, поэтому карточку создаём сами по ответу sendMediaGroup.
 * Номер лота = id карточки, а он нужен уже в подписи: сначала создаём скрытую карточку, потом публикуем.
 * Заявка к этому моменту «захвачена» модератором (статус publishing). При ошибке Telegram всё откатываем.
 */
export async function publishSubmission(env: Env, sub: SubmissionRow, moderatorId: number): Promise<ListingRow> {
  const p = parsedOf(sub);
  if (!p || !sub.seller_price_rub) throw new Error('submission is not parsed');
  const { fee_rub, publish_chat_id } = await getSettings(env);
  const price = sub.seller_price_rub + fee_rub;
  const ts = now();
  const draft = await env.DB.prepare(
    `INSERT INTO listings (source_channel, channel_msg_id, media_group_id, category, model_raw, family, storage_gb,
       condition, sim, has_physical_sim, battery_pct, battery_cycles, ios, pluses, nuances, kit, full_kit, price_rub,
       status, parse_ok, confirmed, raw_text, post_url, created_at, updated_at, seller_id, seller_price_rub, fee_rub, fee_in_post, description)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hidden', 1, 1, ?, '', ?, ?, ?, ?, ?, 0, ?)
     RETURNING *`,
  )
    .bind(
      `pending:${publish_chat_id}`, -sub.id, sub.category, p.model_raw, p.family, p.storage_gb, p.condition, p.sim,
      p.has_physical_sim === null ? null : +p.has_physical_sim, p.battery_pct, p.battery_cycles, p.ios,
      JSON.stringify(p.pluses), JSON.stringify(p.nuances), p.kit, +p.full_kit, price,
      sub.raw_text ?? sub.description ?? '', ts, ts, sub.seller_id, sub.seller_price_rub, fee_rub,
      // в карточку — описание уже без контактов: API отдаёт его покупателю
      sub.category === 'other' ? stripContactsMultiline(sub.description ?? '') : null,
    )
    .first<ListingRow>();
  if (!draft) throw new Error('listing insert failed');

  let msgs: Message[];
  try {
    const caption = buildCaption(captionFields(draft), { price, lot: draft.id, buyUrl: appLink(env, draft.id) });
    msgs = await sendAlbum(env, publish_chat_id, await getSubmissionMedia(env, sub.id), caption);
  } catch (e) {
    await env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(draft.id).run();
    throw e;
  }

  const first = msgs[0];
  const channel = channelKey(first.chat);
  const listing = await env.DB.prepare(
    `UPDATE listings SET source_channel = ?, channel_msg_id = ?, media_group_id = ?, post_url = ?, status = 'active', updated_at = ?
     WHERE id = ? RETURNING *`,
  )
    .bind(channel, first.message_id, first.media_group_id ?? null, postUrl(first.chat, first.message_id), now(), draft.id)
    .first<ListingRow>();
  // медиа карточки — file_id из ответа Telegram, мини-апп показывает их через /media/f/<id>
  for (const m of msgs) {
    const photo = m.photo?.[m.photo.length - 1];
    const file = photo ?? m.video;
    if (!file) continue;
    await addMedia(env, {
      channel, msg_id: m.message_id, media_group_id: m.media_group_id ?? null, kind: photo ? 'photo' : 'video',
      source: `tg:${file.file_id}`, file_size: file.file_size, width: file.width, height: file.height,
    });
  }
  await env.DB.prepare(`UPDATE submissions SET status = 'published', listing_id = ?, decided_by = ?, updated_at = ? WHERE id = ?`)
    .bind(draft.id, moderatorId, now(), sub.id)
    .run();
  return listing!;
}

/** Вернуть заявку на проверку, если публикация не удалась */
export const revertPublishing = (env: Env, subId: number) => moveStatus(env, subId, ['publishing'], 'pending');

/**
 * Сменить статус карточки. У товаров продавцов бот сам ведёт пост в канале — правим его подпись:
 * «❌ Продано ❌» или «Снято с продажи» без ссылки «Купить», а при возврате в каталог — снова с хэштегом.
 * Посты владельца бот не правит: их ведёт сам владелец.
 */
export async function applyStatus(env: Env, id: number, status: 'active' | 'sold' | 'hidden'): Promise<ListingRow | null> {
  const l = await setStatus(env, id, status);
  if (!l?.seller_id || l.channel_msg_id < 0) return l;
  const closed = status === 'sold' ? 'sold' : status === 'hidden' ? 'withdrawn' : null;
  const caption = buildCaption(captionFields(l), { price: l.price_rub ?? 0, lot: l.id, buyUrl: appLink(env, l.id), closed });
  await api(env)
    .editMessageCaption(chatRef(l.source_channel), l.channel_msg_id, { caption, parse_mode: 'HTML' })
    .catch((e) => console.warn('caption edit failed', l.id, String(e)));
  return l;
}
