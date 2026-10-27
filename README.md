# RaXi Store — каталог iPhone в Telegram

Демо по ТЗ «бот + мини-апп «Каталог RaXi Apple»»: продавец постит в канал как обычно, бот сам собирает каталог, покупатель видит только то, что в наличии.

- **Бот:** [@Raxi_store_bot](https://t.me/Raxi_store_bot)
- **Мини-апп:** https://raxi-catalog.todominate-ai.workers.dev

## Как устроено

```
канал ──channel_post / edited_channel_post──▶ Worker /bot (grammY)
                                               │  shared/parser.ts — регулярки, Workers AI как запасной путь
                                               ▼
                                   D1 raxi-catalog-db + KV raxi-media (фото/видео)
                                               │
мини-апп (app/, Preact) ◀──── /api/* (Hono, проверка initData) ──┘
```

| Папка | Что внутри |
| --- | --- |
| `app/` | Мини-апп: Vite + Preact, ~22 КБ gzip + Lottie-плеер отдельным чанком. Цвета из `themeParams`, во весь экран на телефонах. Анимированные эмодзи из набора [RestrictedEmoji](https://t.me/addemoji/RestrictedEmoji) лежат в `app/public/emoji`, обновляются через `BOT_TOKEN=... node scripts/fetch-emoji.ts` |
| `worker/` | Cloudflare Worker: бот, API, cron, раздача статики и медиа |
| `shared/` | Парсер постов, разбор ленты `t.me/s`, типы. Тесты — на реальных постах канала (`shared/fixtures`) |
| `scripts/import.ts` | Импорт истории с публичной ленты |

Синхронизация: пост с `#АКТУАЛЬНО_RaXi` → карточка; хэштег убрали (продавец пишет «❌ Продано ❌») → карточка снята; пост удалён → cron раз в час проверяет `t.me/<канал>/<id>?embed=1`.

## Команды

```bash
npm install
npm test            # парсер на постах из ТЗ и ленте канала
npm run build       # сборка мини-аппа в app/dist
npm run deploy      # сборка + wrangler deploy
npm run db:migrate  # миграции D1
RAXI_URL=https://raxi-catalog.todominate-ai.workers.dev RAXI_ADMIN_KEY=... npm run import
```

Секреты воркера (`wrangler secret put … --config worker/wrangler.toml`): `BOT_TOKEN`, `ADMIN_IDS` (через запятую), `WEBHOOK_SECRET`, `ADMIN_API_KEY`.

Вебхук: `setWebhook` на `<url>/bot` с `secret_token = WEBHOOK_SECRET` и `allowed_updates = message, channel_post, edited_channel_post, callback_query`.

## Бот

- Покупатель: `/start` — кнопка каталога; уведомления по подпискам.
- Админ: превью новых карточек с кнопками «Всё верно / Скрыть», заявки «@user нажал Купить», `/list`, `/stats`, `/sold id`, `/hide id`, `/show id`, статистика по понедельникам в 10:00 МСК.

## Демо-допущения (заменить перед запуском у продавца)

- `worker/src/config.ts`: `sellerUsername: 'manath'` → `'Raxi_Apple'`; тексты «О магазине» — заглушки (`about.demo`).
- `worker/wrangler.toml`: `PUBLIC_READ = "1"` — каталог читается и без `initData`, чтобы ссылку можно было открыть в браузере. Для продакшена поставить `"0"`.
- Медиа в KV, потому что R2 на аккаунте не включён. Хранилище за интерфейсом `MediaStore` в `worker/src/media.ts`.
