import { useEffect, useRef, useState } from 'preact/hooks';
import type { Listing, MediaItem } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { batteryTone, isNew } from '../filters';
import { api } from '../api';
import { haptic, inTelegram, tg, openTgLink, pushBack, copyText } from '../tg';
import { IconCheck, IconChevron, IconClose, IconInfo, IconPaper, IconPlay, IconShare } from '../icons';
import { Emoji } from './Emoji';
import { Img } from './Img';

interface Props {
  id: number;
  preview: Listing | null;
  botUsername: string;
  onClose: () => void;
  onBuy: (l: Listing) => Promise<void>;
  toast: (msg: string) => void;
}

export function Detail({ id, preview, botUsername, onClose, onBuy, toast }: Props) {
  const [l, setL] = useState<Listing | null>(preview);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    api
      .listing(id)
      .then((x) => (setL(x), setLoaded(true)))
      .catch(() => (setMissing(true), setLoaded(true)));
    api.event('card_view', id);
  }, [id]);

  // Главная кнопка Telegram: «Купить — 43 990 ₽»
  useEffect(() => {
    if (!inTelegram || !l || l.status !== 'active') return;
    const mb = tg!.MainButton;
    const click = async () => {
      mb.showProgress(true);
      await onBuy(l);
      mb.hideProgress();
    };
    mb.setParams({
      text: l.price_rub ? `Купить — ${formatPrice(l.price_rub)}` : 'Написать продавцу',
      is_visible: true,
      is_active: true,
      has_shine_effect: true,
    });
    mb.onClick(click);
    return () => {
      mb.offClick(click);
      mb.hide();
    };
  }, [l?.id, l?.price_rub, l?.status]);

  const share = async () => {
    if (!l) return;
    haptic.tap();
    const link = `https://t.me/${botUsername}?start=l_${l.id}`;
    const text = `iPhone ${l.family}${l.storage_gb ? ' ' + formatStorage(l.storage_gb) : ''}${l.price_rub ? ' — ' + formatPrice(l.price_rub) : ''}`;
    if (inTelegram) openTgLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
    else if (await copyText(link)) toast('Ссылка скопирована');
  };

  const media: MediaItem[] =
    l?.media ?? (l?.cover ? [{ id: 0, kind: 'photo', url: l.cover, width: null, height: null, position: 0 }] : []);
  const sold = !!l && l.status !== 'active';
  const hasVideo = media.some((m) => m.kind === 'video');
  // «Полный комплект» уже есть в плитке «Комплект» — в плюсах не повторяем
  const pluses = l ? l.pluses.filter((p) => !(l.full_kit && /^полный комплект$/i.test(p))) : [];

  return (
    <div class="screen detail">
      {!inTelegram && (
        <button class="float-close glass-btn" onClick={onClose} aria-label="Назад">
          <IconClose />
        </button>
      )}

      <Gallery media={media} waiting={!loaded && !media.length} onOpen={(i) => (haptic.tap(), setViewer(i))} />

      {missing && !l ? (
        <div class="empty">
          <Emoji name="shrug" size={80} class="empty-emoji" />
          <div class="empty-title">Этот телефон уже продан</div>
          <div class="empty-text">Загляните в каталог — там есть похожие</div>
          <button class="btn-primary" onClick={onClose}>
            Смотреть другие
          </button>
        </div>
      ) : l ? (
        <div class="detail-body">
          <div class="detail-head">
            <div class="detail-badges">
              {isNew(l) && !sold && (
                <span class="badge-new inline">
                  <Emoji name="sparkles" size={14} />
                  Новое
                </span>
              )}
              {sold && <span class="badge-sold">Продан</span>}
            </div>
            <h1>
              iPhone {l.family ?? l.model_raw}
              {l.storage_gb ? <span class="muted"> {formatStorage(l.storage_gb)}</span> : null}
            </h1>
            <div class="detail-price">
              <span>{l.price_rub ? formatPrice(l.price_rub) : 'Цена по запросу'}</span>
              {l.old_price_rub && <s>{formatPrice(l.old_price_rub)}</s>}
            </div>
          </div>

          <div class="specs">
            <Spec label="Состояние" value={l.condition} />
            <Spec
              label="Аккумулятор"
              value={l.battery_pct !== null ? `${l.battery_pct}%` : null}
              hint={l.battery_cycles ? `${l.battery_cycles} циклов` : undefined}
              tone={batteryTone(l.battery_pct)}
              meter={l.battery_pct}
            />
            <Spec label="SIM" value={l.sim} />
            <Spec label="Память" value={l.storage_gb ? formatStorage(l.storage_gb) : null} />
            {l.ios && <Spec label="iOS" value={l.ios} />}
            <Spec label="Комплект" value={l.kit ?? (l.full_kit ? 'Полный' : null)} />
          </div>

          {pluses.length > 0 && (
            <section class="group">
              <h3>Плюсы</h3>
              <ul class="list">
                {pluses.map((p) => (
                  <li>
                    <span class="li-icon ok">
                      <IconCheck size={14} />
                    </span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {l.nuances.length > 0 && (
            <section class="group">
              <h3>Нюансы</h3>
              <ul class="list nuance">
                {l.nuances.map((p) => (
                  <li>
                    <span class="li-icon note">
                      <IconInfo size={14} />
                    </span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
              <p class="group-foot">Честно показываем всё, что стоит знать до покупки.</p>
            </section>
          )}

          <section class="group links">
            <button class="row" onClick={() => (haptic.tap(), openTgLink(l.post_url))}>
              <span class="row-icon">
                <IconPaper size={18} />
              </span>
              <span class="row-label">Пост в канале</span>
              <span class="row-tail">
                {!hasVideo && 'видео там'}
                <IconChevron size={16} />
              </span>
            </button>
            <button class="row" onClick={share}>
              <span class="row-icon">
                <IconShare size={18} />
              </span>
              <span class="row-label">Поделиться</span>
              <span class="row-tail">
                <IconChevron size={16} />
              </span>
            </button>
          </section>

          {!inTelegram && !sold && (
            <div class="buy-bar glass-strong">
              <button
                class="btn-primary grow big"
                disabled={buying}
                onClick={async () => {
                  setBuying(true);
                  await onBuy(l);
                  setBuying(false);
                }}
              >
                {l.price_rub ? `Купить — ${formatPrice(l.price_rub)}` : 'Написать продавцу'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div class="detail-body">
          <div class="sk-line shimmer" style={{ width: '70%', height: '28px' }} />
          <div class="sk-line shimmer" style={{ width: '40%', height: '32px', marginTop: '12px' }} />
          <div class="specs">
            {[0, 1, 2, 3].map(() => (
              <div class="spec shimmer" style={{ height: '64px' }} />
            ))}
          </div>
        </div>
      )}

      {viewer !== null && <Viewer media={media} start={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function Spec({ label, value, hint, tone, meter }: { label: string; value: string | null; hint?: string; tone?: string; meter?: number | null }) {
  if (!value) return null;
  return (
    <div class="spec">
      <div class="spec-label">{label}</div>
      <div class={`spec-value ${tone ? 'tone-' + tone : ''}`}>{value}</div>
      {meter != null && (
        <div class={`meter tone-${tone}`}>
          <i style={{ width: `${meter}%` }} />
        </div>
      )}
      {hint && <div class="spec-hint">{hint}</div>}
    </div>
  );
}

function Gallery({ media, waiting, onOpen }: { media: MediaItem[]; waiting: boolean; onOpen: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== idx) (setIdx(i), haptic.select());
  };
  const go = (i: number) => ref.current?.scrollTo({ left: i * ref.current.clientWidth, behavior: 'smooth' });

  if (!media.length)
    return waiting ? (
      <div class="gallery shimmer" />
    ) : (
      <div class="gallery gallery-empty">
        <Emoji name="phone" size={72} />
        <span>Фото в посте канала</span>
      </div>
    );
  return (
    <div class="gallery">
      <div class="gallery-track" ref={ref} onScroll={onScroll}>
        {media.map((m, i) => (
          <div class="slide" key={m.id} onClick={() => onOpen(i)}>
            {m.kind === 'video' ? (
              <>
                {/* #t=0.1 — чтобы iOS показал первый кадр вместо чёрного прямоугольника */}
                <video src={`${m.url}#t=0.1`} muted playsInline preload="metadata" />
                <span class="play glass-btn">
                  <IconPlay size={24} />
                </span>
              </>
            ) : (
              <Img src={m.url} eager={i < 2} />
            )}
          </div>
        ))}
      </div>
      {media.length > 1 && (
        <div class="dots glass">
          {media.map((m, i) => (
            <button class={`${i === idx ? 'on' : ''} ${m.kind === 'video' ? 'vid' : ''}`} onClick={() => go(i)} aria-label={`Фото ${i + 1}`} />
          ))}
        </div>
      )}
      <div class="counter glass">
        {idx + 1} / {media.length}
      </div>
    </div>
  );
}

function Viewer({ media, start, onClose }: { media: MediaItem[]; start: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(start);
  const [drag, setDrag] = useState(0);
  const touch = useRef<{ x: number; y: number; vertical: boolean | null } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = start * el.clientWidth;
    // «Назад» в Telegram и Esc сначала закрывают просмотр, а не всю карточку
    return pushBack(onClose);
  }, []);

  // видео на соседних слайдах не должно играть в фоне
  useEffect(() => {
    ref.current?.querySelectorAll('video').forEach((v, i) => {
      const slide = v.closest('.viewer-slide');
      const pos = slide ? [...ref.current!.children].indexOf(slide) : i;
      if (pos !== idx) v.pause();
    });
  }, [idx]);

  // смахивание вниз закрывает просмотр
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, vertical: null };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (s.vertical === null && Math.abs(dx) + Math.abs(dy) > 8) s.vertical = Math.abs(dy) > Math.abs(dx);
    if (s.vertical) setDrag(Math.max(0, dy));
  };
  const onTouchEnd = () => {
    if (drag > 110) {
      haptic.tap();
      onClose();
    } else setDrag(0);
    touch.current = null;
  };

  return (
    <div
      class={`viewer ${drag ? 'dragging' : ''}`}
      role="dialog"
      aria-label="Просмотр фото"
      style={{ '--drag': `${drag}px`, '--fade': String(Math.max(0.25, 1 - drag / 400)) }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div class="viewer-bg" />
      <div class="viewer-track" ref={ref} onScroll={(e) => setIdx(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}>
        {media.map((m, i) => (
          <div class="viewer-slide" key={m.id} onClick={m.kind === 'photo' ? onClose : undefined}>
            {m.kind === 'video' ? <video src={m.url} controls playsInline autoPlay={i === start} /> : <img src={m.url} alt="" draggable={false} />}
          </div>
        ))}
      </div>
      <div class="viewer-top">
        <span class="viewer-count glass-btn dark">
          {idx + 1} из {media.length}
        </span>
        <button class="icon-btn glass-btn dark" onClick={onClose} aria-label="Закрыть">
          <IconClose />
        </button>
      </div>
    </div>
  );
}
