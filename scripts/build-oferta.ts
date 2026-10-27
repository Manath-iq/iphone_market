/**
 * Страница оферты: docs/oferta.md → app/public/oferta.html (адрес /oferta на воркере).
 *   node scripts/build-oferta.ts
 * Берётся только текст после первой линии «---»: служебный блок для нас, цитаты «> …» и пометки [УТОЧНИТЬ …]
 * на страницу не попадают. Разметка простая: # и ## заголовки, абзацы, списки «- », **жирный**.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const md = readFileSync(join(ROOT, 'docs/oferta.md'), 'utf8');
const body = md.split('\n---\n').slice(1).join('\n---\n');

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

const html: string[] = [];
for (const block of body.split(/\n\s*\n/)) {
  const lines = block
    .split('\n')
    .filter((l) => !l.startsWith('>'))
    // пометки для заказчика: целая строка или хвост пункта
    .map((l) => l.replace(/\s*\*\*\[УТОЧНИТЬ[^\]]*\]\*\*/g, '').trimEnd())
    .filter(Boolean);
  if (!lines.length) continue;
  const [first] = lines;
  if (first.startsWith('# ')) html.push(`<h1>${inline(first.slice(2))}</h1>`);
  else if (first.startsWith('## ')) html.push(`<h2>${inline(first.slice(3))}</h2>`);
  else {
    const text = lines.filter((l) => !l.startsWith('- '));
    const items = lines.filter((l) => l.startsWith('- '));
    if (text.length) html.push(`<p>${inline(text.join(' '))}</p>`);
    if (items.length) html.push(`<ul>${items.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`);
  }
}

const page = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Публичная оферта — RaXi Store</title>
<meta name="robots" content="noindex">
<style>
  :root { --bg: #fff; --text: #111; --hint: #6b6b70; --sep: #e5e5ea; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --text: #f2f2f7; --hint: #98989f; --sep: #2c2c2e; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.3px; }
  h2 { font-size: 18px; margin: 28px 0 8px; padding-top: 16px; border-top: 1px solid var(--sep); }
  p, ul { margin: 8px 0; }
  ul { padding-left: 22px; }
  h1 + p { color: var(--hint); font-size: 14px; }
</style>
</head>
<body>
<main>
${html.join('\n')}
</main>
</body>
</html>
`;
writeFileSync(join(ROOT, 'app/public/oferta.html'), page);
console.log(`app/public/oferta.html: ${html.length} блоков`);
