-- v2, этап 4: карточки заявки у сотрудников — чтобы после решения обновить их у всех
CREATE TABLE mod_messages (
  submission_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (submission_id, chat_id)
);
