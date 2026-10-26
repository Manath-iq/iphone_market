import { InlineKeyboard } from 'grammy';
import { formatPrice, listingTitle } from '../../shared/parser';
import type { Env } from './env';
import { now } from './env';
import type { ListingRow } from './db';
import { logEvent } from './db';
import { api, esc, toStaff } from './notify';
import { getSeller, personLink, type Person } from './roles';
import { getSettings } from './settings';
import { STORE } from './config';
import { sendWithCard } from './cards';

/**
 * Оплата комиссии площадки и бронь.
 * - Есть секрет PAYMENT_PROVIDER_TOKEN — счёт Telegram Payments (ЮKassa) открывается прямо в мини-аппе.
 * - Нет секрета — тестовый режим: бот присылает кнопку «Оплатить (тест)», сценарий проходит целиком без денег.
 * На время оплаты телефон удерживается 10 минут, после оплаты — бронь на reserve_hours. Покупатель получает только ник продавца.
 */

export interface PaymentRow {
  id: number;
  listing_id: number;
  buyer_id: number;
  buyer_username: string | null;
  buyer_name: string | null;
  amount_rub: number;
  mode: 'test' | 'yookassa';
  status: 'pending' | 'paid';
  charge_id: string | null;
  created_at: number;
  paid_at: number | null;
}

/** удержание на время оплаты: второй покупатель за эти минуты оплатить не сможет */
const HOLD_SEC = 600;

export const isReserved = (l: Pick<ListingRow, 'reserved_until'>) => !!l.reserved_until && l.reserved_until > now();

export type CheckoutResult =
  | { ok: true; mode: 'invoice'; url: string }
  | { ok: true; mode: 'test' }
  | { ok: false; error: 'not_found' | 'sold' | 'reserved' | 'mine' | 'no_price' | 'cant_message' };

