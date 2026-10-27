import { describe, expect, it } from 'vitest';
import { buildCaption, CAPTION_LIMIT, descriptionOverflow, SELLER_TEMPLATE, stripContacts, stripContactsMultiline } from './caption';
import { parsePost } from './parser';

describe('stripContacts', () => {
  it('убирает ники, ссылки и телефоны', () => {
    expect(stripContacts('Пишите @seller_nick или t.me/seller_nick')).toBe('Пишите или');
    expect(stripContacts('Звоните +7 (999) 123-45-67, отвечу')).toBe('Звоните, отвечу');
    expect(stripContacts('тел 89991234567')).toBe('тел');
    expect(stripContacts('подробнее https://example.com/x?y=1')).toBe('подробнее');
  });

  it('не трогает обычные характеристики', () => {
    expect(stripContacts('Акб 88% (300 ц), iOS 18.4')).toBe('Акб 88% (300 ц), iOS 18.4');
    expect(stripContacts('Комплект: телефон, блок, провод')).toBe('Комплект: телефон, блок, провод');
    expect(stripContacts('Экран 6.1 без царапин')).toBe('Экран 6.1 без царапин');
  });
});

describe('buildCaption', () => {
  const seller = parsePost(`${SELLER_TEMPLATE}\n✅ Пишите в лс @seller_nick, +7 999 123 45 67`);

  it('шаблон продавца разбирается полностью', () => {
    expect(seller).toMatchObject({ family: '15 Pro', storage_gb: 256, price_rub: 79000, battery_pct: 91, parse_ok: true });
  });

  it('пост с номером лота: цена с комиссией, хэштег, ссылки, без контактов продавца', () => {
    const html = buildCaption(seller, { price: 80000, lot: 12, buyUrl: 'https://t.me/bot?startapp=l_12' });
    expect(html).toContain('ЛОТ №12');
    expect(html).toContain('#АКТУАЛЬНО_RaXi');
    expect(html).toContain('<a href="https://t.me/bot?startapp=l_12">Купить лот №12</a>');
    expect(html).toContain('@Raxi_apple');
    expect(html).not.toContain('seller_nick');
    expect(html).not.toContain('123 45 67');
  });

  it('подпись разбирается обратно парсером канала', () => {
    const back = parsePost(buildCaption(seller, { price: 80000, lot: 12 }).replace(/<[^>]+>/g, ''));
    expect(back).toMatchObject({
      family: '15 Pro',
      storage_gb: 256,
      price_rub: 80000,
      battery_pct: 91,
      condition: 'Идеал',
      status: 'active',
      full_kit: true,
      parse_ok: true,
    });
    expect(back.nuances).toEqual(['Следы от чехла по бокам']);
  });

  it('превью до публикации — без номера лота и ссылки', () => {
    const html = buildCaption(seller, { price: 80000 });
    expect(html).not.toContain('ЛОТ №');
    expect(html).toContain('🛒 Купить лот №…');
  });

  it('длинное описание укладывается в лимит Telegram', () => {
    const long = { ...seller, pluses: Array.from({ length: 40 }, (_, i) => `Плюс номер ${i} с длинным описанием`) };
    const html = buildCaption(long, { price: 80000, lot: 1, buyUrl: 'https://t.me/bot?start=l_1' });
    expect(html.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(html).toContain('Следы от чехла');
  });

  it('проданный лот: пометка вместо хэштега, без ссылки «Купить», парсер видит продажу', () => {
    const html = buildCaption(seller, { price: 80000, lot: 12, buyUrl: 'https://t.me/bot?start=l_12', closed: 'sold' });
    expect(html).toContain('❌ Продано ❌');
    expect(html).not.toContain('#АКТУАЛЬНО_RaXi');
    expect(html).not.toContain('Купить лот');
    expect(parsePost(html).status).toBe('sold');
    expect(buildCaption(seller, { price: 80000, lot: 12, closed: 'withdrawn' })).toContain('Снято с продажи');
  });
});

describe('другой товар', () => {
  const description = 'Состояние идеальное\n\n— кейс без царапин\n  — оба наушника работают\nПишите @seller_nick\nПолный комплект, звоните +7 999 123 45 67';
  const f = { family: null, model_raw: 'AirPods Pro 2', storage_gb: null, condition: null, sim: null, battery_pct: null,
    battery_cycles: null, ios: null, pluses: [], nuances: [], category: 'other' as const, description };

  it('описание: переносы и отступы сохраняются, контакты и строки только с контактами пропадают', () => {
    expect(stripContactsMultiline(description)).toBe('Состояние идеальное\n\n— кейс без царапин\n  — оба наушника работают\nПишите\nПолный комплект, звоните');
    expect(stripContactsMultiline('@seller_nick\n\n\n\nТекст\n\n')).toBe('Текст');
    expect(stripContactsMultiline('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('пост: название, лот, описание как есть, цена, без контактов', () => {
    const html = buildCaption(f, { price: 16000, lot: 31, buyUrl: 'https://t.me/bot?start=l_31' });
    expect(html.startsWith('📦 AirPods Pro 2\n#АКТУАЛЬНО_RaXi\nЛОТ №31\n\nСостояние идеальное\n\n— кейс без царапин\n  — оба наушника')).toBe(true);
    expect(html).toContain('💰 16 000 ₽');
    expect(html).toContain('Купить лот №31</a>');
    expect(html).not.toContain('seller_nick');
    expect(html).not.toContain('123 45 67');
  });

  it('проданный: пометка вместо хэштега, без «Купить»', () => {
    const html = buildCaption(f, { price: 16000, lot: 31, closed: 'sold' });
    expect(html).toContain('❌ Продано ❌');
    expect(html).not.toContain('#АКТУАЛЬНО_RaXi');
    expect(html).not.toContain('Купить');
  });

  it('длинное описание: считаем, сколько не влезает; подпись всё равно в лимите', () => {
    const long = 'Очень подробное описание. '.repeat(60);
    const over = descriptionOverflow('AirPods Pro 2', long, 16000);
    expect(over).toBeGreaterThan(0);
    expect(descriptionOverflow('AirPods Pro 2', long.slice(0, long.length - over), 16000)).toBe(0);
    const html = buildCaption({ ...f, description: long }, { price: 16000, lot: 31, buyUrl: 'https://t.me/bot?start=l_31' });
    expect(html.replace(/<[^>]+>/g, '').length).toBeLessThanOrEqual(CAPTION_LIMIT);
    expect(html).toContain('…');
  });
});
