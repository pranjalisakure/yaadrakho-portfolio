CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_email` text NOT NULL,
	`plan` text DEFAULT 'trial' NOT NULL,
	`status` text DEFAULT 'trial' NOT NULL,
	`price` integer DEFAULT 0 NOT NULL,
	`trial_ends_at` integer NOT NULL,
	`requested_at` integer,
	`activated_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_user_email_unique` ON `subscriptions` (`user_email`);