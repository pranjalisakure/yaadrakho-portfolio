CREATE TABLE IF NOT EXISTS payment_reconciliations (
 payment_id text PRIMARY KEY NOT NULL, refund_id text NOT NULL UNIQUE,
 actor_user_id integer NOT NULL, note text NOT NULL, created_at integer NOT NULL
);
