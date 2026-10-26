/**
 * Картинки к сообщениям бота: design/bot-cards/<имя>.html → app/public/cards/<имя>.jpg (2560×1440).
 *   node scripts/render-cards.ts            — все картинки
 *   node scripts/render-cards.ts welcome    — одну
 * Сначала снимаются экраны живого мини-аппа (SCREENS) в design/bot-cards/shots/ — их картинки вставляют в рамку iPhone.
 * Chrome управляется по протоколу DevTools: только так можно эмулировать телефон 390×844 со светлой темой
 * (у headless-режима минимальная ширина окна больше, а в iframe не проигрываются анимации появления карточек).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CARDS = join(ROOT, 'design/bot-cards');
const OUT = join(ROOT, 'app/public/cards');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'https://raxi-catalog.todominate-ai.workers.dev';
const PORT = 9333;

/** экраны мини-аппа для рамки iPhone: каталог и карточка первого телефона в наличии */
const first = ((await (await fetch(`${APP}/api/listings`)).json()) as { items: { id: number }[] }).items[0];
const SCREENS: Record<string, string> = {
  catalog: `${APP}/`,
  ...(first ? { detail: `${APP}/?l=${first.id}` } : {}),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'raxi-cards-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], {
  stdio: 'ignore',
});

async function pageSocket(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome не запустился');
}

const ws = new WebSocket(await pageSocket());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result);
    pending.delete(msg.id);
  }
});
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function shoot(url: string, width: number, height: number, mobile: boolean, waitMs: number, format: 'png' | 'jpeg') {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const { data } = await send('Page.captureScreenshot', { format, quality: format === 'jpeg' ? 88 : undefined });
  return Buffer.from(data, 'base64');
}

try {
  await send('Page.enable');
  const only = process.argv.slice(2);
  const names = only.length ? only : readdirSync(CARDS).filter((f) => f.endsWith('.html') && f !== 'shot.html').map((f) => f.replace(/\.html$/, ''));

  mkdirSync(join(CARDS, 'shots'), { recursive: true });
  for (const [name, url] of Object.entries(SCREENS)) {
    // мини-апп грузит каталог и фото после старта — ждём с запасом
    writeFileSync(join(CARDS, 'shots', `${name}.png`), await shoot(url, 390, 844, true, 7000, 'png'));
    console.log(`экран ${name}`);
  }

  mkdirSync(OUT, { recursive: true });
  for (const name of names) {
    const jpg = await shoot(`file://${join(CARDS, `${name}.html`)}`, 1280, 720, false, 1500, 'jpeg');
    writeFileSync(join(OUT, `${name}.jpg`), jpg);
    console.log(`app/public/cards/${name}.jpg ${(jpg.length / 1024).toFixed(0)} КБ`);
  }

  // Версии картинок для бота: он хранит file_id отправленной картинки и при новой версии загружает её заново
  const versions = Object.fromEntries(
    readdirSync(OUT)
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => [f.replace(/\.jpg$/, ''), createHash('md5').update(readFileSync(join(OUT, f))).digest('hex').slice(0, 8)]),
  );
  writeFileSync(
    join(ROOT, 'worker/src/cards-version.ts'),
    `// Создаётся scripts/render-cards.ts — не править руками\nexport const CARD_VERSIONS = ${JSON.stringify(versions, null, 2)} as const;\n\nexport type CardName = keyof typeof CARD_VERSIONS;\n`,
  );
  console.log('worker/src/cards-version.ts', versions);
} finally {
  ws.close();
  // профиль удаляем, когда Chrome закончил в него писать
  await new Promise((r) => (chrome.once('exit', r), chrome.kill()));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
