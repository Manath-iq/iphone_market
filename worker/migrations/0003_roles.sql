-- v2, этап 1: роли (модераторы, продавцы), приглашения, настройки и поля площадки в карточке

-- модераторы; владелец сюда не пишется — он всегда из секрета ADMIN_IDS
CREATE TABLE staff (
  tg_user_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'mod',
  username TEXT,
  first_name TEXT,
  added_by INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sellers (
  tg_user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  invited_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- одноразовые ссылки-приглашения: role = seller | mod
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);

-- настройки, которые владелец меняет командами; значения по умолчанию — в src/settings.ts
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- чего бот ждёт от человека следующим сообщением (причину отказа, новую цену, подпись)
CREATE TABLE bot_state (
  tg_user_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id INTEGER,
  created_at INTEGER NOT NULL
);

-- price_rub остаётся итоговой ценой для покупателя; seller_price_rub и fee_rub — её части
ALTER TABLE listings ADD COLUMN seller_id INTEGER;
ALTER TABLE listings ADD COLUMN seller_price_rub INTEGER;
ALTER TABLE listings ADD COLUMN fee_rub INTEGER;
-- 1 — комиссия уже внутри цены поста владельца, 0 — добавлена сверху
ALTER TABLE listings ADD COLUMN fee_in_post INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN reserved_until INTEGER;
ALTER TABLE listings ADD COLUMN reserved_by INTEGER;
CREATE INDEX idx_listings_seller ON listings (seller_id);
