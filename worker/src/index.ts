import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { webhookCallback } from 'grammy';
import type { Env } from './env';
import { now } from './env';
import { verifyInitData, type TgUser } from './auth';
import { getFacets, getListing, listSubscriptions, logEvent, queryListings, upsertUser } from './db';
import { serveMedia, serveTgMedia } from './media';
import { createBot } from './bot';
import { catchUpNotifications, sendWeeklyStats } from './notify';
import { checkDeleted, importChannel, importReviews, type ReviewsMeta } from './importer';
import { downloadPending, purgeSoldMedia } from './ingest';
import { PUBLIC_ORIGIN, STORE } from './config';
import { MANAGER_USERNAME } from '../../shared/caption';
import { createCheckout, notifyExpiredReservations } from './payments';
import { acceptTerms } from './terms';

type Ctx = { Bindings: Env; Variables: { user: TgUser | null } };
const app = new Hono<Ctx>();

// ——— Бот ———
app.post('/bot', (c) => {
  const bot = createBot({ env: c.env, origin: new URL(c.req.url).origin, waitUntil: (p) => c.executionCtx.waitUntil(p) });
  return webhookCallback(bot, 'std/http', { secretToken: c.env.WEBHOOK_SECRET, onTimeout: 'return' })(c.req.raw);
});

// ——— Медиа ———
// Файлы из Telegram идут через MediaCache: перед этой точкой входа стоит Workers Caching (см. wrangler.toml),
// поэтому повторные запросы и куски видео отдаются из кэша, а воркер и Telegram не вызываются
app.get('/media/f/:id{[0-9]+}', (c) => (c.executionCtx.exports as unknown as { MediaCache: Fetcher }).MediaCache.fetch(c.req.raw));
app.get('/media/*', (c) => serveMedia(c.env, decodeURIComponent(c.req.path.slice('/media/'.length)), c.req.raw));

// ——— API: подпись initData проверяется на каждом запросе ———
app.use('/api/*', async (c, next) => {
  const initData = c.req.header('x-init-data') ?? '';
  const user = await verifyInitData(initData, c.env.BOT_TOKEN);
  const readOnly = c.req.method === 'GET' && !c.req.path.startsWith('/api/subscriptions');
  if (!user && !(readOnly && c.env.PUBLIC_READ === '1')) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  await next();
});

const num = (v: string | undefined) => (v ? parseInt(v, 10) || undefined : undefined);

app.get('/api/listings', async (c) => {
  const q = c.req.query();
  const items = await queryListings(c.env, {
    family: q.family || undefined,
    storage: num(q.storage),
    price_min: num(q.price_min),
    price_max: num(q.price_max),
    battery_min: num(q.battery_min),
    condition: q.condition || undefined,
    sim: q.sim === 'physical' || q.sim === 'esim' ? q.sim : undefined,
    sort: (q.sort as 'new') || 'new',
  });
  return c.json({ items });
});

app.get('/api/listings/:id', async (c) => {
  const l = await getListing(c.env, +c.req.param('id'), c.get('user')?.id);
  if (!l || l.status === 'hidden') return c.json({ error: 'not found' }, 404);
  return c.json(l);
});

app.get('/api/facets', async (c) => c.json(await getFacets(c.env)));

app.get('/api/store', async (c) => {
  const reviews = await c.env.MEDIA.get<ReviewsMeta>('meta:reviews', 'json');
  return c.json({ name: STORE.name, channel: STORE.channel, manager: MANAGER_USERNAME, about: STORE.about, reviews });
});

const EVENT_TYPES = new Set(['app_open', 'card_view', 'subscribe']);
app.post('/api/events', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json<{ type: string; listing_id?: number }>().catch(() => null);
  if (!body || !EVENT_TYPES.has(body.type)) return c.json({ error: 'bad event' }, 400);
  if (body.type === 'app_open') c.executionCtx.waitUntil(upsertUser(c.env, user));
  await logEvent(c.env, body.type, user.id, body.listing_id ?? null);
  return c.json({ ok: true });
});

