CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  iss          TEXT NOT NULL,
  sub          TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL CHECK (role IN ('admin','member')),
  created_at   TEXT NOT NULL,
  last_login   TEXT NOT NULL,
  UNIQUE (iss, sub)
);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE login_attempts (
  id_hash    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  return_to  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX login_attempts_expiry ON login_attempts(expires_at);
