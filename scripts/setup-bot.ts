/**
 * Настройка бота в Telegram: вебхук, кнопка «Каталог», общее меню команд и описание.
 * Запускать при подключении нового бота (например, бота заказчика) после `wrangler secret put BOT_TOKEN / WEBHOOK_SECRET`:
 *   BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/setup-bot.ts
 * Меню команд продавцов и сотрудников бот ставит сам, когда они нажимают /start (worker/src/commands.ts).
 */
export {};

const token = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const app = process.env.APP_URL ?? 'https://raxi-catalog.todominate-ai.workers.dev';
if (!token || !secret) {
  console.error('Нужны переменные BOT_TOKEN и WEBHOOK_SECRET');
  process.exit(1);
}

async function call(method: string, body: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok: boolean; description?: string };
  console.log(j.ok ? '✓' : '✗', method, j.ok ? '' : j.description);
  if (!j.ok) process.exitCode = 1;
}

await call('setWebhook', {
  url: `${app}/bot`,
  secret_token: secret,
  // pre_checkout_query и message нужны оплате через ЮKassa
  allowed_updates: ['message', 'channel_post', 'edited_channel_post', 'callback_query', 'pre_checkout_query'],
  drop_pending_updates: true,
});
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Каталог', web_app: { url: `${app}/` } } });
await call('setMyCommands', {
  commands: [
    { command: 'start', description: 'Открыть каталог' },
    { command: 'oferta', description: 'Условия и оферта' },
  ],
});
await call('setMyDescription', {
  description: 'Каталог б/у iPhone в наличии от RaXi Store. Только актуальные телефоны — с фото, АКБ и честными нюансами. Нажмите «Каталог» внизу.',
});
await call('setMyShortDescription', { short_description: 'Б/у iPhone в наличии — каталог RaXi Store' });
