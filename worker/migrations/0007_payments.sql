-- v2, этап 6: оплата комиссии площадки и бронь
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  buyer_username TEXT,
  buyer_name TEXT,
  -- комиссия площадки, ₽
  amount_rub INTEGER NOT NULL,
  -- test — тестовый режим без денег, yookassa — настоящая оплата через Telegram Payments
  mode TEXT NOT NULL,
  -- pending → paid
  status TEXT NOT NULL DEFAULT 'pending',
  -- telegram_payment_charge_id (для теста test:<id>); уникальность защищает от повторной выдачи контакта
  charge_id TEXT UNIQUE,
  provider_charge_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX idx_payments_listing ON payments (listing_id, status);
CREATE INDEX idx_payments_paid ON payments (status, paid_at);

-- бронь после оплаты (reserved_until/reserved_by уже есть): 1 — оплачена, а не короткое удержание на время оплаты
ALTER TABLE listings ADD COLUMN reserve_paid INTEGER NOT NULL DEFAULT 0;
-- 1 — продавцу и сотрудникам уже сообщили, что бронь истекла
ALTER TABLE listings ADD COLUMN reserve_notified INTEGER NOT NULL DEFAULT 0;

-- Посты владельца: цена в канале комиссию пока не учитывает (решение 26.10.2026), поэтому в приложении
-- комиссия добавляется сверху. История цен сдвигается так же, чтобы «старая цена» сравнивалась честно.
UPDATE price_history SET price_rub = price_rub + COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'fee_rub'), 1000)
WHERE listing_id IN (SELECT id FROM listings WHERE seller_id IS NULL AND fee_rub IS NULL AND price_rub IS NOT NULL);
UPDATE listings SET
  fee_rub = COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'fee_rub'), 1000),
  seller_price_rub = price_rub,
  price_rub = price_rub + COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'fee_rub'), 1000),
  fee_in_post = 0
WHERE seller_id IS NULL AND fee_rub IS NULL AND price_rub IS NOT NULL;
