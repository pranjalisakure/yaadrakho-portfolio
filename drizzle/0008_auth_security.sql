ALTER TABLE `users` ADD `email_verified_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_at` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `last_activity_at` integer;
--> statement-breakpoint
UPDATE `users` SET `email_verified_at` = unixepoch('now') * 1000 WHERE `email_verified_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `account_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_tokens_token_hash_unique` ON `account_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `account_tokens_user_purpose_idx` ON `account_tokens` (`user_id`,`purpose`);
--> statement-breakpoint
CREATE INDEX `account_tokens_expires_at_idx` ON `account_tokens` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `auth_requests` (
	`request_key` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer NOT NULL,
	`blocked_until` integer
);
