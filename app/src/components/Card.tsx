import type { Listing } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { batteryTone, isNew } from '../filters';
import { Emoji } from './Emoji';

export function Card({ l, onOpen, index }: { l: Listing; onOpen: (l: Listing) => void; index: number }) {
  return (
    <button class="card" style={{ '--i': Math.min(index, 8) }} onClick={() => onOpen(l)}>
      <div class="card-photo">
        {l.cover ? (
          <img
            src={l.cover}
            alt=""
            loading={index < 4 ? 'eager' : 'lazy'}
            decoding="async"
            onLoad={(e) => (e.currentTarget as HTMLImageElement).classList.add('loaded')}
          />
        ) : (
          <div class="card-photo-empty">
            <Emoji name="phone" size={48} />
          </div>
        )}
        {isNew(l) && (
          <span class="badge-new">
            <Emoji name="fire" size={15} />
            Новое
          </span>
        )}
      </div>
      <div class="card-body">
        <div class="card-title">
          iPhone {l.family ?? l.model_raw}
          {l.storage_gb ? <span class="card-storage"> {formatStorage(l.storage_gb)}</span> : null}
        </div>
        <div class="card-price">
          {l.price_rub ? formatPrice(l.price_rub) : 'Цена по запросу'}
          {l.old_price_rub && <s>{formatPrice(l.old_price_rub)}</s>}
        </div>
        <div class="card-badges">
          {l.battery_pct !== null && <span class={`pill bat-${batteryTone(l.battery_pct)}`}>АКБ {l.battery_pct}%</span>}
          {l.condition && <span class="pill">{l.condition}</span>}
        </div>
      </div>
    </button>
  );
}

export function CardSkeleton() {
  return (
    <div class="card skeleton" aria-hidden="true">
      <div class="card-photo shimmer" />
      <div class="card-body">
        <div class="sk-line shimmer" style={{ width: '80%' }} />
        <div class="sk-line shimmer sk-price" style={{ width: '55%' }} />
        <div class="sk-line shimmer" style={{ width: '65%' }} />
      </div>
    </div>
  );
}
