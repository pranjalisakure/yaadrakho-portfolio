CREATE TABLE IF NOT EXISTS `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_key` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_subscriptions_owner_idx` ON `push_subscriptions` (`owner_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`date_key` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_deliveries_subscription_date_unique` ON `push_deliveries` (`subscription_id`,`date_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_deliveries_date_idx` ON `push_deliveries` (`date_key`);
