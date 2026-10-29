CREATE TABLE IF NOT EXISTS `business_payment_accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `provider` text DEFAULT 'razorpay_route' NOT NULL CHECK(`provider` = 'razorpay_route'),
  `mode` text DEFAULT 'test' NOT NULL CHECK(`mode` IN ('test','live')),
  `provider_account_id` text,
  `status` text DEFAULT 'pending' NOT NULL CHECK(`status` IN ('pending','active','restricted','suspended')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `activated_at` integer,
  UNIQUE (`owner_user_id`,`provider`,`mode`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `business_payment_accounts_provider_unique`
  ON `business_payment_accounts` (`provider`,`mode`,`provider_account_id`)
  WHERE `provider_account_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `business_payment_accounts_owner_status_idx`
  ON `business_payment_accounts` (`owner_user_id`,`mode`,`status`);
--> statement-breakpoint
ALTER TABLE `razorpay_orders` ADD COLUMN `payment_account_id` integer;
--> statement-breakpoint
ALTER TABLE `razorpay_orders` ADD COLUMN `provider_account_id` text;
--> statement-breakpoint
ALTER TABLE `razorpay_orders` ADD COLUMN `transfer_id` text;
--> statement-breakpoint
ALTER TABLE `razorpay_orders` ADD COLUMN `transfer_status` text DEFAULT 'not_requested' NOT NULL;
--> statement-breakpoint
ALTER TABLE `razorpay_orders` ADD COLUMN `transfer_error` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `razorpay_orders_provider_account_idx`
  ON `razorpay_orders` (`provider_account_id`,`transfer_status`,`created_at`);
