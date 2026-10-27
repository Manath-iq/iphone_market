import { useEffect, useRef, useState } from 'preact/hooks';
import type { Facets, Listing } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { applyFilters, EMPTY, OTHER, sheetCount, type Filters } from '../filters';
import { haptic } from '../tg';
import { IconClose } from '../icons';

interface Props {
  open: boolean;
  items: Listing[];
  facets: Facets | null;
  filters: Filters;
  onApply: (f: Filters) => void;
  onClose: () => void;
}

const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
const STEP = 1000;

export function FilterSheet({ open, items, facets, filters, onApply, onClose }: Props) {
  const other = filters.family === OTHER;
  const [f, setF] = useState(filters);
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);
  useEffect(() => {
    if (open) (setF(filters), setDrag(0));
  }, [open]);

  // лист тянется за «ручку» и шапку; отпустили ниже порога — закрываем
  const dragHandlers = {
    onTouchStart: (e: TouchEvent) => (startY.current = e.touches[0].clientY),
    onTouchMove: (e: TouchEvent) => startY.current !== null && setDrag(Math.max(0, e.touches[0].clientY - startY.current)),
    onTouchEnd: () => {
      if (drag > 90) onClose();
      else setDrag(0);
      startY.current = null;
    },
  };

  const lo = Math.floor((facets?.price_min ?? 0) / STEP) * STEP;
  const hi = Math.ceil((facets?.price_max ?? 100000) / STEP) * STEP || STEP;
  const pMin = f.priceMin ?? lo;
  const pMax = f.priceMax ?? hi;
  const count = applyFilters(items, f).length;
  const set = (patch: Partial<Filters>) => (haptic.select(), setF((prev) => ({ ...prev, ...patch })));

  return (
    <div class={`sheet-root ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div class="sheet-backdrop" onClick={onClose} />
      <div
        class={`sheet glass-strong ${drag ? 'dragging' : ''}`}
        role="dialog"
        aria-label="Фильтры"
        style={drag ? { '--drag': `${drag}px` } : undefined}
      >
        <div class="sheet-grab" {...dragHandlers}>
          <div class="sheet-grabber" />
        </div>
        <div class="sheet-head" {...dragHandlers}>
          <h2>Фильтры</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Закрыть">
            <IconClose />
          </button>
        </div>

        <div class="sheet-scroll">
          {/* у других товаров (не iPhone) — только цена */}
          {!other && (
            <>
          <section class="fs">
            <h3>Память</h3>
            <div class="chips wrap">
              {(facets?.storages ?? []).map((gb) => (
                <button class={`chip ${f.storages.includes(gb) ? 'on' : ''}`} onClick={() => set({ storages: toggle(f.storages, gb) })}>
                  {formatStorage(gb)}
                </button>
              ))}
            </div>
          </section>

            </>
          )}

          <section class="fs">
            <h3>
              Цена <span class="fs-value">{formatPrice(pMin)} — {formatPrice(pMax)}</span>
            </h3>
            <div class="range" style={{ '--a': (pMin - lo) / (hi - lo || 1), '--b': (pMax - lo) / (hi - lo || 1) }}>
              <div class="range-track" />
              <input
                type="range" min={lo} max={hi} step={STEP} value={pMin} aria-label="Цена от"
                onInput={(e) => {
                  const v = Math.min(+e.currentTarget.value, pMax - STEP);
                  setF((prev) => ({ ...prev, priceMin: v <= lo ? null : v }));
                }}
              />
              <input
                type="range" min={lo} max={hi} step={STEP} value={pMax} aria-label="Цена до"
                onInput={(e) => {
                  const v = Math.max(+e.currentTarget.value, pMin + STEP);
                  setF((prev) => ({ ...prev, priceMax: v >= hi ? null : v }));
                }}
              />
            </div>
          </section>

          {!other && (
            <>
          <section class="fs">
            <h3>АКБ от</h3>
            <div class="segmented">
              {[null, 80, 85, 90, 95].map((b) => (
                <button class={f.batteryMin === b ? 'on' : ''} onClick={() => set({ batteryMin: b })}>
                  {b ? `${b}%` : 'Любая'}
                </button>
              ))}
            </div>
          </section>

          {(facets?.conditions.length ?? 0) > 0 && (
            <section class="fs">
              <h3>Состояние</h3>
              <div class="chips wrap">
                {facets!.conditions.map((c) => (
                  <button class={`chip ${f.conditions.includes(c) ? 'on' : ''}`} onClick={() => set({ conditions: toggle(f.conditions, c) })}>
                    {c}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section class="fs">
            <h3>SIM</h3>
            <div class="segmented">
              {([
                ['any', 'Любая'],
                ['physical', 'Есть SIM'],
                ['esim', 'Только eSIM'],
              ] as const).map(([k, label]) => (
                <button class={f.sim === k ? 'on' : ''} onClick={() => set({ sim: k })}>
                  {label}
                </button>
              ))}
            </div>
          </section>
            </>
          )}
        </div>

        <div class="sheet-foot">
          <button class="btn-ghost" disabled={!sheetCount(f)} onClick={() => set({ ...EMPTY, family: f.family, sort: f.sort })}>
            Сбросить
          </button>
          <button class="btn-primary grow" onClick={() => (haptic.tap(), onApply(f))}>
            {count ? `Показать ${count}` : 'Ничего не найдено'}
          </button>
        </div>
      </div>
    </div>
  );
}
