ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type TEXT,
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS device TEXT,
  ADD COLUMN IF NOT EXISTS forwarded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quoted_message_id TEXT,
  ADD COLUMN IF NOT EXISTS media_type TEXT,
  ADD COLUMN IF NOT EXISTS media_path TEXT,
  ADD COLUMN IF NOT EXISTS media_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS media_size BIGINT,
  ADD COLUMN IF NOT EXISTS media_duration INT,
  ADD COLUMN IF NOT EXISTS media_width INT,
  ADD COLUMN IF NOT EXISTS media_height INT,
  ADD COLUMN IF NOT EXISTS view_once BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS notify TEXT,
  ADD COLUMN IF NOT EXISTS verified_name TEXT,
  ADD COLUMN IF NOT EXISTS img_url TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS is_business BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_enterprise BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS in_phone_book BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS known BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS about TEXT,
  ADD COLUMN IF NOT EXISTS push_name TEXT,
  ADD COLUMN IF NOT EXISTS formatted_name TEXT;

CREATE TABLE IF NOT EXISTS message_reactions (
  id            BIGSERIAL PRIMARY KEY,
  chat_jid      TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  from_jid      TEXT NOT NULL,
  reaction_text TEXT NOT NULL,
  ts            BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_jid, message_id, from_jid, reaction_text)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions (chat_jid, message_id);

CREATE TABLE IF NOT EXISTS message_status (
  id         BIGSERIAL PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  message_id TEXT NOT NULL,
  to_jid     TEXT,
  status     TEXT NOT NULL,
  ts         BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_jid, message_id, to_jid, status)
);
CREATE INDEX IF NOT EXISTS idx_msgstatus_msg ON message_status (chat_jid, message_id);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  group_id              TEXT PRIMARY KEY,
  subject               TEXT,
  creation              BIGINT,
  owner                 TEXT,
  description           TEXT,
  description_id        TEXT,
  is_restricted         BOOLEAN NOT NULL DEFAULT false,
  announce              BOOLEAN NOT NULL DEFAULT false,
  ephemeral_duration    INT,
  is_community          BOOLEAN NOT NULL DEFAULT false,
  is_parent_group       BOOLEAN NOT NULL DEFAULT false,
  parent_group_id       TEXT,
  participant_count     INT NOT NULL DEFAULT 0,
  last_updated          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_participants (
  group_id       TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  admin_level    TEXT,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_gp_participant ON group_participants (participant_id);