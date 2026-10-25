import { Bot, InlineKeyboard, type CommandContext, type Context, type NextFunction } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import { formatPrice, listingTitle, plural } from '../../shared/parser';
import type { Env } from './env';
import { adminIds, now } from './env';
import type { ListingRow } from './db';
import { addMedia, downloadPending, setStatus, upsertPost } from './ingest';
import { notifySubscribers, sendAdminPreview, statsText } from './notify';
import { STORE } from './config';

interface Deps {
  env: Env;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

const postUrl = (chat: Message['chat'], id: number) =>
  'username' in chat && chat.username
    ? `https://t.me/${chat.username}/${id}`
    : `https://t.me/c/${String(chat.id).replace(/^-100/, '')}/${id}`;

const channelKey = (chat: Message['chat']) => ('username' in chat && chat.username ? chat.username : String(chat.id));

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
  const admins = adminIds(env);
  const isAdmin = (ctx: Context) => !!ctx.from && admins.includes(ctx.from.id);
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
    // качаем файлы в фоне, чтобы быстро ответить Telegram
    waitUntil(downloadPending(env, 10));
  }

  bot.on('channel_post', (ctx) => handleChannelMessage(ctx.channelPost, false));
  bot.on('edited_channel_post', (ctx) => handleChannelMessage(ctx.editedChannelPost, true));

  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  /** админские команды: не-админу отдаём то же, что на любое сообщение, — кнопку каталога */
  const adminOnly =
    (fn: (ctx: CommandContext<Context>) => Promise<unknown>) =>
    (ctx: CommandContext<Context>, next: NextFunction) =>
      isAdmin(ctx) ? fn(ctx) : next();
  const ADMIN_HELP = [
    '<b>Команды продавца</b>',
    '/list — что сейчас в каталоге',
    '/stats — статистика за 7 дней',
    '/sold 12 — снять как проданный',
    '/hide 12 — скрыть',
    '/show 12 — вернуть в каталог',
    '',
    'Новые посты с #АКТУАЛЬНО_RaXi попадают в каталог сами, а замена хэштега на «Продано» снимает карточку.',
  ].join('\n');

  // ——— Покупатель ———
  bot.command('start', async (ctx) => {
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
    if (isAdmin(ctx)) await ctx.reply(ADMIN_HELP, { parse_mode: 'HTML' });
  });

  // ——— Продавец ———
  bot.command(
    'help',
    adminOnly((ctx) => ctx.reply(ADMIN_HELP, { parse_mode: 'HTML' })),
  );

  bot.command(
    'list',
    adminOnly(async (ctx) => {
      const { results } = await env.DB.prepare(`SELECT * FROM listings WHERE status = 'active' ORDER BY created_at DESC`).all<ListingRow>();
      if (!results.length) return ctx.reply('Сейчас в каталоге пусто.');
      const lines = results.map((l) => {
        const days = Math.max(0, Math.floor((now() - l.created_at) / 86400));
        const age = days === 0 ? 'сегодня' : `${days} ${plural(days, 'день', 'дня', 'дней')}`;
        return `<code>${l.id}</code> · <a href="${l.post_url}">${esc(listingTitle(l))}</a> — ${l.price_rub ? formatPrice(l.price_rub) : '?'} · ${age}${l.parse_ok ? '' : ' ⚠️'}`;
      });
      const warn = results.some((l) => !l.parse_ok) ? '\n\n⚠️ — пост разобран не полностью, проверьте карточку' : '';
      await ctx.reply(`<b>В наличии: ${results.length}</b>\n\n${lines.join('\n')}${warn}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: catalogKb(),
      });
    }),
  );

  bot.command(
    'stats',
    adminOnly(async (ctx) => ctx.reply(await statsText(env), { parse_mode: 'HTML' })),
  );

  for (const [cmd, status, done] of [
    ['sold', 'sold', 'снят как проданный'],
    ['hide', 'hidden', 'скрыт из каталога'],
    ['show', 'active', 'снова в каталоге'],
  ] as const) {
    bot.command(
      cmd,
      adminOnly(async (ctx) => {
        const id = parseInt(ctx.match, 10);
        if (!id) return ctx.reply(`Укажите номер карточки: /${cmd} 12. Номера — в /list`);
        const l = await setStatus(env, id, status);
        await ctx.reply(l ? `${listingTitle(l)} — ${done}.` : 'Карточка с таким номером не найдена.');
      }),
    );
  }

  bot.callbackQuery(/^(ok|hide|show):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
    const [, action, idStr] = ctx.match;
    const id = +idStr;
    const open = () => new InlineKeyboard().webApp('Открыть в каталоге', `${origin}/?l=${id}`);
    let kb: InlineKeyboard;
    if (action === 'ok') {
      await env.DB.prepare('UPDATE listings SET confirmed = 1, parse_ok = 1 WHERE id = ?').bind(id).run();
      await ctx.answerCallbackQuery('Отлично, карточка в каталоге');
      kb = open().row().text('🙈 Скрыть', `hide:${id}`);
    } else if (action === 'hide') {
      await setStatus(env, id, 'hidden');
      await ctx.answerCallbackQuery('Скрыто из каталога');
      kb = new InlineKeyboard().text('↩️ Вернуть в каталог', `show:${id}`);
    } else {
      await setStatus(env, id, 'active');
      await ctx.answerCallbackQuery('Снова в каталоге');
      kb = open().row().text('🙈 Скрыть', `hide:${id}`);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  // Всё остальное — кнопка каталога
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    if (isAdmin(ctx) && ctx.message.text?.startsWith('/')) return ctx.reply(ADMIN_HELP, { parse_mode: 'HTML' });
    await ctx.reply('Все телефоны в наличии — в каталоге 👇', { reply_markup: catalogKb() });
  });

  bot.catch((err) => console.error('bot error', err.error));
  return bot;
}
