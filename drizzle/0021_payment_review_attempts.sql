CREATE TABLE IF NOT EXISTS payment_review_attempts (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, payment_id text NOT NULL, actor_user_id integer NOT NULL,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','applied','review_required','failed')),
 error_message text NOT NULL DEFAULT '', created_at integer NOT NULL, finished_at integer
);
CREATE INDEX IF NOT EXISTS payment_review_attempts_payment_idx ON payment_review_attempts (payment_id, created_at);
