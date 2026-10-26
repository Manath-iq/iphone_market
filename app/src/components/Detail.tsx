import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Listing, MediaItem } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { batteryTone, isNew } from '../filters';
import { api } from '../api';
import { haptic, inTelegram, tg, openTgLink, openInvoice, pushBack, copyText, requestWriteAccess } from '../tg';
import { IconCheck, IconChevron, IconClose, IconInfo, IconLock, IconPaper, IconPlay, IconQuestion, IconShare } from '../icons';
import { Emoji } from './Emoji';
import { Img } from './Img';
import { Checkout, type CheckoutStage } from './Checkout';

/** Вопросы по лоту — менеджеру площадки; продавца покупатель до оплаты не видит */
const MANAGER = 'Raxi_apple';

interface Props {
  id: number;
  preview: Listing | null;
  botUsername: string;
  onClose: () => void;
  /** после оплаты — обновить каталог, чтобы у карточки появилась бронь */
  onReserved: () => void;
  toast: (msg: string) => void;
}

export function Detail({ id, preview, botUsername, onClose, onReserved, toast }: Props) {
  const [l, setL] = useState<Listing | null>(preview);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [co, setCo] = useState<CheckoutStage | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api
      .listing(id)
      .then((x) => (setL(x), setLoaded(true)))
      .catch(() => (setMissing(true), setLoaded(true)));

  useEffect(() => {
    reload();
    api.event('card_view', id);
  }, [id]);

  // «Назад» сначала закрывает лист оформления
  useEffect(() => (co ? pushBack(() => setCo(null)) : undefined), [co !== null]);

  const openBot = () => (haptic.tap(), openTgLink(`https://t.me/${botUsername}`));

  const pay = async () => {
    if (!l || busy) return;
    if (!inTelegram) return toast('Оплата работает в Telegram — откройте каталог через бота');
    haptic.medium();
    setBusy(true);
    try {
      // контакт продавца бот пришлёт в чат — без разрешения на сообщения он не дойдёт
      await requestWriteAccess();
      const r = await api.checkout(l.id);
      if (r.mode === 'invoice') {
        const status = await openInvoice(r.url);
        if (status === 'paid') (haptic.success(), setCo('paid'), reload(), onReserved());
        else if (status === 'failed') toast('Оплата не прошла. Попробуйте ещё раз');
      } else {
        haptic.success();
        setCo('sent');
      }
    } catch (e) {
      toast((e as Error).message.startsWith('HTTP') ? 'Не получилось оформить. Попробуйте ещё раз' : (e as Error).message);
      reload();
    } finally {
      setBusy(false);
    }
  };

  /** что сейчас делает главная кнопка: купить, оплатить, открыть бота или ничего (бронь) */
  const action = (() => {
    if (!l || l.status !== 'active' || !l.price_rub) return null;
    if (l.reserved_by_me) return { text: 'Контакт продавца — в чате с ботом', run: openBot, active: true };
    if (co === 'form') return { text: `Оплатить ${formatPrice(l.fee_rub ?? 0)}`, run: pay, active: true };
    if (co) return { text: 'Открыть чат с ботом', run: openBot, active: true };
    if (l.reserved) return { text: 'Забронирован', run: () => {}, active: false };
    return { text: `Купить — ${formatPrice(l.price_rub)}`, run: () => (haptic.medium(), setCo('form')), active: true };
  })();

  // Главная кнопка Telegram
  useEffect(() => {
    if (!inTelegram || !action) return;
    const mb = tg!.MainButton;
    mb.setParams({ text: action.text, is_visible: true, is_active: action.active, has_shine_effect: action.active && !co });
    if (busy) mb.showProgress(true);
    else mb.hideProgress();
    mb.onClick(action.run);
    return () => mb.offClick(action.run);
  }, [action?.text, action?.active, busy]);
  // спрятать кнопку, только когда карточка закрывается или кнопка больше не нужна
  useEffect(() => (inTelegram && action ? () => tg!.MainButton.hide() : undefined), [!!action]);

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
              {!sold && l.reserved && (
                <span class="badge-sold">
                  <IconLock size={13} />
                  {l.reserved_by_me ? 'Забронирован за вами' : 'Забронирован'}
                </span>
              )}
              <span class="lot-no">Лот №{l.id}</span>
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
            <button class="row" onClick={() => (haptic.tap(), openTgLink(`https://t.me/${MANAGER}`))}>
              <span class="row-icon">
                <IconQuestion size={18} />
              </span>
              <span class="row-label">Вопрос по лоту</span>
              <span class="row-tail">
                @{MANAGER}
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

          {!inTelegram && action && !co && (
            <div class="buy-bar glass-strong">
              <button class="btn-primary grow big" disabled={!action.active} onClick={action.run}>
                {action.text}
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

      {/* лист — в body: у .overlay есть transform, и position: fixed внутри неё не прижмётся к низу экрана */}
      {l && (
        <Portal>
          <Checkout l={l} stage={co} busy={busy} onClose={() => setCo(null)} onPay={pay} onOpenBot={openBot} />
        </Portal>
      )}
    </div>
  );
}

/** Отрисовать содержимое прямо в body — без preact/compat (лишние ~2,5 КБ) */
function Portal({ children }: { children: ComponentChildren }) {
  const host = useRef<HTMLDivElement>();
  if (!host.current) host.current = document.createElement('div');
  useEffect(() => {
    const el = host.current!;
    document.body.appendChild(el);
    return () => (render(null, el), el.remove());
  }, []);
  useEffect(() => render(children, host.current!));
  return null;
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
