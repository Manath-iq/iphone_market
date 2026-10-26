import { InlineKeyboard, type CommandContext, type Composer, type Context, type NextFunction } from 'grammy';
import { formatPrice, listingTitle, plural } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { setStatus } from './ingest';
import { esc, statsText } from './notify';
import { createInvite, isOwner, isStaff, listMods, listSellers, personLink, setModActive, setSellerStatus } from './roles';
import { getSettings, setSetting } from './settings';

interface Deps {
  env: Env;
  origin: string;
}

/** Команды и кнопки владельца и модераторов. Регистрируются на errorBoundary-композере из bot.ts. */
export function registerStaff(h: Composer<Context>, { env, origin }: Deps) {
  const botId = +env.BOT_TOKEN.split(':')[0];
  const catalogKb = () => new InlineKeyboard().webApp('📱 Открыть каталог', origin);

  /** чужим отдаём то же, что на любое сообщение, — кнопку каталога */
  const staffOnly =
    (fn: (ctx: CommandContext<Context>) => Promise<unknown>) =>
    async (ctx: CommandContext<Context>, next: NextFunction) =>
      ctx.from && (await isStaff(env, ctx.from.id)) ? fn(ctx) : next();
  const ownerOnly =
    (fn: (ctx: CommandContext<Context>) => Promise<unknown>) =>
    (ctx: CommandContext<Context>, next: NextFunction) =>
      ctx.from && isOwner(env, ctx.from.id) ? fn(ctx) : next();

  h.command(
    'help',
    staffOnly(async (ctx) => ctx.reply(await helpText(env, isOwner(env, ctx.from!.id)), { parse_mode: 'HTML' })),
  );

  h.command(
    'list',
    staffOnly(async (ctx) => {
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

  h.command(
    'stats',
    staffOnly(async (ctx) => ctx.reply(await statsText(env), { parse_mode: 'HTML' })),
  );

  for (const [cmd, status, done] of [
    ['sold', 'sold', 'снят как проданный'],
    ['hide', 'hidden', 'скрыт из каталога'],
    ['show', 'active', 'снова в каталоге'],
  ] as const) {
    h.command(
      cmd,
      staffOnly(async (ctx) => {
        const id = parseInt(ctx.match, 10);
        if (!id) return ctx.reply(`Укажите номер карточки: /${cmd} 12. Номера — в /list`);
        const l = await setStatus(env, id, status);
        await ctx.reply(l ? `${listingTitle(l)} — ${done}.` : 'Карточка с таким номером не найдена.');
      }),
    );
  }

  // Превью новой карточки из канала: «Всё верно / Скрыть / Вернуть»
  h.callbackQuery(/^(ok|hide|show):(\d+)$/, async (ctx) => {
    if (!(await isStaff(env, ctx.from.id))) return ctx.answerCallbackQuery();
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

  // ——— Только владелец ———
  for (const [cmd, role, prefix, who] of [
    ['invite', 'seller', 's', 'продавца'],
    ['invite_mod', 'mod', 'm', 'модератора'],
  ] as const) {
    h.command(
      cmd,
      ownerOnly(async (ctx) => {
        const code = await createInvite(env, role, ctx.from!.id);
        const link = `https://t.me/${env.BOT_USERNAME}?start=${prefix}_${code}`;
        await ctx.reply(
          [
            `Ссылка-приглашение для ${who}:`,
            '',
            `<code>${link}</code>`,
            '',
            'Одноразовая, действует 24 часа. Перешлите её одному человеку.',
          ].join('\n'),
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
      }),
    );
  }

  h.command(
    'sellers',
    ownerOnly(async (ctx) => {
      const { text, kb } = await sellersView(env);
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }),
  );
  h.callbackQuery(/^s(on|off):(\d+)$/, async (ctx) => {
    if (!isOwner(env, ctx.from.id)) return ctx.answerCallbackQuery();
    const s = await setSellerStatus(env, +ctx.match[2], ctx.match[1] === 'on' ? 'active' : 'blocked');
    await ctx.answerCallbackQuery(s ? (s.status === 'active' ? 'Продавец включён' : 'Продавец отключён') : 'Не найден');
    const { text, kb } = await sellersView(env);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  });

  h.command(
    'mods',
    ownerOnly(async (ctx) => {
      const { text, kb } = await modsView(env);
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }),
  );
  h.callbackQuery(/^m(on|off):(\d+)$/, async (ctx) => {
    if (!isOwner(env, ctx.from.id)) return ctx.answerCallbackQuery();
    const m = await setModActive(env, +ctx.match[2], ctx.match[1] === 'on');
    await ctx.answerCallbackQuery(m ? (m.active ? 'Модератор включён' : 'Модератор отключён') : 'Не найден');
    const { text, kb } = await modsView(env);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  });

  h.command(
    'fee',
    ownerOnly(async (ctx) => {
      const s = await getSettings(env);
      const fee = parseInt(ctx.match.replace(/\s/g, ''), 10);
      if (!ctx.match.trim()) return ctx.reply(`Комиссия площадки сейчас ${formatPrice(s.fee_rub)}. Изменить: /fee 1500`);
      if (!Number.isFinite(fee) || fee < 0 || fee > 100000) return ctx.reply('Укажите сумму в рублях: /fee 1500');
      await setSetting(env, 'fee_rub', fee);
      await ctx.reply(`Готово: комиссия ${formatPrice(fee)}. Действует для новых товаров, у опубликованных остаётся прежняя.`);
    }),
  );

  h.command(
    'fee_mode',
    ownerOnly(async (ctx) => {
      const arg = ctx.match.trim();
      if (arg !== 'plus' && arg !== 'incl') {
        const s = await getSettings(env);
        return ctx.reply(
          [
            `Ваши посты в канале: ${feeModeText(s.owner_fee_mode)}.`,
            '',
            '/fee_mode plus — комиссия добавляется к цене поста',
            '/fee_mode incl — комиссия уже включена в цену поста',
          ].join('\n'),
        );
      }
      await setSetting(env, 'owner_fee_mode', arg);
      await ctx.reply(`Готово: ${feeModeText(arg)}. Действует для новых постов.`);
    }),
  );

  h.command(
    'channel',
    ownerOnly(async (ctx) => {
      const arg = ctx.match.trim();
      if (!arg) {
        const s = await getSettings(env);
        return ctx.reply(
          `Товары продавцов публикуются в «${esc(s.publish_chat_title)}» (<code>${esc(s.publish_chat_id)}</code>).\n\nСменить: /channel @имя_канала или /channel -100…\nБот должен быть админом канала с правом публикации.`,
          { parse_mode: 'HTML' },
        );
      }
      const chatRef = /^-?\d+$/.test(arg) ? +arg : arg.startsWith('@') ? arg : `@${arg}`;
      const chat = await ctx.api.getChat(chatRef).catch(() => null);
      if (!chat || chat.type !== 'channel') return ctx.reply('Не нашёл такой канал. Сначала добавьте бота в канал админом.');
      const me = await ctx.api.getChatMember(chat.id, botId).catch(() => null);
      if (me?.status !== 'administrator' || !me.can_post_messages) {
        return ctx.reply('Бот не может публиковать в этом канале. Дайте ему права админа с публикацией сообщений.');
      }
      await setSetting(env, 'publish_chat_id', String(chat.id));
      await setSetting(env, 'publish_chat_title', chat.title);
      await ctx.reply(`Готово: товары продавцов будут публиковаться в «${chat.title}».`);
    }),
  );
}

const feeModeText = (m: 'plus' | 'incl') => (m === 'plus' ? 'комиссия добавляется к цене поста' : 'комиссия уже включена в цену поста');

async function helpText(env: Env, owner: boolean): Promise<string> {
  const lines = [
    '<b>Команды сотрудника</b>',
    '/list — что сейчас в каталоге',
    '/stats — статистика за 7 дней',
    '/sold 12 — снять как проданный',
    '/hide 12 — скрыть',
    '/show 12 — вернуть в каталог',
    '',
    'Новые посты с #АКТУАЛЬНО_RaXi попадают в каталог сами, а замена хэштега на «Продано» снимает карточку.',
  ];
  if (owner) {
    const s = await getSettings(env);
    lines.push(
      '',
      '<b>Владельцу</b>',
      '/invite — ссылка для нового продавца',
      '/invite_mod — ссылка для модератора',
      '/sellers — продавцы, отключить или включить',
      '/mods — модераторы',
      `/fee — комиссия площадки, сейчас ${formatPrice(s.fee_rub)}`,
      `/fee_mode — ваши посты: ${feeModeText(s.owner_fee_mode)}`,
      `/channel — куда публиковать товары, сейчас «${esc(s.publish_chat_title)}»`,
    );
  }
  return lines.join('\n');
}

async function sellersView(env: Env) {
  const list = await listSellers(env);
  const kb = new InlineKeyboard();
  if (!list.length) return { text: 'Продавцов пока нет. Пригласить: /invite', kb };
  const lines = list.map((s) => {
    const who = personLink({ id: s.tg_user_id, username: s.username, first_name: s.first_name });
    const name = s.username ? `@${s.username}` : (s.first_name ?? String(s.tg_user_id));
    if (s.status === 'active') kb.text(`🚫 Отключить ${name}`, `soff:${s.tg_user_id}`).row();
    else kb.text(`✅ Включить ${name}`, `son:${s.tg_user_id}`).row();
    return `${s.status === 'active' ? '🟢' : '⚪️'} ${who}`;
  });
  const active = list.filter((s) => s.status === 'active').length;
  return { text: `<b>Продавцы</b> — активных ${active} из ${list.length}\n\n${lines.join('\n')}`, kb };
}

async function modsView(env: Env) {
  const list = await listMods(env);
  const kb = new InlineKeyboard();
  if (!list.length) return { text: 'Модераторов пока нет. Пригласить: /invite_mod', kb };
  const lines = list.map((m) => {
    const who = personLink({ id: m.tg_user_id, username: m.username, first_name: m.first_name });
    const name = m.username ? `@${m.username}` : (m.first_name ?? String(m.tg_user_id));
    if (m.active) kb.text(`🚫 Отключить ${name}`, `moff:${m.tg_user_id}`).row();
    else kb.text(`✅ Включить ${name}`, `mon:${m.tg_user_id}`).row();
    return `${m.active ? '🟢' : '⚪️'} ${who}`;
  });
  return { text: `<b>Модераторы</b>\n\n${lines.join('\n')}`, kb };
}
