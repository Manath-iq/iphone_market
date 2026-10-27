import { describe, expect, it } from 'vitest';
import { toListing, type ListingRow } from '../src/db';
import { ownerPrices } from '../src/ingest';

const row: ListingRow = {
  id: 7, source_channel: 'apple_raxi', channel_msg_id: 100, media_group_id: null, category: 'iphone',
  model_raw: 'iPhone 15 Pro', family: '15 Pro', storage_gb: 256, condition: 'Идеал', sim: 'sim+esim',
  has_physical_sim: 1, battery_pct: 91, battery_cycles: 300, ios: '18.1', pluses: '[]', nuances: '[]', kit: null,
  full_kit: 0, price_rub: 80000, status: 'active', parse_ok: 1, confirmed: 1, raw_text: 'текст продавца @seller_nick',
  post_url: 'https://t.me/apple_raxi/100', created_at: 1, updated_at: 1, sold_at: null,
  seller_id: 123456789, seller_price_rub: 79000, fee_rub: 1000, fee_in_post: 0, reserved_until: null, reserved_by: 42, reserve_paid: 1, reserve_notified: 0, description: null,
};

describe('toListing', () => {
  it('не отдаёт в API продавца и его данные', () => {
    const json = JSON.stringify(toListing(row));
    expect(json).not.toMatch(/seller/i);
    expect(json).not.toContain('123456789');
    expect(json).not.toContain('seller_nick');
    expect(json).not.toContain('reserved_by');
  });
});

describe('ownerPrices', () => {
  it('комиссия сверху цены поста', () => {
    expect(ownerPrices(43990, 1000, false)).toEqual({ price: 44990, seller: 43990 });
  });
  it('комиссия уже внутри цены поста', () => {
    expect(ownerPrices(43990, 1000, true)).toEqual({ price: 43990, seller: 42990 });
  });
  it('без цены', () => {
    expect(ownerPrices(null, 1000, false)).toEqual({ price: null, seller: null });
  });
});