/** Кнопка «Оплатить» в мини-аппе: создаём платёж и счёт (или тестовую кнопку в боте) */
export async function createCheckout(env: Env, listingId: number, buyer: Person): Promise<CheckoutResult> {
  const l = await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(listingId).first<ListingRow>();
  if (!l || l.status === 'hidden') return { ok: false, error: 'not_found' };
  if (l.status !== 'active') return { ok: false, error: 'sold' };
  if (isReserved(l)) return { ok: false, error: l.reserved_by === buyer.id && l.reserve_paid ? 'mine' : 'reserved' };
  if (!l.price_rub || !l.fee_rub) return { ok: false, error: 'no_price' };

  const mode = env.PAYMENT_PROVIDER_TOKEN ? 'yookassa' : 'test';
  const pay = await env.DB.prepare(
    `INSERT INTO payments (listing_id, buyer_id, buyer_username, buyer_name, amount_rub, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
    .bind(l.id, buyer.id, buyer.username ?? null, buyer.first_name ?? null, l.fee_rub, mode, now())
    .first<PaymentRow>();
  await logEvent(env, 'buy_click', buyer.id, l.id);
  const title = listingTitle(l);
  const rest = formatPrice(l.price_rub - l.fee_rub);

  if (mode === 'yookassa') {
    const amount = l.fee_rub * 100;
    const url = await api(env).createInvoiceLink(
      `Услуги площадки · лот №${l.id}`,
      `${title}: контакт продавца и бронь на ${(await getSettings(env)).reserve_hours} ч. Остаток ${rest} — продавцу напрямую.`.slice(0, 255),
      `pay:${pay!.id}`,
      env.PAYMENT_PROVIDER_TOKEN!,
      'RUB',
      [{ label: 'Услуги площадки', amount }],
      {
        need_email: true,
        send_email_to_provider: true,
        // чек 54-ФЗ формирует ЮKassa по этим данным; email покупатель вводит в форме оплаты
        provider_data: JSON.stringify({
          receipt: {
            items: [
              {
                description: `Услуги площадки, лот №${l.id}`,
                quantity: '1.00',
                amount: { value: l.fee_rub.toFixed(2), currency: 'RUB' },
                vat_code: 1,
                payment_mode: 'full_payment',
                payment_subject: 'service',
              },
            ],
          },
        }),
      },
    );
    return { ok: true, mode: 'invoice', url };
  }

  try {
    await api(env).sendMessage(
      buyer.id,
      [
        '🧪 <b>Тестовая оплата</b> — деньги не списываются.',
        '',
        `Лот №${l.id} · ${esc(title)}`,
        `Услуги площадки: <b>${formatPrice(l.fee_rub)}</b>`,
        `Остаток ${rest} — продавцу напрямую.`,
        '',
        'После оплаты пришлём контакт продавца, а телефон забронируем за вами.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(`Оплатить ${formatPrice(l.fee_rub)} (тест)`, `tpay:${pay!.id}`) },
    );
  } catch (e) {
    console.warn('test invoice send failed', buyer.id, String(e));
    return { ok: false, error: 'cant_message' };
  }
  return { ok: true, mode: 'test' };
}

export async function getPayment(env: Env, id: number) {
  return env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<PaymentRow>();
}

/**
 * Удержать телефон за покупателем на время оплаты. Один атомарный UPDATE: если двое платят одновременно,
 * удержание получит один, второму Telegram откажет в оплате ещё до списания денег.
 */
export async function holdListing(env: Env, listingId: number, buyerId: number) {
  const ts = now();
  return env.DB.prepare(
    `UPDATE listings SET reserved_until = ?, reserved_by = ?, reserve_paid = 0, reserve_notified = 0
     WHERE id = ? AND status = 'active' AND (reserved_until IS NULL OR reserved_until < ? OR (reserved_by = ? AND reserve_paid = 0))
     RETURNING *`,
  )
    .bind(ts + HOLD_SEC, buyerId, listingId, ts, buyerId)
    .first<ListingRow>();
}

/** pre_checkout_query: проверка перед списанием денег. Текст ошибки Telegram покажет покупателю. */
export async function preCheckout(env: Env, payload: string, buyerId: number, totalAmount: number): Promise<string | null> {
  const id = +(payload.match(/^pay:(\d+)$/)?.[1] ?? 0);
  const pay = id ? await getPayment(env, id) : null;
  if (!pay || pay.buyer_id !== buyerId || pay.status !== 'pending') return 'Счёт устарел. Откройте карточку и нажмите «Купить» ещё раз.';
  if (pay.amount_rub * 100 !== totalAmount) return 'Сумма изменилась. Откройте карточку и нажмите «Купить» ещё раз.';
  const held = await holdListing(env, pay.listing_id, buyerId);
  return held ? null : 'Этот телефон уже забронирован или продан — деньги не списаны.';
}

/**
 * Оплата прошла: бронь, ник продавца покупателю, уведомления продавцу и сотрудникам.
 * Повтор апдейта или повторное нажатие тестовой кнопки ничего не делает — платёж переходит в paid один раз.
 */
export async function completePayment(env: Env, paymentId: number, chargeId: string, providerChargeId: string | null) {
  const ts = now();
  const pay = await env.DB.prepare(
    `UPDATE payments SET status = 'paid', charge_id = ?, provider_charge_id = ?, paid_at = ?
     WHERE id = ? AND status = 'pending' RETURNING *`,
  )
    .bind(chargeId, providerChargeId, ts, paymentId)
    .first<PaymentRow>();
  if (!pay) return null;
  const { reserve_hours } = await getSettings(env);
  const until = ts + reserve_hours * 3600;
  const l = await env.DB.prepare(
    `UPDATE listings SET reserved_until = ?, reserved_by = ?, reserve_paid = 1, reserve_notified = 0 WHERE id = ? RETURNING *`,
  )
    .bind(until, pay.buyer_id, pay.listing_id)
    .first<ListingRow>();
  if (!l) return null;
  await logEvent(env, 'payment', pay.buyer_id, l.id);

  const seller = l.seller_id ? await getSeller(env, l.seller_id) : null;
  const sellerNick = l.seller_id ? seller?.username : STORE.sellerUsername;
  const title = esc(listingTitle(l));
  const untilText = formatMsk(until);
  const rest = formatPrice((l.price_rub ?? 0) - (l.fee_rub ?? 0));
  const buyer = personLink({ id: pay.buyer_id, username: pay.buyer_username, first_name: pay.buyer_name });

  let delivered = true;
  // сообщение с контактом — с картинкой «Оплата прошла»
  const toBuyer = (text: string, kb?: InlineKeyboard) =>
    sendWithCard(env, pay.buyer_id, 'paid', text, kb)
      .catch((e) => {
        delivered = false;
        console.error('buyer contact send failed', pay.buyer_id, String(e));
      });
  if (sellerNick) {
    await toBuyer(
      [
        `✅ <b>Оплата прошла.</b> Лот №${l.id} · ${title}`,
        '',
        `Продавец: @${esc(sellerNick)}`,
        'Напишите ему, чтобы договориться о встрече и оплате.',
        '',
        `Остаток <b>${rest}</b> оплачивается продавцу напрямую.`,
        `Телефон забронирован за вами до ${untilText} (МСК).`,
      ].join('\n'),
      new InlineKeyboard().url('Написать продавцу', `https://t.me/${sellerNick}`),
    );
  } else {
    // у продавца пропал @username — контакт передаст менеджер
    await toBuyer(
      `✅ Оплата прошла. Лот №${l.id} · ${title}\n\nКонтакт продавца пришлёт менеджер @Raxi_apple в ближайшее время. Телефон забронирован за вами до ${untilText} (МСК).`,
    );
  }
  if (l.seller_id) {
    await api(env)
      .sendMessage(
        l.seller_id,
        `💰 <b>Лот №${l.id} оплачен</b> · ${title}\n\nПокупатель ${buyer} напишет вам. Остаток ${rest} — вам напрямую.\nБронь до ${untilText} (МСК). Когда продадите, отметьте в /my.`,
        { parse_mode: 'HTML' },
      )
      .catch((e) => console.warn('seller notify failed', String(e)));
  }
  await toStaff(
    env,
    [
      `💳 <b>Сделка</b> · <a href="${l.post_url}">лот №${l.id}</a> · ${title}`,
      `Покупатель ${buyer} оплатил ${formatPrice(pay.amount_rub)}${pay.mode === 'test' ? ' (тест, без денег)' : ''}.`,
      `Продавец: ${l.seller_id ? personLink({ id: l.seller_id, username: seller?.username, first_name: seller?.first_name }) : 'вы (пост в канале)'}`,
      sellerNick ? `Бронь до ${untilText} (МСК).` : '⚠️ У продавца нет @username — передайте покупателю контакт вручную.',
      delivered ? '' : '⚠️ Бот не смог написать покупателю — свяжитесь с ним и передайте контакт продавца.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return { pay, listing: l };
}

/** Снять бронь вручную (/unreserve) — например, если тестовую оплату нажал случайный человек */
export async function unreserve(env: Env, listingId: number) {
  return env.DB.prepare(
    `UPDATE listings SET reserved_until = NULL, reserved_by = NULL, reserve_paid = 0, reserve_notified = 0 WHERE id = ? RETURNING *`,
  )
    .bind(listingId)
    .first<ListingRow>();
}

/** Cron: оплаченные брони истекли, а «Продан» не отметили — сообщаем продавцу и сотрудникам, лот снова доступен */
export async function notifyExpiredReservations(env: Env, limit = 5) {
  const { results } = await env.DB.prepare(
    `UPDATE listings SET reserve_notified = 1 WHERE id IN (
       SELECT id FROM listings WHERE status = 'active' AND reserve_paid = 1 AND reserve_notified = 0 AND reserved_until < ? LIMIT ?)
     RETURNING *`,
  )
    .bind(now(), limit)
    .all<ListingRow>();
  for (const l of results) {
    const text = `⏰ Бронь лота №${l.id} (${esc(listingTitle(l))}) истекла — он снова доступен покупателям. Если телефон продан, отметьте это${l.seller_id ? ' в /my' : ': /sold ' + l.id}.`;
    if (l.seller_id) await api(env).sendMessage(l.seller_id, text, { parse_mode: 'HTML' }).catch(() => {});
    await toStaff(env, text);
  }
  return { expired: results.length };
}

export const formatMsk = (ts: number) =>
  new Date(ts * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
