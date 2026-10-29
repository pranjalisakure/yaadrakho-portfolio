ALTER TABLE `invoices` ADD COLUMN `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_idempotency_unique`
  ON `invoices` (`owner_user_id`,`idempotency_key`)
  WHERE `idempotency_key` IS NOT NULL;
