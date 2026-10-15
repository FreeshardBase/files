-- Cloud connections (#148): one row per cloud account a member connected. Only that member sees and uses it, as the
-- source `conn:<id>`. `refresh_token` is AES-256-GCM ciphertext (server/src/cloud/secretBox.ts) bound to the row's id;
-- access tokens live in memory only. A rotated refresh token replaces it as soon as the provider issues it.
CREATE TABLE connections (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  account_label TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','reauth')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- The member's own list; connecting the same account again updates its row instead of adding one.
CREATE INDEX connections_user ON connections(user_id);
CREATE UNIQUE INDEX connections_account ON connections(user_id, provider, account_id);

-- A consent flow in progress: `state` and the PKCE verifier exist only here, bound to the session that started it,
-- single-use and short-lived. `connection_id` is set when the member signs in again to an existing connection.
CREATE TABLE connect_attempts (
  state         TEXT PRIMARY KEY,
  session_hash  TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
  verifier      TEXT,
  expires_at    TEXT NOT NULL
);
CREATE INDEX connect_attempts_session ON connect_attempts(session_hash);
CREATE INDEX connect_attempts_user ON connect_attempts(user_id);
CREATE INDEX connect_attempts_connection ON connect_attempts(connection_id);
CREATE INDEX connect_attempts_expiry ON connect_attempts(expires_at);
