CREATE TABLE IF NOT EXISTS lid_pn_mapping (
  lid TEXT PRIMARY KEY,
  pn  TEXT NOT NULL
);

UPDATE contacts SET is_group = true WHERE jid LIKE '%@g.us';