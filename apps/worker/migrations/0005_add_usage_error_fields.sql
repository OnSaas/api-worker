ALTER TABLE usage_logs ADD COLUMN upstream_status INTEGER;
ALTER TABLE usage_logs ADD COLUMN error_code TEXT;
ALTER TABLE usage_logs ADD COLUMN error_message TEXT;
