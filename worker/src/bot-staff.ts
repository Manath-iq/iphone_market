import { InlineKeyboard, type CommandContext, type Composer, type Context, type NextFunction } from 'grammy';
import { formatPrice, listingTitle, plural } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { api, esc, notifySubscribers, sendAlbum, statsText } from './notify';
import { createInvite, isOwner, isStaff, listMods, listSellers, personLink, setModActive, setSellerStatus } from './roles';
import { syncCommands } from './commands';
import { getSettings, setSetting } from './settings';
import { clearState, getState, setState } from './state';
import { getSubmission, getSubmissionMedia, moveStatus, parsedOf, type SubmissionRow } from './submissions';
import { modKeyboard, refreshModCards } from './moderation';
import { applyStatus, publishSubmission, revertPublishing } from './publish';
import { formatMsk, isReserved, unreserve } from './payments';

interface Deps {
  env: Env;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
}

/** Команды и кнопки владельца и модераторов. Регистрируются на errorBoundary-композере из bot.ts. */
export function registerStaff(h: Composer<Context>, { env, origin, waitUntil }: Deps) {
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
        const lock = isReserved(l) ? ` · 🔒 до ${formatMsk(l.reserved_until!)}` : '';
        return `<code>${l.id}</code> · <a href="${l.post_url}">${esc(listingTitle(l))}</a> — ${l.price_rub ? formatPrice(l.price_rub) : '?'} · ${age}${lock}${l.parse_ok ? '' : ' ⚠️'}`;
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
        const l = await applyStatus(env, id, status);
        await ctx.reply(l ? `${listingTitle(l)} — ${done}.` : 'Карточка с таким номером не найдена.');
      }),
    );
  }

  h.command(
    'unreserve',
    staffOnly(async (ctx) => {
      const id = parseInt(ctx.match, 10);
      if (!id) return ctx.reply('Укажите номер лота: /unreserve 12');
      const l = await unreserve(env, id);
      await ctx.reply(l ? `Бронь снята: лот №${l.id} снова можно купить.` : 'Лот с таким номером не найден.');
    }),
  );

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
      await applyStatus(env, id, 'hidden');
      await ctx.answerCallbackQuery('Скрыто из каталога');
      kb = new InlineKeyboard().text('↩️ Вернуть в каталог', `show:${id}`);
    } else {
      await applyStatus(env, id, 'active');
      await ctx.answerCallbackQuery('Снова в каталоге');
      kb = open().row().text('🙈 Скрыть', `hide:${id}`);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  // ——— Модерация заявок продавцов: кто первым нажал, тот и решил ———
  h.callbackQuery(/^mod_(pub|price|rej|media):(\d+)$/, async (ctx) => {
    if (!(await isStaff(env, ctx.from.id))) return ctx.answerCallbackQuery();
    const [, action, idStr] = ctx.match;
    const id = +idStr;
    if (action === 'media') {
      await ctx.answerCallbackQuery();
      await sendAlbum(env, ctx.from.id, await getSubmissionMedia(env, id), `Заявка №${id}`);
      return;
    }
    if (action === 'pub') {
      // атомарный захват: из двух модераторов, нажавших одновременно, опубликует один
      const sub = await moveStatus(env, id, ['pending'], 'publishing');
      if (!sub) return ctx.answerCallbackQuery('Эту заявку уже решили');
      await ctx.answerCallbackQuery('Публикую в канал…');
      const mod = ctx.from;
      waitUntil(publishAndReport(sub, mod).catch((e) => console.error('publish report failed', id, e)));
      return;
    }
    const sub = await getSubmission(env, id);
    if (sub?.status !== 'pending') return ctx.answerCallbackQuery('Эту заявку уже решили');
    await setState(env, ctx.from.id, action === 'rej' ? 'await_reason' : 'await_price', id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      action === 'rej'
        ? `Напишите причину отказа по заявке №${id} одним сообщением — бот перешлёт её продавцу.`
        : `Введите новую цену продавца по заявке №${id} числом, например 75000. Комиссию площадки бот добавит сам.`,
    );
  });

  async function publishAndReport(sub: SubmissionRow, mod: { id: number; username?: string; first_name?: string }) {
    const p = parsedOf(sub);
    const title = esc(p ? listingTitle(p) : 'Телефон');
    try {
      const l = await publishSubmission(env, sub, mod.id);
      await refreshModCards(env, sub.id, `✅ Опубликовал ${personLink(mod)} · <a href="${l.post_url}">лот №${l.id}</a>`);
      await api(env).sendMessage(
        sub.seller_id,
        `✅ Ваш ${title} опубликован — <b>лот №${l.id}</b>.\nЦена для покупателя: ${formatPrice(l.price_rub ?? 0)}.\n\nКогда продадите, отметьте это в /my.`,
        { parse_mode: 'HTML' },
      );
      await notifySubscribers(env, origin, l);
    } catch (e) {
      console.error('publish failed', sub.id, e);
      await revertPublishing(env, sub.id);
      const why = e instanceof Error ? e.message : String(e);
      await api(env).sendMessage(
        mod.id,
        `Не удалось опубликовать заявку №${sub.id}: ${esc(why)}\n\nПроверьте, что бот — админ канала с правом публикации (/channel), и нажмите «Опубликовать» ещё раз.`,
      );
    }
  }

  // Ответ сотрудника на «Отклонить» (причина) или «Изменить цену» (число)
  h.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return next();
    const st = await getState(env, ctx.from.id);
    if (!st || (st.kind !== 'await_reason' && st.kind !== 'await_price')) return next();
    if (!(await isStaff(env, ctx.from.id))) return next();
    const id = st.ref_id;
    const who = personLink(ctx.from);
    const text = ctx.message.text.trim();

    if (st.kind === 'await_price') {
      const price = parseInt(text.replace(/\D/g, ''), 10);
      if (!price || price < 1000 || price > 1_000_000) return ctx.reply('Не понял цену. Пришлите число в рублях, например 75000.');
      await clearState(env, ctx.from.id);
      const sub = await getSubmission(env, id);
      const p = sub && parsedOf(sub);
      if (!sub || !p || sub.status !== 'pending') return ctx.reply('Эту заявку уже решили.');
      await env.DB.prepare('UPDATE submissions SET seller_price_rub = ?, parsed = ? WHERE id = ?')
        .bind(price, JSON.stringify({ ...p, price_rub: price }), id)
        .run();
      const { fee_rub } = await getSettings(env);
      await refreshModCards(env, id, `💰 ${who} изменил цену продавца`, modKeyboard(id));
      await ctx.reply(`Готово: цена продавца ${formatPrice(price)}, для покупателя ${formatPrice(price + fee_rub)}.`);
      await api(env)
        .sendMessage(
          sub.seller_id,
          `Модератор изменил цену по вашей заявке на ${esc(listingTitle(p))}: ваша цена ${formatPrice(price)}, для покупателя ${formatPrice(price + fee_rub)}.`,
        )
        .catch((e) => console.warn('seller notify failed', String(e)));
      return;
    }

    const reason = text.slice(0, 500);
    await clearState(env, ctx.from.id);
    const sub = await moveStatus(env, id, ['pending'], 'rejected');
    if (!sub) return ctx.reply('Эту заявку уже решили.');
    await env.DB.prepare('UPDATE submissions SET reject_reason = ?, decided_by = ? WHERE id = ?').bind(reason, ctx.from.id, id).run();
    await refreshModCards(env, id, `❌ Отклонил ${who}: ${esc(reason)}`);
    const p = parsedOf(sub);
    await api(env)
      .sendMessage(
        sub.seller_id,
        `❌ Заявка на ${esc(p ? listingTitle(p) : 'телефон')} отклонена.\n\nПричина: ${esc(reason)}\n\nМожно исправить и прислать альбом заново.`,
        { parse_mode: 'HTML' },
      )
      .catch((e) => console.warn('seller notify failed', String(e)));
    await ctx.reply('Отклонено, продавец получил причину.');
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
    waitUntil(syncCommands(env, +ctx.match[2]));
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
    waitUntil(syncCommands(env, +ctx.match[2]));
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
    '/unreserve 12 — снять бронь',
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
