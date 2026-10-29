CREATE TABLE IF NOT EXISTS email_reset_challenges (
  challenge_hash TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL UNIQUE,
  otp_hash TEXT NOT NULL, password_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0
);
