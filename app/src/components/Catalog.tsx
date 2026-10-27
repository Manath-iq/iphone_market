import { useEffect, useState } from 'preact/hooks';
import type { Facets, Listing } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { applyFilters, EMPTY, IPHONE_ONLY, OTHER, plural, sheetCount, SORT_LABELS, type Filters, type Sort } from '../filters';
import { haptic } from '../tg';
import { IconChevronDown, IconClose, IconFilter } from '../icons';
import { Card, CardSkeleton } from './Card';
import { Emoji } from './Emoji';

interface Props {
  items: Listing[] | null;
  facets: Facets | null;
  filters: Filters;
  setFilters: (f: Filters) => void;
  storeName: string;
  error: boolean;
  onOpen: (l: Listing) => void;
  onOpenFilters: () => void;
  onSubscribe: (family: string | null) => void;
  onRetry: () => void;
}

/** Активные фильтры из листа — плашками, которые снимаются тапом */
function activeTags(f: Filters): { label: string; clear: Partial<Filters> }[] {
  const tags: { label: string; clear: Partial<Filters> }[] = [];
  f.storages.forEach((gb) => tags.push({ label: formatStorage(gb), clear: { storages: f.storages.filter((x) => x !== gb) } }));
  if (f.priceMin !== null || f.priceMax !== null) {
    const label =
      f.priceMin !== null && f.priceMax !== null
        ? `${formatPrice(f.priceMin)} – ${formatPrice(f.priceMax)}`
        : f.priceMin !== null
          ? `от ${formatPrice(f.priceMin)}`
          : `до ${formatPrice(f.priceMax!)}`;
    tags.push({ label, clear: { priceMin: null, priceMax: null } });
  }
  if (f.batteryMin) tags.push({ label: `АКБ от ${f.batteryMin}%`, clear: { batteryMin: null } });
  f.conditions.forEach((c) => tags.push({ label: c, clear: { conditions: f.conditions.filter((x) => x !== c) } }));
  if (f.sim !== 'any') tags.push({ label: f.sim === 'physical' ? 'Физическая SIM' : 'Только eSIM', clear: { sim: 'any' } });
  return tags;
}

