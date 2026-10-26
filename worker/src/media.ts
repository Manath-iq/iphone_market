import type { Env } from './env';

/** Хранилище медиа. Сейчас KV; для R2 достаточно другой реализации этих методов. */
export interface MediaStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export const kvMediaStore = (env: Env): MediaStore => ({
  async has(key) {
    const { keys } = await env.MEDIA.list({ prefix: key, limit: 1 });
    return keys.some((k) => k.name === key);
  },
  async put(key, body, contentType) {
    await env.MEDIA.put(key, body, { metadata: { ct: contentType } });
  },
  async get(key) {
    const r = await env.MEDIA.getWithMetadata<{ ct: string }>(key, 'arrayBuffer');
    if (!r.value) return null;
    return { body: r.value, contentType: r.metadata?.ct ?? 'application/octet-stream' };
  },
  async delete(key) {
    await env.MEDIA.delete(key);
  },
});

/** Bot API отдаёт файлы до 20 МБ */
export const TG_FILE_LIMIT = 20 * 1024 * 1024;

/**
 * Отдать медиа с долгим кэшем и поддержкой Range (без него iOS не играет видео).
 * Целый файл кладётся в edge-кэш, и запросы кусочков видео режутся уже из кэша, а не читают KV каждый раз.
 */
export async function serveMedia(env: Env, key: string, req: Request): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL(req.url).toString(), { method: 'GET' });
  let full = await cache.match(cacheKey);
  if (!full) {
    const obj = await kvMediaStore(env).get(key);
    if (!obj) return new Response('not found', { status: 404 });
    full = new Response(obj.body, {
      headers: {
        'content-type': obj.contentType,
        'content-length': String(obj.body.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
      },
    });
    await cache.put(cacheKey, full.clone());
  }
  const m = req.headers.get('range')?.match(/bytes=(\d*)-(\d*)/);
  if (!m) return full;
  const body = await full.arrayBuffer();
  const size = body.byteLength;
  const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
  const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  const headers = new Headers(full.headers);
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  headers.set('content-length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

/**
 * Медиа, которое хранит сам Telegram: в базе только file_id, файл берём через getFile при первом запросе.
 * Отвечаем всегда целым файлом (200) с годовым кэшем — дальше его раздаёт Workers Caching, он же сам режет
 * Range для видео на iOS. Тело идёт потоком, без чтения в память, чтобы не тратить CPU на большие видео.
 */
export async function serveTgMedia(env: Env, id: number): Promise<Response> {
  const noStore = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
  const m = await env.DB.prepare(`SELECT kind, source, file_size FROM media WHERE id = ? AND source LIKE 'tg:%'`)
    .bind(id)
    .first<{ kind: 'photo' | 'video'; source: string; file_size: number | null }>();
  if (!m) return noStore(404);
  // Bot API не отдаёт файлы больше 20 МБ — в карточке такого файла не будет, видео смотрят в посте
  const skip = async () => {
    await env.DB.prepare(`UPDATE media SET storage_key = 'skip' WHERE id = ?`).bind(id).run();
    return noStore(404);
  };
  if (m.file_size && m.file_size > TG_FILE_LIMIT) return skip();
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${m.source.slice(3)}`);
  const j = (await r.json().catch(() => null)) as { ok: boolean; result?: { file_path?: string }; description?: string } | null;
  if (!j?.ok || !j.result?.file_path) {
    console.warn('getFile failed', id, j?.description);
    return /too big/i.test(j?.description ?? '') ? skip() : noStore(502);
  }
  // ссылка содержит токен бота — наружу её не отдаём, только проксируем тело
  const file = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${j.result.file_path}`);
  if (!file.ok || !file.body) return noStore(502);
  const headers = new Headers({
    // Bot API отдаёт application/octet-stream — тип ставим сами
    'content-type': m.kind === 'video' ? 'video/mp4' : 'image/jpeg',
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  });
  const len = file.headers.get('content-length');
  if (len) headers.set('content-length', len);
  return new Response(file.body, { headers });
}
