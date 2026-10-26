import type { Env } from './env';
import { now } from './env';

/** Настройки площадки. Владелец меняет их командами бота, без правки кода. */
export interface Settings {
  /** комиссия площадки для новых карточек, ₽ */
  fee_rub: number;
  /** срок брони после оплаты, часов */
  reserve_hours: number;
  /** куда бот публикует товары продавцов */
  publish_chat_id: string;
  /** название канала публикации — для /help, чтобы не спрашивать Telegram каждый раз */
  publish_chat_title: string;
  /** посты владельца: plus — комиссия сверху цены поста, incl — уже внутри неё */
  owner_fee_mode: 'plus' | 'incl';
}

const DEFAULTS: Settings = {
  fee_rub: 1000,
  reserve_hours: 24,
  // тестовый канал «RaXi тест»; боевой @apple_raxi включается командой /channel
  publish_chat_id: '-1004372227928',
  publish_chat_title: 'RaXi тест',
  owner_fee_mode: 'plus',
};

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const s: Settings = { ...DEFAULTS };
  for (const { key, value } of results) {
    if (key === 'fee_rub' || key === 'reserve_hours') s[key] = +value || DEFAULTS[key];
    else if (key === 'publish_chat_id' || key === 'publish_chat_title') s[key] = value;
    else if (key === 'owner_fee_mode') s.owner_fee_mode = value === 'incl' ? 'incl' : 'plus';
  }
  return s;
}

export async function setSetting<K extends keyof Settings>(env: Env, key: K, value: Settings[K]) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, String(value), now())
    .run();
}
