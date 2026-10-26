import type { Listing } from '../../../shared/types';
import { formatPrice, formatStorage } from '../../../shared/parser';
import { inTelegram, openExternal } from '../tg';
import { IconClose } from '../icons';
import { Emoji } from './Emoji';

export type CheckoutStage = 'form' | 'sent' | 'paid';

interface Props {
  l: Listing;
  stage: CheckoutStage | null;
  busy: boolean;
  onClose: () => void;
  onPay: () => void;
  onOpenBot: () => void;
}

/**
 * Оформление покупки в два этапа, как у «Айден Маркет»: сейчас — услуги площадки (комиссия, уже внутри цены),
 * остаток — продавцу напрямую. В Telegram действие — на главной кнопке, в браузере — кнопка внизу листа.
 */
export function Checkout({ l, stage, busy, onClose, onPay, onOpenBot }: Props) {
  const open = stage !== null;
  const total = l.price_rub ?? 0;
  const fee = l.fee_rub ?? 0;
  const title = `iPhone ${l.family ?? l.model_raw ?? ''}${l.storage_gb ? ' ' + formatStorage(l.storage_gb) : ''}`;

  return (
    <div class={`sheet-root ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div class="sheet-backdrop" onClick={busy ? undefined : onClose} />
      <div class="sheet glass-strong" role="dialog" aria-label="Оформление покупки">
        <div class="sheet-grab">
          <div class="sheet-grabber" />
        </div>
        <div class="sheet-head">
          <h2>{stage === 'form' || !stage ? 'Оформление покупки' : stage === 'paid' ? 'Оплачено' : 'Счёт в чате с ботом'}</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Закрыть" disabled={busy}>
            <IconClose />
          </button>
        </div>

        <div class="sheet-scroll">
          {stage === 'paid' || stage === 'sent' ? (
            <div class="co-done">
              <Emoji name={stage === 'paid' ? 'party' : 'chat'} size={64} />
              {stage === 'paid' ? (
                <p>
                  Контакт продавца — в чате с ботом. Телефон <b>{title}</b> забронирован за вами на 24 часа.
                </p>
              ) : (
                <p>
                  Откройте чат с ботом и нажмите «Оплатить». Сразу после оплаты бот пришлёт контакт продавца, а телефон забронируем за вами на 24 часа.
                </p>
              )}
            </div>
          ) : (
            <>
              <p class="co-lead">
                Вы оформляете покупку <b>{title}</b> (лот{'\u00a0'}№{l.id}). Оплата проходит в два этапа, которые вместе составляют итоговую цену{' '}
                <b class="nowrap">{formatPrice(total)}</b>.
              </p>
              <ol class="co-steps">
                <li>
                  <div class="co-step-head">
                    <span class="co-num">1</span>
                    <span class="grow">Услуги площадки</span>
                    <b>{formatPrice(fee)}</b>
                  </div>
                  <p>Уже включены в цену. Оплачиваете сейчас — картой или через СБП, платёж принимает ЮKassa. После оплаты бот пришлёт контакт продавца, а телефон забронируем за вами на 24{'\u00a0'}часа.</p>
                </li>
                <li>
                  <div class="co-step-head">
                    <span class="co-num">2</span>
                    <span class="grow">Продавцу напрямую</span>
                    <b>{formatPrice(total - fee)}</b>
                  </div>
                  <p>Остаток оплачиваете продавцу при встрече — как договоритесь.</p>
                </li>
              </ol>
              <p class="co-legal">
                Переходя к оплате, вы соглашаетесь с{' '}
                <a href="/oferta" onClick={(e) => (e.preventDefault(), openExternal(`${location.origin}/oferta`))}>
                  условиями оферты
                </a>
                .
              </p>
            </>
          )}
        </div>

        {!inTelegram && (
          <div class="sheet-foot">
            {stage === 'form' ? (
              <button class="btn-primary grow" disabled={busy} onClick={onPay}>
                {busy ? 'Оформляем…' : `Оплатить ${formatPrice(fee)}`}
              </button>
            ) : (
              <button class="btn-primary grow" onClick={onOpenBot}>
                Открыть чат с ботом
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
