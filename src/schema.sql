CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_message_id TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT,
  raw_event TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
