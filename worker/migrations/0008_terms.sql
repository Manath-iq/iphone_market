-- когда человек принял условия площадки (оферта и обработка персональных данных); NULL — ещё не принимал
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
