import type { ParsedPost } from './types';
import { ACTIVE_TAG, formatPrice, listingTitle } from './parser';

/** Менеджер площадки: ему пишут вопросы по лоту. Продавца покупатель до оплаты не видит. */
export const MANAGER_USERNAME = 'Raxi_apple';

/** Лимит подписи к фото/альбому в Telegram */
export const CAPTION_LIMIT = 1024;

export type CaptionFields = Pick<
  ParsedPost,
  'family' | 'model_raw' | 'storage_gb' | 'condition' | 'sim' | 'battery_pct' | 'battery_cycles' | 'ios' | 'pluses' | 'nuances'
> & {
  /** other — товар не iPhone: название в model_raw, вместо характеристик — описание продавца */
  category?: ParsedPost['category'];
  description?: string | null;
};

export interface CaptionOptions {
  /** итоговая цена для покупателя (цена продавца + комиссия) */
  price: number;
  /** номер лота; нет — превью до публикации */
  lot?: number | null;
  /** ссылка «Купить лот» в мини-апп */
  buyUrl?: string | null;
  /** товар продан или снят: вместо хэштега — пометка, ссылки «Купить» нет */
  closed?: 'sold' | 'withdrawn' | null;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

const CONTACT_PATTERNS = [
  // ссылки: t.me/…, telegram.me/…, http(s)://…, www.…
  /(?:https?:\/\/|www\.)\S+/gi,
  /\b(?:t|telegram)\.me\/\S+/gi,
  // @ники Telegram (минимум 4 символа, как требует Telegram)
  /@[A-Za-z0-9_]{4,}/g,
  // телефоны: 10–11 цифр с любыми разделителями, +7 / 8 в начале
  /(?:\+\d|\b\d)(?:[\s\-()]*\d){9,11}\b/g,
];

/** Убирает из текста продавца контакты: ники, ссылки и телефоны. Покупатель получает контакт только после оплаты. */
export function stripContacts(text: string): string {
  let s = text;
  for (const re of CONTACT_PATTERNS) s = s.replace(re, ' ');
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:—–-]+|[\s,;:—–-]+$/g, '')
    .trim();
}

/**
 * То же для описания другого товара: чистим каждую строку отдельно, переносы и отступы продавца сохраняем.
 * Строка, в которой были только контакты, пропадает; подряд идущие пустые строки схлопываются в одну.
 */
export function stripContactsMultiline(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let s = line;
    for (const re of CONTACT_PATTERNS) s = s.replace(re, '');
    if (s !== line) {
      s = s.replace(/(\S) {2,}/g, '$1 ').replace(/[\s,;:—–-]+$/, '');
      if (!s.trim()) continue;
    }
    s = s.trimEnd();
    if (!s && (!lines.length || lines[lines.length - 1] === '')) continue;
    lines.push(s);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Подпись поста в фирменном формате магазина — из разобранных полей, а не из текста продавца, поэтому
 * случайные контакты и лишнее в канал не попадают. Формат совместим с parsePost: пост разбирается обратно в те же поля.
 * Текст — HTML (parse_mode: 'HTML'). Если не влезает в лимит Telegram, сначала убираем плюсы, потом нюансы с конца.
 */
export function buildCaption(f: CaptionFields, o: CaptionOptions): string {
  if (f.category === 'other') return otherCaption(f, o);
  const pluses = f.pluses.map(stripContacts).filter(Boolean);
  const nuances = f.nuances.map(stripContacts).filter(Boolean);
  const render = () => {
    const lines = [`📱 ${esc(listingTitle(f))}`, tagLine(o)];
    if (o.lot) lines.push(`ЛОТ №${o.lot}`);
    lines.push('');
    const condition = f.condition && stripContacts(f.condition);
    if (condition) lines.push(`Состояние: ${esc(condition)}`);
    const sim = f.sim && stripContacts(f.sim);
    if (sim) lines.push(esc(sim));
    if (f.battery_pct) lines.push(`✅ Акб ${f.battery_pct}%${f.battery_cycles ? ` (${f.battery_cycles} ц)` : ''}`);
    if (f.ios) lines.push(`✅ iOS ${esc(f.ios)}`);
    for (const p of pluses) lines.push(`✅ ${esc(p)}`);
    for (const n of nuances) lines.push(`✖️ ${esc(n)}`);
    lines.push('', `💰 ${formatPrice(o.price)}`, '');
    const buy = `Купить лот №${o.lot ?? '…'}`;
    if (!o.closed) lines.push(o.lot && o.buyUrl ? `🛒 <a href="${esc(o.buyUrl)}">${buy}</a>` : `🛒 ${buy}`);
    lines.push(`❓ Вопрос по лоту — @${MANAGER_USERNAME}`);
    return lines.join('\n');
  };
  let html = render();
  while (plain(html).length > CAPTION_LIMIT && (pluses.length || nuances.length)) {
    (pluses.length ? pluses : nuances).pop();
    html = render();
  }
  return html;
}

const tagLine = (o: CaptionOptions) => (o.closed === 'sold' ? '❌ Продано ❌' : o.closed === 'withdrawn' ? '⛔️ Снято с продажи' : ACTIVE_TAG);

/** Пост другого товара: название, описание продавца как есть (без контактов), цена */
function otherCaption(f: CaptionFields, o: CaptionOptions, cut = 0): string {
  let description = stripContactsMultiline(f.description ?? '');
  if (cut) description = description.slice(0, Math.max(0, description.length - cut - 1)).trimEnd() + '…';
  const lines = [`📦 ${esc(stripContacts(f.model_raw ?? '') || 'Товар')}`, tagLine(o)];
  if (o.lot) lines.push(`ЛОТ №${o.lot}`);
  if (description) lines.push('', esc(description));
  lines.push('', `💰 ${formatPrice(o.price)}`, '');
  const buy = `Купить лот №${o.lot ?? '…'}`;
  if (!o.closed) lines.push(o.lot && o.buyUrl ? `🛒 <a href="${esc(o.buyUrl)}">${buy}</a>` : `🛒 ${buy}`);
  lines.push(`❓ Вопрос по лоту — @${MANAGER_USERNAME}`);
  const html = lines.join('\n');
  // описание проверяем при подаче (descriptionOverflow); обрезка — только страховка
  const over = plain(html).length - CAPTION_LIMIT;
  return over > 0 && description && !cut ? otherCaption(f, o, over) : html;
}

/**
 * На сколько символов описание не влезает в подпись поста (0 — влезает). Считаем с самым длинным
 * номером лота и строкой «Купить», чтобы пост влез и после публикации.
 */
export function descriptionOverflow(title: string, description: string, price: number): number {
  const lines = [
    `📦 ${stripContacts(title)}`, ACTIVE_TAG, 'ЛОТ №9999999', '', stripContactsMultiline(description), '',
    `💰 ${formatPrice(price)}`, '', '🛒 Купить лот №9999999', `❓ Вопрос по лоту — @${MANAGER_USERNAME}`,
  ];
  return Math.max(0, lines.join('\n').length - CAPTION_LIMIT);
}

/** Шаблон подписи, который бот присылает продавцу */
export const SELLER_TEMPLATE = `📱 iPhone 15 Pro 256GB
Состояние: Идеал
SIM + eSIM
✅ Акб 91%
✅ Экран без царапин
✅ Полный комплект
✖️ Следы от чехла по бокам

💰 79 000 ₽`;
