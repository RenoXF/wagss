-- 010_edit_columns: store original message on edit (overwrite only, keep first original)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS original_text TEXT,
  ADD COLUMN IF NOT EXISTS original_message JSONB;
