import { Bot, InlineKeyboard } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import { formatPrice, listingTitle, plural } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { addMedia, upsertPost } from './ingest';
import { esc, notifySubscribers, sendAdminPreview, toStaff } from './notify';
import { STORE } from './config';
import { acceptInvite, isStaff, personLink, touchSeller, type InviteResult } from './roles';
import { registerStaff } from './bot-staff';
import { channelKey, postUrl } from './publish';
import { registerSeller, TEMPLATE_TEXT } from './bot-seller';

interface Deps {
  env: Env;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

export function createBot({ env, origin, waitUntil }: Deps) {
  const botInfo = {
    id: +env.BOT_TOKEN.split(':')[0],
    is_bot: true,
    first_name: STORE.name,
    username: env.BOT_USERNAME,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  } as UserFromGetMe;
  const bot = new Bot(env.BOT_TOKEN, { botInfo });
  // На вебхуке bot.catch не срабатывает: ошибка превращается в 500, и Telegram повторяет апдейт снова и снова
  // (дубли карточек, заявок, уведомлений). Поэтому все обработчики — за errorBoundary, ответ всегда 200.
  const h = bot.errorBoundary((err) => console.error('bot error', err.error));
  const catalogKb = () => new InlineKeyboard().webApp('📱 Открыть каталог', origin);

  // ——— Канал: новые посты и правки ———
  async function handleChannelMessage(msg: Message, edited: boolean) {
    const channel = channelKey(msg.chat);
    const text = msg.caption ?? msg.text ?? '';
    const group = msg.media_group_id ?? null;

    if (msg.photo?.length) {
      const big = msg.photo[msg.photo.length - 1];
      await addMedia(env, {
        channel, msg_id: msg.message_id, media_group_id: group, kind: 'photo',
        source: `tg:${big.file_id}`, file_size: big.file_size, width: big.width, height: big.height,
      });
    }
    if (msg.video) {
      await addMedia(env, {
        channel, msg_id: msg.message_id, media_group_id: group, kind: 'video',
        source: `tg:${msg.video.file_id}`, file_size: msg.video.file_size, width: msg.video.width, height: msg.video.height,
      });
    }

    if (text) {
      const res = await upsertPost(env, {
        channel, msg_id: msg.message_id, text, media_group_id: group,
        date: edited ? msg.date : msg.date || now(), post_url: postUrl(msg.chat, msg.message_id),
      });
      if (res?.created && res.listing.status === 'active') {
        waitUntil(sendAdminPreview(env, origin, res.listing));
        waitUntil(notifySubscribers(env, origin, res.listing));
      }
    }
  }

  h.on('channel_post', (ctx) => handleChannelMessage(ctx.channelPost, false));
  h.on('edited_channel_post', (ctx) => handleChannelMessage(ctx.editedChannelPost, true));

  // ——— Покупатель ———
  h.command('start', async (ctx) => {
    // приглашение: t.me/<бот>?start=s_<код> — продавец, m_<код> — модератор
    const invite = ctx.match.match(/^([sm])_([\w-]{6,})$/);
    if (invite && ctx.from) {
      const role = invite[1] === 's' ? 'seller' : 'mod';
      const res = await acceptInvite(env, invite[2], role, ctx.from);
      await ctx.reply(inviteReply(res, role), { parse_mode: 'HTML' });
      if (res.ok && role === 'seller') await ctx.reply(TEMPLATE_TEXT, { parse_mode: 'HTML' });
      if (res.ok) {
        const who = personLink(ctx.from);
        waitUntil(toStaff(env, `👤 ${who} ${role === 'seller' ? 'стал продавцом' : 'стал модератором'} по приглашению.`));
      }
      return;
    }
    // ссылка «Поделиться» из карточки: t.me/<бот>?start=l_12
    const shared = ctx.match.match(/^l_(\d+)$/);
    if (shared) {
      const l = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(+shared[1]).first<ListingRow>();
      if (l?.status === 'active') {
        return ctx.reply(`📱 <b>${esc(listingTitle(l))}</b>${l.price_rub ? ' — ' + formatPrice(l.price_rub) : ''}`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp('Открыть карточку', `${origin}/?l=${l.id}`).row().webApp('Весь каталог', origin),
        });
      }
      if (l) {
        await ctx.reply(`${esc(listingTitle(l))} уже продан 🤷 Посмотрите, что есть сейчас:`, { reply_markup: catalogKb() });
        return;
      }
    }
    const count = await env.DB.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'active'`).first<{ c: number }>();
    const n = count?.c ?? 0;
    await ctx.reply(
      [
        `Здравствуйте! Это каталог <b>${STORE.name}</b> 🍏`,
        '',
        n ? `Сейчас в наличии <b>${n}</b> ${plural(n, 'телефон', 'телефона', 'телефонов')} — только то, что можно купить прямо сейчас.` : 'Сейчас всё раскупили, но новые телефоны появляются почти каждый день.',
        '',
        '• фото, видео и честное описание каждого',
        '• фильтры по модели, памяти, цене и АКБ',
        '• «Купить» — и вы сразу в чате с продавцом',
        '• подписка: напишу, когда появится нужная модель',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().webApp('📱 Открыть каталог', origin).row().webApp('🔔 Сообщить о поступлении', `${origin}/?tab=subs`),
      },
    );
    if (ctx.from && (await isStaff(env, ctx.from.id))) await ctx.reply('Команды сотрудника — /help');
  });

  // ——— Сотрудники и владелец ———
  registerStaff(h, { env, origin, waitUntil });

  // ——— Продавцы: подача товаров ———
  registerSeller(h, { env, waitUntil });

  // Всё остальное — кнопка каталога
  h.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    // ник продавца мог смениться — а выдаём покупателю именно его
    waitUntil(touchSeller(env, ctx.from));
    if (ctx.message.text?.startsWith('/') && (await isStaff(env, ctx.from.id))) return ctx.reply('Такой команды нет. Список — /help');
    await ctx.reply('Все телефоны в наличии — в каталоге 👇', { reply_markup: catalogKb() });
  });

  return bot;
}

function inviteReply(res: InviteResult, role: 'seller' | 'mod'): string {
  if (res.ok) {
    return role === 'seller'
      ? `Готово, вы продавец <b>${STORE.name}</b> ✅`
      : `Готово, вы модератор <b>${STORE.name}</b> ✅\n\nСюда будут приходить новые товары и превью постов канала. Команды — /help`;
  }
  switch (res.reason) {
    case 'no_username':
      return 'Чтобы покупатели могли вам написать, задайте имя пользователя: Настройки → Имя пользователя. Потом откройте ссылку ещё раз — она по-прежнему действует.';
    case 'already':
      return role === 'seller' ? 'Вы уже продавец — повторно ничего делать не нужно.' : 'Вы уже модератор.';
    case 'used':
      return 'Эта ссылка уже использована. Попросите новую у владельца.';
    case 'expired':
      return 'Срок ссылки истёк — она действует 24 часа. Попросите новую у владельца.';
    default:
      return 'Ссылка недействительна. Попросите новую у владельца.';
  }
}
