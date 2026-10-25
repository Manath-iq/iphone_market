-- метка «файл уже скачивается», чтобы параллельные апдейты альбома не качали одно и то же
ALTER TABLE media ADD COLUMN claimed_at INTEGER;
