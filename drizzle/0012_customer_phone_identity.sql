ALTER TABLE `customers` ADD `phone_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `customers_owner_phone_key_unique` ON `customers` (`owner_user_id`,`phone_key`) WHERE `owner_user_id` IS NOT NULL AND `phone_key` IS NOT NULL AND `phone_key` != '';
