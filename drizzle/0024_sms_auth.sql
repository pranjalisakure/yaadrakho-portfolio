CREATE TABLE IF NOT EXISTS account_phones (
 user_id integer PRIMARY KEY NOT NULL, phone text NOT NULL UNIQUE, verified_at integer NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_challenges (
 token_hash text PRIMARY KEY NOT NULL, user_id integer, phone text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('enroll','login','reset')),
 password_version text NOT NULL DEFAULT '', provider_sid text,
 status text NOT NULL DEFAULT 'sending', attempts integer NOT NULL DEFAULT 0,
 expires_at integer NOT NULL, created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS sms_challenges_phone_idx ON sms_challenges(phone, created_at);
