CREATE TABLE IF NOT EXISTS razorpay_captures (
 payment_id text PRIMARY KEY NOT NULL, razorpay_order_id text NOT NULL,
 owner_user_id integer NOT NULL, invoice_id integer NOT NULL, due_id integer NOT NULL,
 amount integer NOT NULL, currency text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','needs_review')),
 error_message text NOT NULL DEFAULT '', created_at integer NOT NULL, updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS razorpay_captures_review_idx ON razorpay_captures (status, owner_user_id);
