-- #159: a member's settings, one row per member, written on the first save. Without a row the defaults apply (no
-- language chosen, system theme). The language is checked against the shared LOCALES by the API, not here, so adding
-- a language needs no table rebuild.
CREATE TABLE user_settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  locale     TEXT,
  theme      TEXT NOT NULL CHECK (theme IN ('light','dark','system')),
  updated_at TEXT NOT NULL
);
