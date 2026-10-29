CREATE TABLE IF NOT EXISTS `push_delivery_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`date_key` text NOT NULL,
	`delivery_slot` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `push_delivery_slots_subscription_date_slot_unique` ON `push_delivery_slots` (`subscription_id`,`date_key`,`delivery_slot`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_delivery_slots_date_idx` ON `push_delivery_slots` (`date_key`);
