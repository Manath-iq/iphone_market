-- v2, этап 2: файлы из Telegram больше не копируются в KV, их отдаёт /media/f/<id> по file_id.
-- Ещё не скачанные файлы постов канала переводим на новую схему; уже лежащие в KV (m/...) остаются как есть.
UPDATE media SET storage_key = 'f/' || id WHERE storage_key IS NULL AND source LIKE 'tg:%';
