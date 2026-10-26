-- v2, этап 3: заявки продавцов. Карточка в listings появляется только после публикации в канал.
-- status: draft (собираем альбом и подпись) → pending (на проверке) → published | rejected | cancelled
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  -- media_group_id альбома или m<message_id> для одиночного фото
  group_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  raw_text TEXT,
  -- результат разбора подписи (ParsedPost), JSON
  parsed TEXT,
  seller_price_rub INTEGER,
  preview_sent INTEGER NOT NULL DEFAULT 0,
  -- время последней части альбома, мс: превью шлём, когда части перестали приходить
  last_part_at INTEGER NOT NULL,
  decided_by INTEGER,
  reject_reason TEXT,
  listing_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (seller_id, group_key)
);
CREATE INDEX idx_submissions_seller ON submissions (seller_id, status);
CREATE INDEX idx_submissions_status ON submissions (status);

CREATE TABLE submission_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions (id) ON DELETE CASCADE,
  msg_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  UNIQUE (submission_id, msg_id)
);
