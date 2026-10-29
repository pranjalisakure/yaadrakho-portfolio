CREATE TABLE IF NOT EXISTS order_recovery_attempts (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, local_order_id integer NOT NULL,
 actor_user_id integer, source text NOT NULL, status text NOT NULL DEFAULT 'started',
 provider_order_id text, message text NOT NULL DEFAULT '', created_at integer NOT NULL, finished_at integer
);
CREATE INDEX IF NOT EXISTS order_recovery_local_idx ON order_recovery_attempts(local_order_id, created_at);
