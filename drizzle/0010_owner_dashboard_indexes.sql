CREATE INDEX IF NOT EXISTS `users_owner_activity_idx` ON `users` (`is_owner`,`last_activity_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customers_owner_user_idx` ON `customers` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `payment_transactions_owner_user_idx` ON `payment_transactions` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subscriptions_plan_status_idx` ON `subscriptions` (`plan`,`status`);
