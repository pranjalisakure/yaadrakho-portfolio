ALTER TABLE `invoices` ADD COLUMN `discount_amount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `invoices` ADD COLUMN `public_token` text;
--> statement-breakpoint
ALTER TABLE `invoice_items` ADD COLUMN `line_discount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_deliveries` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `invoice_id` integer NOT NULL,
  `channel` text DEFAULT 'whatsapp' NOT NULL CHECK(`channel` IN ('whatsapp')),
  `destination` text NOT NULL,
  `message` text NOT NULL,
  `status` text DEFAULT 'prepared' NOT NULL CHECK(`status` IN ('prepared','sent','failed')),
  `provider_reference` text DEFAULT '' NOT NULL,
  `error_message` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `sent_at` integer,
  `updated_at` integer NOT NULL,
  UNIQUE(`invoice_id`,`channel`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_public_token_unique` ON `invoices` (`public_token`) WHERE `public_token` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_due_status_idx` ON `invoices` (`owner_user_id`,`status`,`due_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoice_deliveries_owner_idx` ON `invoice_deliveries` (`owner_user_id`,`status`,`created_at`);
