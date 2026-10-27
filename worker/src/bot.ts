import { Bot, InlineKeyboard } from 'grammy';
import type { Message, UserFromGetMe } from 'grammy/types';
import { formatPrice, listingTitle, plural } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { addMedia, upsertPost } from './ingest';
import { esc, notifySubscribers, sendAdminPreview, toStaff } from './notify';
import { STORE } from './config';
import { acceptInvite, isStaff, personLink, touchSeller, type InviteResult, type InviteRole } from './roles';
import { syncCommands } from './commands';
import { registerStaff } from './bot-staff';
import { channelKey, postUrl } from './publish';
import { completePayment, getPayment, holdListing, preCheckout } from './payments';
import { registerSeller, TEMPLATE_TEXT } from './bot-seller';
import { sendWithCard } from './cards';
import { acceptTerms, hasAcceptedTerms, termsKeyboard, termsText } from './terms';

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
    // приглашение: t.me/<бот>?start=s_<код> — продавец, m_<код> — модератор, a_<код> — владелец
    const invite = ctx.match.match(/^([sma])_([\w-]{6,})$/);
    if (invite && ctx.from) {
      const role = ({ s: 'seller', m: 'mod', a: 'owner' } as const)[invite[1] as 's' | 'm' | 'a'];
      const res = await acceptInvite(env, invite[2], role, ctx.from);
      if (!res.ok) return ctx.reply(inviteReply(res, role), { parse_mode: 'HTML' });
      // новому продавцу — сразу шаблон, модератору — что будет приходить; обоим с картинкой.
      // Владельцу — без картинки: на картинке модератора написано «Вы модератор»
      if (role === 'seller') await sendWithCard(env, ctx.chat.id, 'seller', `${inviteReply(res, role)}\n\n${TEMPLATE_TEXT}`);
      else if (role === 'mod') await sendWithCard(env, ctx.chat.id, 'moderator', inviteReply(res, role));
      else await ctx.reply(inviteReply(res, role), { parse_mode: 'HTML' });
      const became = { seller: 'стал продавцом', mod: 'стал модератором', owner: 'стал владельцем' }[role];
      waitUntil(toStaff(env, `👤 ${personLink(ctx.from)} ${became} по приглашению.`));
      waitUntil(syncCommands(env, ctx.from.id));
      return;
    }
    if (!ctx.from) return;
    // покупатель сначала принимает условия площадки (нужно ЮKassa); что он открывал — запомним в кнопке
    const payload = /^l_\d+$/.test(ctx.match) ? ctx.match : '';
    if (!(await hasAcceptedTerms(env, ctx.from.id))) {
      await ctx.reply(termsText(origin), { parse_mode: 'HTML', reply_markup: termsKeyboard(origin, payload), link_preview_options: { is_disabled: true } });
      return;
    }
    await openStart(ctx.chat.id, ctx.from.id, payload);
  });

  h.callbackQuery(/^terms:ok(?::(l_\d+))?$/, async (ctx) => {
    await acceptTerms(env, ctx.from);
    // ответ на нажатие не обязателен: если Telegram его не примет, приветствие всё равно уйдёт
    await ctx.answerCallbackQuery('Спасибо! Условия приняты').catch(() => {});
    // в сообщении остаётся текст и ссылка на оферту, кнопка согласия уходит
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().url('📄 Условия оферты', `${origin}/oferta`) }).catch(() => {});
    await openStart(ctx.from.id, ctx.from.id, ctx.match[1] ?? '');
  });

  h.command('oferta', (ctx) =>
    ctx.reply(`Условия площадки ${STORE.name} — в публичной оферте.`, {
      reply_markup: new InlineKeyboard().url('📄 Открыть оферту', `${origin}/oferta`),
    }),
  );

  /** То, что видит покупатель после согласия: карточка из ссылки «Купить лот» или приветствие */
  async function openStart(chatId: number, userId: number, payload: string) {
    // ссылка «Поделиться» и «Купить лот» из канала: t.me/<бот>?start=l_12
    const shared = payload.match(/^l_(\d+)$/);
    if (shared) {
      const l = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(+shared[1]).first<ListingRow>();
      if (l?.status === 'active') {
        await bot.api.sendMessage(chatId, `📱 <b>${esc(listingTitle(l))}</b>${l.price_rub ? ' — ' + formatPrice(l.price_rub) : ''}`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp('Открыть карточку', `${origin}/?l=${l.id}`).row().webApp('Весь каталог', origin),
        });
        return;
      }
      if (l) {
        await bot.api.sendMessage(chatId, `${esc(listingTitle(l))} уже продан 🤷 Посмотрите, что есть сейчас:`, { reply_markup: catalogKb() });
        return;
      }
    }
    const count = await env.DB.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'active'`).first<{ c: number }>();
    const n = count?.c ?? 0;
    await sendWithCard(
      env,
      chatId,
      'welcome',
      [
        `Здравствуйте! Это каталог <b>${STORE.name}</b> 🍏`,
        '',
        n ? `Сейчас в наличии <b>${n}</b> ${plural(n, 'телефон', 'телефона', 'телефонов')} — только то, что можно купить прямо сейчас.` : 'Сейчас всё раскупили, но новые телефоны появляются почти каждый день.',
        '',
        '• фото, видео и честное описание каждого',
        '• фильтры по модели, памяти, цене и АКБ',
        '• «Купить» — оплачиваете услуги площадки и сразу получаете контакт продавца',
        '• вопросы по телефону — менеджеру @Raxi_apple',
        '• подписка: напишу, когда появится нужная модель',
      ].join('\n'),
      new InlineKeyboard().webApp('📱 Открыть каталог', origin).row().webApp('🔔 Сообщить о поступлении', `${origin}/?tab=subs`),
    );
    if (await isStaff(env, userId)) await bot.api.sendMessage(chatId, 'Команды сотрудника — /help');
    // продавцам и сотрудникам — меню их команд (после переезда на нового бота и после смены роли)
    waitUntil(syncCommands(env, userId, false));
  }

  // ——— Оплата комиссии: ЮKassa через Telegram Payments или тестовый режим ———
  h.on('pre_checkout_query', async (ctx) => {
    const q = ctx.preCheckoutQuery;
    let err: string | null;
    try {
      err = await preCheckout(env, q.invoice_payload, q.from.id, q.total_amount);
    } catch (e) {
      console.error('pre_checkout failed', e);
      err = 'Не получилось проверить заказ. Попробуйте ещё раз через минуту — деньги не списаны.';
    }
    await ctx.answerPreCheckoutQuery(!err, err ? { error_message: err } : undefined);
  });

  h.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const id = +(sp.invoice_payload.match(/^pay:(\d+)$/)?.[1] ?? 0);
    if (id) await completePayment(env, id, sp.telegram_payment_charge_id, sp.provider_payment_charge_id);
  });

  h.callbackQuery(/^tpay:(\d+)$/, async (ctx) => {
    if (env.PAYMENT_PROVIDER_TOKEN) return ctx.answerCallbackQuery('Тестовая оплата отключена — оформите покупку заново в каталоге');
    const pay = await getPayment(env, +ctx.match[1]);
    if (!pay || pay.buyer_id !== ctx.from.id) return ctx.answerCallbackQuery();
    if (pay.status === 'paid') return ctx.answerCallbackQuery('Уже оплачено');
    // та же проверка, что pre_checkout_query при настоящей оплате
    if (!(await holdListing(env, pay.listing_id, ctx.from.id))) {
      await ctx.answerCallbackQuery('Телефон уже забронирован или продан');
      await ctx.editMessageText('Этот телефон уже забронирован или продан — оплата не нужна.').catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery('Оплачено (тест)');
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await completePayment(env, pay.id, `test:${pay.id}`, null);
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
    if (!(await hasAcceptedTerms(env, ctx.from.id))) {
      return ctx.reply(termsText(origin), { parse_mode: 'HTML', reply_markup: termsKeyboard(origin), link_preview_options: { is_disabled: true } });
    }
    await ctx.reply('Все телефоны в наличии — в каталоге 👇', { reply_markup: catalogKb() });
  });

  return bot;
}

function inviteReply(res: InviteResult, role: InviteRole): string {
  if (res.ok) {
    if (role === 'owner') {
      return [
        `Готово, вы владелец <b>${STORE.name}</b> ✅`,
        '',
        'У вас все команды владельца: каталог и статистика, продавцы и модераторы, комиссия и канал публикации. Сюда будут приходить заявки продавцов и превью новых постов канала.',
        '',
        'Все команды — /help',
      ].join('\n');
    }
    return role === 'seller'
      ? `Готово, вы продавец <b>${STORE.name}</b> ✅`
      : [
          `Готово, вы модератор <b>${STORE.name}</b> ✅`,
          '',
          'Сюда будут приходить заявки продавцов с кнопками «Опубликовать», «Изменить цену» и «Отклонить», а также превью новых постов канала.',
          '',
          'Кто первым нажал — тот и решил: у остальных модераторов заявка обновится сама. Все команды — /help',
        ].join('\n');
  }
  switch (res.reason) {
    case 'no_username':
      return 'Чтобы покупатели могли вам написать, задайте имя пользователя: Настройки → Имя пользователя. Потом откройте ссылку ещё раз — она по-прежнему действует.';
    case 'already':
      return role === 'seller'
        ? 'Вы уже продавец — повторно ничего делать не нужно.'
        : role === 'owner'
          ? 'Вы уже владелец.'
          : 'Вы уже в команде магазина — повторно ничего делать не нужно.';
    case 'used':
      return 'Эта ссылка уже использована. Попросите новую у владельца.';
    case 'expired':
      return 'Срок ссылки истёк — она действует 24 часа. Попросите новую у владельца.';
    default:
      return 'Ссылка недействительна. Попросите новую у владельца.';
  }
}
