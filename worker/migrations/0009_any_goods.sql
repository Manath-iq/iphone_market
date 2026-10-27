-- Любые товары, не только iPhone (docs/any-goods.md). category: iphone — шаблон с разбором подписи,
-- other — мастер в боте: название, цена, фото, описание как есть.
ALTER TABLE submissions ADD COLUMN category TEXT NOT NULL DEFAULT 'iphone';
ALTER TABLE submissions ADD COLUMN title TEXT;
-- описание продавца как он его написал (с переносами строк); контакты вычищаются при публикации
ALTER TABLE submissions ADD COLUMN description TEXT;
-- описание другого товара без контактов; название — в model_raw, как у постов с неразобранной моделью
ALTER TABLE listings ADD COLUMN description TEXT;
