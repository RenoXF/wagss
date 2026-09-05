-- 009_log_retention: retention 7 days for logs
CREATE OR REPLACE FUNCTION cleanup_logs() RETURNS void AS $$
BEGIN
  DELETE FROM error_log WHERE created_at < now() - interval '7 days';
  DELETE FROM send_log WHERE created_at < now() - interval '7 days';
END;
$$ LANGUAGE plpgsql;