export function Catalog({ items, facets, filters, setFilters, storeName, error, onOpen, onOpenFilters, onSubscribe, onRetry }: Props) {
  const total = items?.length ?? facets?.total ?? 0;
  const shown = items ? applyFilters(items, filters) : null;
  const families = facets?.families ?? [];
  const nSheet = sheetCount(filters);
  const tags = activeTags(filters);

  // карточки «выезжают» только при первой загрузке, а не при каждом возврате на вкладку
  const [enter, setEnter] = useState(true);
  useEffect(() => {
    if (!items) return;
    const t = setTimeout(() => setEnter(false), 900);
    return () => clearTimeout(t);
  }, [!!items]);

  const pickFamily = (family: string | null) => {
    haptic.select();
    setFilters({ ...filters, ...(family === OTHER ? IPHONE_ONLY : {}), family });
  };
  const isOther = filters.family === OTHER;
  // «Нет нужной модели?» и подписка — только про iPhone
  const subFamily = isOther ? null : filters.family;
  // пока в каталоге только iPhone, пишем «телефоны»
  const noun = isOther || (!filters.family && (facets?.other_count ?? 0) > 0) ? (['товар', 'товара', 'товаров'] as const) : (['телефон', 'телефона', 'телефонов'] as const);
  const resetAll = () => {
    haptic.tap();
    setFilters({ ...EMPTY, sort: filters.sort });
  };

  return (
    <div class="screen catalog">
      <header class="topbar glass">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <img src="/logo.jpg" alt="" />
          </div>
          <div class="brand-text">
            <div class="brand-name">{storeName}</div>
            <div class="brand-sub">
              <span class="live-dot" />
              {items || facets ? `В наличии: ${total}` : 'Загружаем…'}
            </div>
          </div>
          <button class={`icon-btn glass-btn ${nSheet ? 'active' : ''}`} onClick={() => (haptic.tap(), onOpenFilters())} aria-label="Фильтры">
            <IconFilter />
            {nSheet > 0 && <span class="icon-badge">{nSheet}</span>}
          </button>
        </div>
        <div class="chips" role="tablist">
          <button role="tab" aria-selected={filters.family === null} class={`chip ${filters.family === null ? 'on' : ''}`} onClick={() => pickFamily(null)}>
            Все
            {total > 0 && <span class="chip-count">{total}</span>}
          </button>
          {families.map((f) => (
            <button
              key={f.family}
              role="tab"
              aria-selected={filters.family === f.family}
              class={`chip ${filters.family === f.family ? 'on' : ''}`}
              onClick={() => pickFamily(f.family)}
            >
              {f.family}
              <span class="chip-count">{f.count}</span>
            </button>
          ))}
          {(facets?.other_count ?? 0) > 0 && (
            <button role="tab" aria-selected={isOther} class={`chip ${isOther ? 'on' : ''}`} onClick={() => pickFamily(OTHER)}>
              📦 Другое
              <span class="chip-count">{facets!.other_count}</span>
            </button>
          )}
        </div>
      </header>

      <div class="toolbar">
        <div class="toolbar-count">
          {shown ? `${shown.length} ${plural(shown.length, noun[0], noun[1], noun[2])}` : ' '}
        </div>
        <label class="sort">
          {SORT_LABELS[filters.sort]}
          <IconChevronDown size={16} />
          <select
            value={filters.sort}
            onChange={(e) => (haptic.select(), setFilters({ ...filters, sort: e.currentTarget.value as Sort }))}
            aria-label="Сортировка"
          >
            {Object.entries(SORT_LABELS).map(([k, v]) => (
              <option value={k}>{v}</option>
            ))}
          </select>
        </label>
      </div>

      {tags.length > 0 && (
        <div class="tags">
          {tags.map((t) => (
            <button class="tag" onClick={() => (haptic.select(), setFilters({ ...filters, ...t.clear }))}>
              {t.label}
              <IconClose size={14} />
            </button>
          ))}
          {tags.length > 1 && (
            <button class="tag ghost" onClick={resetAll}>
              Сбросить всё
            </button>
          )}
        </div>
      )}

      {error && !items ? (
        <div class="empty">
          <Emoji name="retry" size={72} class="empty-emoji" />
          <div class="empty-title">Не удалось загрузить каталог</div>
          <div class="empty-text">Проверьте интернет и попробуйте ещё раз</div>
          <button class="btn-primary" onClick={onRetry}>
            Обновить
          </button>
        </div>
      ) : !shown ? (
        <div class="grid">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : items!.length === 0 ? (
        <div class="empty">
          <Emoji name="party" size={72} class="empty-emoji" />
          <div class="empty-title">Всё раскупили</div>
          <div class="empty-text">Новые товары появляются почти каждый день — подпишитесь, и бот напишет первым</div>
          <button class="btn-primary" onClick={() => onSubscribe(null)}>
            Сообщить о поступлении
          </button>
        </div>
      ) : shown.length === 0 ? (
        <div class="empty">
          <Emoji name="search" size={72} class="empty-emoji" />
          <div class="empty-title">Под фильтры ничего нет</div>
          <div class="empty-text">Сбросьте фильтры или подпишитесь — пришлём, как только появится</div>
          <div class="empty-actions">
            <button class="btn-primary" onClick={() => onSubscribe(subFamily)}>
              {subFamily ? `Ждать iPhone ${subFamily}` : 'Подписаться на модель'}
            </button>
            <button class="btn-secondary" onClick={resetAll}>
              Сбросить фильтры
            </button>
          </div>
        </div>
      ) : (
        <div class={`grid ${enter ? 'enter' : ''}`}>
          {shown.map((l, i) => (
            <Card key={l.id} l={l} index={i} onOpen={onOpen} />
          ))}
        </div>
      )}

      {shown && shown.length > 0 && !isOther && (
        <button class="promo" onClick={() => (haptic.tap(), onSubscribe(subFamily))}>
          <div class="promo-icon">
            <Emoji name="bell" size={30} />
          </div>
          <div class="promo-text">
            <b>Нет нужной модели?</b>
            <span>Сообщу, когда появится</span>
          </div>
        </button>
      )}
    </div>
  );
}
