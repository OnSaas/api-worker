CREATE TABLE IF NOT EXISTS channel_model_capabilities (
  channel_id TEXT NOT NULL,
  model TEXT NOT NULL,
  last_ok_at INTEGER NOT NULL,
  last_err_at INTEGER,
  last_err_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, model)
);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_model
  ON channel_model_capabilities (model);

CREATE INDEX IF NOT EXISTS idx_channel_model_capabilities_channel
  ON channel_model_capabilities (channel_id);
