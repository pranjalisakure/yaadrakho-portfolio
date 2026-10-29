ALTER TABLE payment_transactions ADD COLUMN receipt_number text;
--> statement-breakpoint
ALTER TABLE payment_transactions ADD COLUMN receipt_token text;
--> statement-breakpoint
ALTER TABLE payment_transactions ADD COLUMN balance_after integer;
--> statement-breakpoint
UPDATE payment_transactions
SET receipt_number = 'YR-R-' || strftime('%Y', received_at / 1000, 'unixepoch') || '-' || printf('%06d', id),
    receipt_token = lower(hex(randomblob(16))),
    balance_after = max(0, (
      SELECT pd.amount_due - COALESCE(SUM(previous.amount), 0)
      FROM payment_dues pd
      LEFT JOIN payment_transactions previous
        ON previous.due_id = payment_transactions.due_id
       AND previous.owner_user_id = payment_transactions.owner_user_id
       AND (previous.received_at < payment_transactions.received_at
         OR (previous.received_at = payment_transactions.received_at AND previous.id <= payment_transactions.id))
      WHERE pd.id = payment_transactions.due_id
        AND pd.owner_user_id = payment_transactions.owner_user_id
    ))
WHERE receipt_number IS NULL OR receipt_token IS NULL OR balance_after IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_receipt_number_unique
  ON payment_transactions(receipt_number) WHERE receipt_number IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_receipt_token_unique
  ON payment_transactions(receipt_token) WHERE receipt_token IS NOT NULL;
