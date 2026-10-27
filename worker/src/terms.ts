import { InlineKeyboard } from 'grammy';
import type { Env } from './env';
import { now } from './env';
import type { Person } from './roles';
import { STORE } from './config';

/**
 * Согласие с условиями площадки: оферта и обработка персональных данных.
 * Покупатель даёт его один раз — кнопкой «Принимаю условия» на /start или нажав «Оплатить» на экране оформления
 * (там есть текст «Переходя к оплате, вы соглашаетесь с условиями оферты»). Дату храним в users.terms_accepted_at.
 */

export async function hasAcceptedTerms(env: Env, userId: number): Promise<boolean> {
  const r = await env.DB.prepare('SELECT terms_accepted_at FROM users WHERE tg_user_id = ?')
    .bind(userId)
    .first<{ terms_accepted_at: number | null }>();
  return !!r?.terms_accepted_at;
}

/** Первую дату согласия не перезаписываем — она и есть юридически значимая */
export async function acceptTerms(env: Env, u: Person) {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO users (tg_user_id, username, first_name, updated_at, terms_accepted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tg_user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
       updated_at = excluded.updated_at, terms_accepted_at = COALESCE(users.terms_accepted_at, excluded.terms_accepted_at)`,
  )
    .bind(u.id, u.username ?? null, u.first_name ?? null, ts, ts)
    .run();
}

export const termsText = (origin: string) =>
  [
    `Добро пожаловать в <b>${STORE.name}</b> 🍏`,
    '',
    'Мы — площадка объявлений: iPhone и другие товары продают проверенные продавцы, сделка проходит напрямую между вами и продавцом. За контакт продавца площадка берёт фиксированную плату за услуги — она уже включена в цену.',
    '',
    `Перед началом ознакомьтесь с <a href="${origin}/oferta">условиями оферты</a>. Нажимая «Принимаю условия», вы соглашаетесь с ними и с обработкой ваших данных Telegram: после оплаты ваше имя пользователя передаётся продавцу выбранного товара.`,
  ].join('\n');

/** payload — что человек открывал (например, l_12 из «Купить лот»), чтобы после согласия показать именно это */
export const termsKeyboard = (origin: string, payload = '') =>
  new InlineKeyboard()
    .url('📄 Условия оферты', `${origin}/oferta`)
    .row()
    .text('✅ Принимаю условия', payload ? `terms:ok:${payload}` : 'terms:ok');