const CHECKOUT_ERRORS = {
  not_found: 'Этого телефона уже нет в каталоге',
  sold: 'Этот телефон уже продан',
  reserved: 'Этот телефон уже забронирован другим покупателем',
  mine: 'Вы уже забронировали этот телефон — контакт продавца в чате с ботом',
  no_price: 'У этого телефона не указана цена — напишите менеджеру',
  cant_message: 'Не получилось написать вам в чат с ботом. Откройте бота, нажмите «Старт» и попробуйте ещё раз',
} as const;

// «Оплатить» на экране оформления: счёт ЮKassa для openInvoice или тестовая кнопка в чате с ботом
app.post('/api/checkout', async (c) => {
  const user = c.get('user')!;
  const { listing_id } = await c.req.json<{ listing_id: number }>();
  const r = await createCheckout(c.env, +listing_id, user);
  if (!r.ok) return c.json({ error: r.error, message: CHECKOUT_ERRORS[r.error] }, 409);
  // «Оплатить» нажимают под текстом «Переходя к оплате, вы соглашаетесь с условиями оферты» — это тоже согласие
  c.executionCtx.waitUntil(acceptTerms(c.env, user));
  return c.json(r);
});

app.get('/api/subscriptions', async (c) => c.json({ items: await listSubscriptions(c.env, c.get('user')!.id) }));

app.post('/api/subscriptions', async (c) => {
  const user = c.get('user')!;
  const b = await c.req.json<{ family: string; storage_gb?: number | null; max_price?: number | null }>();
  if (!b.family) return c.json({ error: 'family required' }, 400);
  await c.env.DB.prepare(
    'INSERT INTO subscriptions (tg_user_id, family, storage_gb, max_price, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(user.id, b.family, b.storage_gb || null, b.max_price || null, now())
    .run();
  await logEvent(c.env, 'subscribe', user.id);
  c.executionCtx.waitUntil(upsertUser(c.env, user));
  return c.json({ items: await listSubscriptions(c.env, user.id) });
});

app.delete('/api/subscriptions/:id', async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('UPDATE subscriptions SET active = 0 WHERE id = ? AND tg_user_id = ?')
    .bind(+c.req.param('id'), user.id)
    .run();
  return c.json({ items: await listSubscriptions(c.env, user.id) });
});

// ——— Админка для импорта (ключ в секрете ADMIN_API_KEY) ———
app.use('/admin/*', async (c, next) => {
  if (!c.env.ADMIN_API_KEY || c.req.header('x-admin-key') !== c.env.ADMIN_API_KEY) return c.json({ error: 'forbidden' }, 403);
  await next();
});
app.post('/admin/import', async (c) => c.json(await importChannel(c.env, c.req.query('channel') || STORE.channel, num(c.req.query('pages')) ?? 3)));
app.post('/admin/media', async (c) => c.json(await downloadPending(c.env, 20)));
app.post('/admin/reviews', async (c) => c.json(await importReviews(c.env)));
app.post('/admin/check', async (c) => c.json(await checkDeleted(c.env)));
app.post('/admin/purge', async (c) => c.json(await purgeSoldMedia(c.env, num(c.req.query('days')) ?? 7)));

/** Кэшируемая точка входа только для медиа из Telegram. Остальной воркер (API, бот) без кэша. */
export class MediaCache extends WorkerEntrypoint<Env> {
  async fetch(req: Request) {
    const id = +(new URL(req.url).pathname.match(/^\/media\/f\/(\d+)$/)?.[1] ?? 0);
    return id ? serveTgMedia(this.env, id) : new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === '0 7 * * 1') {
      ctx.waitUntil(sendWeeklyStats(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        // бесплатный тариф — 50 подзапросов на запуск: 15 проверок постов + 12 файлов импорта
        // + 6 уведомлений подписчикам (до 12 запросов, если фото не прошло) + 3 истёкшие брони (продавец и сотрудники)
        await checkDeleted(env, 15);
        await downloadPending(env, 12);
        // в cron нет запроса, а origin нужен для кнопки «Открыть карточку»
        await catchUpNotifications(env, PUBLIC_ORIGIN, 6);
        await notifyExpiredReservations(env, 3);
        await purgeSoldMedia(env);
        await env.DB.prepare('DELETE FROM events WHERE created_at < ?').bind(now() - 90 * 86400).run();
        await env.DB.prepare('DELETE FROM media WHERE listing_id IS NULL AND created_at < ?').bind(now() - 86400).run();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
