-- رسائل داخلية بين المستخدمين (شبه البريد): رسالة واحدة ولها مستلمين
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  subject    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES messages(id),   -- رد على رسالة
  created_at TEXT    NOT NULL
);
CREATE TABLE message_recipients (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  read_at    TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_msg_rcpt_user ON message_recipients(user_id, deleted, read_at);
CREATE INDEX idx_messages_sender ON messages(sender_id, created_at);
CREATE INDEX idx_messages_parent ON messages(parent_id);
