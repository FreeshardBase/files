-- #157: app passwords, the credential of WebDAV clients. `prefix` (the first 8 characters of the password) finds the
-- one row to check, so a sign-in never tries every hash; `hash` is the argon2id hash of the whole password.
CREATE TABLE app_passwords (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefix       TEXT NOT NULL UNIQUE,
  hash         TEXT NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX app_passwords_user ON app_passwords(user_id);

-- #157: WebDAV dead properties (PROPPATCH) of an item in a member's home. The value is the property element as XML.
-- `path` follows moves and the rows go with deletes (PATH_TABLES).
CREATE TABLE dav_props (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path    TEXT NOT NULL,
  ns      TEXT NOT NULL,
  name    TEXT NOT NULL,
  xml     TEXT NOT NULL,
  PRIMARY KEY (user_id, path, ns, name)
);
