import type { Listing } from '../../shared/types';

export type Sort = 'new' | 'cheap' | 'expensive' | 'battery';

/** Значение чипа «Другое» в фильтре модели: все товары, кроме iPhone */
export const OTHER = '__other__';

/** Заголовок карточки: у другого товара — название продавца, у iPhone — модель */
export const listingName = (l: Listing) => (l.category === 'other' ? l.model_raw ?? 'Товар' : `iPhone ${l.family ?? l.model_raw}`);

/** Фильтры листа, которые есть только у iPhone: в «Другом» их нет */
export const IPHONE_ONLY: Partial<Filters> = { storages: [], batteryMin: null, conditions: [], sim: 'any' };

export interface Filters {
  family: string | null;
  storages: number[];
  priceMin: number | null;
  priceMax: number | null;
  batteryMin: number | null;
  conditions: string[];
  sim: 'any' | 'physical' | 'esim';
  sort: Sort;
}

export const EMPTY: Filters = {
  family: null,
  storages: [],
  priceMin: null,
  priceMax: null,
  batteryMin: null,
  conditions: [],
  sim: 'any',
  sort: 'new',
};

export const SORT_LABELS: Record<Sort, string> = {
  new: 'Сначала новые',
  cheap: 'Дешевле',
  expensive: 'Дороже',
  battery: 'АКБ выше',
};

/** Сколько фильтров из листа включено — для бейджа на кнопке */
export const sheetCount = (f: Filters) =>
  (f.storages.length ? 1 : 0) +
  (f.priceMin !== null || f.priceMax !== null ? 1 : 0) +
  (f.batteryMin ? 1 : 0) +
  (f.conditions.length ? 1 : 0) +
  (f.sim !== 'any' ? 1 : 0);

export function applyFilters(items: Listing[], f: Filters, ignoreFamily = false): Listing[] {
  const out = items.filter(
    (l) =>
      (ignoreFamily || !f.family || (f.family === OTHER ? l.category === 'other' : l.family === f.family)) &&
      (!f.storages.length || (l.storage_gb !== null && f.storages.includes(l.storage_gb))) &&
      (f.priceMin === null || (l.price_rub ?? 0) >= f.priceMin) &&
      (f.priceMax === null || (l.price_rub ?? 0) <= f.priceMax) &&
      (!f.batteryMin || (l.battery_pct ?? 0) >= f.batteryMin) &&
      (!f.conditions.length || (l.condition !== null && f.conditions.includes(l.condition))) &&
      (f.sim === 'any' || (f.sim === 'physical' ? l.has_physical_sim === true : l.has_physical_sim === false)),
  );
  const by: Record<Sort, (a: Listing, b: Listing) => number> = {
    new: (a, b) => b.created_at - a.created_at,
    cheap: (a, b) => (a.price_rub ?? 0) - (b.price_rub ?? 0),
    expensive: (a, b) => (b.price_rub ?? 0) - (a.price_rub ?? 0),
    battery: (a, b) => (b.battery_pct ?? 0) - (a.battery_pct ?? 0),
  };
  return out.sort(by[f.sort]);
}

export const isNew = (l: Listing) => Date.now() / 1000 - l.created_at < 48 * 3600;

export function batteryTone(pct: number | null): 'good' | 'mid' | 'low' {
  if (pct === null) return 'mid';
  if (pct >= 90) return 'good';
  if (pct >= 85) return 'mid';
  return 'low';
}

export { plural } from '../../shared/parser';

/** Все модели для подписки — даже те, которых сейчас нет */
export const ALL_FAMILIES = [
  '17 Pro Max', '17 Pro', '17 Air', '17', '16 Pro Max', '16 Pro', '16 Plus', '16', '16e',
  '15 Pro Max', '15 Pro', '15 Plus', '15', '14 Pro Max', '14 Pro', '14 Plus', '14',
  '13 Pro Max', '13 Pro', '13', '13 mini', '12 Pro Max', '12 Pro', '12', '12 mini', '11 Pro Max', '11 Pro', '11', 'SE',
];

export const STORAGE_OPTIONS = [64, 128, 256, 512, 1024];
