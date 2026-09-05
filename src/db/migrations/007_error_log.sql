-- 007_error_log: audit + error log for all operations.
-- Used by Fix 0 and Fix 4 (send_log). Keep send_log separate for Baileys raw return.

CREATE TABLE IF NOT EXISTS error_log (
  id         BIGSERIAL PRIMARY KEY,
  component  TEXT        NOT NULL,  -- 'api', 'baileys', 'sse', 'auth', ...
  operation  TEXT        NOT NULL,  -- 'send-text', 'messages.upsert', 'login', ...
  level      TEXT        NOT NULL DEFAULT 'info', -- 'info' | 'warn' | 'error'
  payload    JSONB,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_log_component ON error_log(component);
CREATE INDEX IF NOT EXISTS idx_error_log_created   ON error_log(created_at);

-- Dedicated table for raw Baileys sendMessage return (Fix 4 reference).
CREATE TABLE IF NOT EXISTS send_log (
  id          BIGSERIAL PRIMARY KEY,
  jid         TEXT    NOT NULL,
  raw_return  JSONB,
  attribution JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_send_log_jid ON send_log(jid);
CREATE INDEX IF NOT EXISTS idx_send_log_created ON send_log(created_at);
