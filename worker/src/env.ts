export interface Env {
  DB: D1Database;
  MEDIA: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  /** Telegram ID админов через запятую */
  ADMIN_IDS: string;
  WEBHOOK_SECRET: string;
  ADMIN_API_KEY: string;
  PUBLIC_READ?: string;
  /** шаблон ссылки «Купить лот» под постом, {id} — номер лота; см. appLink в publish.ts */
  APP_LINK?: string;
  /** токен ЮKassa из BotFather → Payments; пока его нет, оплата работает в тестовом режиме */
  PAYMENT_PROVIDER_TOKEN?: string;
}

export const adminIds = (env: Env): number[] =>
  (env.ADMIN_IDS ?? '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter(Number.isFinite);

export const now = () => Math.floor(Date.now() / 1000);
