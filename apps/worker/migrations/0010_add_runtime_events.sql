CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id TEXT,
  session_id TEXT,
  request_path TEXT,
  method TEXT,
  channel_id TEXT,
  token_id TEXT,
  model TEXT,
  context_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_created_at
  ON runtime_events (created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_events_code_created_at
  ON runtime_events (code, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_events_request_id
  ON runtime_events (request_id);

CREATE INDEX IF NOT EXISTS idx_runtime_events_session_id
  ON runtime_events (session_id);

CREATE INDEX IF NOT EXISTS idx_runtime_events_level_created_at
  ON runtime_events (level, created_at);

