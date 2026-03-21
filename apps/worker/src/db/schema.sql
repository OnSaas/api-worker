CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,
  group_name TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  rate_limit INTEGER DEFAULT 0,
  models_json TEXT,
  metadata_json TEXT,
  test_time INTEGER,
  response_time_ms INTEGER,
  system_token TEXT,
  system_userid TEXT,
  checkin_enabled INTEGER NOT NULL DEFAULT 0,
  checkin_url TEXT,
  last_checkin_date TEXT,
  last_checkin_status TEXT,
  last_checkin_message TEXT,
  last_checkin_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_call_tokens (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL,
  models_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channel_call_tokens_channel_id
  ON channel_call_tokens (channel_id, created_at);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  token_plain TEXT,
  quota_total INTEGER,
  quota_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  allowed_channels TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_key_hash ON tokens (key_hash);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  token_id TEXT,
  channel_id TEXT,
  model TEXT,
  request_path TEXT,
  total_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost REAL,
  latency_ms INTEGER,
  first_token_latency_ms INTEGER,
  stream INTEGER,
  reasoning_effort TEXT,
  status TEXT,
  upstream_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_channel_id ON usage_logs (channel_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_token_id ON usage_logs (token_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs (model);
CREATE INDEX IF NOT EXISTS idx_usage_logs_status ON usage_logs (status);
CREATE INDEX IF NOT EXISTS idx_usage_logs_upstream_status ON usage_logs (upstream_status);

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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_model_capabilities (
  channel_id TEXT NOT NULL,
  model TEXT NOT NULL,
  last_ok_at INTEGER NOT NULL,
  last_err_at INTEGER,
  last_err_code TEXT,
  last_err_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, model)
);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_model
  ON channel_model_capabilities (model);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_channel
  ON channel_model_capabilities (channel_id);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_channel_ok
  ON channel_model_capabilities (channel_id, last_ok_at);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_model_err
  ON channel_model_capabilities (model, last_err_at);
