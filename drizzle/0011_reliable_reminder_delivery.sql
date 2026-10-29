CREATE TABLE IF NOT EXISTS `push_delivery_claims` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`date_key` text NOT NULL,
	`delivery_slot` text NOT NULL,
	`claimed_at` integer NOT NULL,
	UNIQUE(`subscription_id`,`date_key`,`delivery_slot`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_delivery_claims_claimed_idx` ON `push_delivery_claims` (`claimed_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `push_delivery_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`due_id` integer NOT NULL,
	`date_key` text NOT NULL,
	`delivery_slot` text NOT NULL,
	`sent_at` integer NOT NULL,
	UNIQUE(`subscription_id`,`due_id`,`date_key`,`delivery_slot`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `push_delivery_items_date_idx` ON `push_delivery_items` (`date_key`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reminder_job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date_key` text NOT NULL,
	`delivery_slot` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`checked_subscriptions` integer DEFAULT 0 NOT NULL,
	`sent_notifications` integer DEFAULT 0 NOT NULL,
	`failed_notifications` integer DEFAULT 0 NOT NULL,
	`removed_subscriptions` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error_message` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `reminder_job_runs_started_idx` ON `reminder_job_runs` (`started_at`);
