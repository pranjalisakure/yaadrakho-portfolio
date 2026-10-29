ALTER TABLE `customers` ADD `owner_user_id` integer;
--> statement-breakpoint
ALTER TABLE `customers` ADD `current_due_id` integer;
--> statement-breakpoint
ALTER TABLE `customer_payments` ADD `owner_user_id` integer;
--> statement-breakpoint
CREATE TABLE `payment_dues` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `customer_id` integer NOT NULL,
  `period_key` text NOT NULL,
  `due_date` text NOT NULL,
  `amount_due` integer NOT NULL CHECK(`amount_due` >= 0),
  `amount_paid` integer DEFAULT 0 NOT NULL CHECK(`amount_paid` >= 0 AND `amount_paid` <= `amount_due`),
  `status` text DEFAULT 'pending' NOT NULL CHECK(`status` IN ('pending','partial','paid')),
  `paid_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  UNIQUE(`owner_user_id`,`customer_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `payment_transactions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `customer_id` integer NOT NULL,
  `due_id` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `amount` integer NOT NULL CHECK(`amount` > 0),
  `method` text DEFAULT 'other' NOT NULL CHECK(`method` IN ('cash','upi','paytm','bank','other')),
  `reference` text DEFAULT '' NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `received_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  UNIQUE(`owner_user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `payment_dues_owner_status_idx` ON `payment_dues` (`owner_user_id`,`status`,`due_date`);
--> statement-breakpoint
CREATE INDEX `payment_dues_customer_idx` ON `payment_dues` (`customer_id`);
--> statement-breakpoint
CREATE INDEX `payment_transactions_due_idx` ON `payment_transactions` (`due_id`,`received_at`);
--> statement-breakpoint
UPDATE `customers` SET `owner_user_id` = (SELECT `id` FROM `users` WHERE `users`.`storage_key` = `customers`.`owner_email`) WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `customer_payments` SET `owner_user_id` = (SELECT `id` FROM `users` WHERE `users`.`storage_key` = `customer_payments`.`owner_email`) WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `payment_dues`
  (`owner_user_id`,`owner_key`,`customer_id`,`period_key`,`due_date`,`amount_due`,`amount_paid`,`status`,`paid_at`,`created_at`,`updated_at`)
SELECT `owner_user_id`,`owner_email`,`customer_id`,`period_key`,`due_date`,`amount`,`amount`,'paid',`paid_at`,`created_at`,CAST(strftime('%s','now') AS integer) * 1000
FROM `customer_payments` WHERE `owner_user_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `payment_transactions`
  (`owner_user_id`,`owner_key`,`customer_id`,`due_id`,`idempotency_key`,`amount`,`method`,`reference`,`note`,`received_at`,`created_at`)
SELECT cp.`owner_user_id`,cp.`owner_email`,cp.`customer_id`,pd.`id`,'legacy-customer-payment:' || cp.`id`,cp.`amount`,'other','','Backfilled from customer_payments',cp.`paid_at`,cp.`created_at`
FROM `customer_payments` cp JOIN `payment_dues` pd ON pd.`owner_user_id` = cp.`owner_user_id` AND pd.`customer_id` = cp.`customer_id` AND pd.`period_key` = cp.`period_key`
WHERE cp.`owner_user_id` IS NOT NULL AND cp.`amount` > 0;
--> statement-breakpoint
INSERT OR IGNORE INTO `payment_dues`
  (`owner_user_id`,`owner_key`,`customer_id`,`period_key`,`due_date`,`amount_due`,`amount_paid`,`status`,`paid_at`,`created_at`,`updated_at`)
SELECT c.`owner_user_id`,c.`owner_email`,c.`id`,CASE WHEN c.`billing_cycle`='monthly' THEN substr(c.`follow_up_date`,1,7) ELSE 'one-time:' || c.`id` END,
  c.`follow_up_date`,c.`amount`,CASE WHEN c.`billing_cycle`='one_time' AND (c.`payment_status`='paid' OR c.`status`='won') THEN c.`amount` ELSE 0 END,
  CASE WHEN c.`billing_cycle`='one_time' AND (c.`payment_status`='paid' OR c.`status`='won') THEN 'paid' ELSE 'pending' END,
  CASE WHEN c.`billing_cycle`='one_time' AND (c.`payment_status`='paid' OR c.`status`='won') THEN c.`updated_at` ELSE NULL END,c.`created_at`,CAST(strftime('%s','now') AS integer) * 1000
FROM `customers` c WHERE c.`owner_user_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `customers` SET `current_due_id` = (SELECT pd.`id` FROM `payment_dues` pd WHERE pd.`owner_user_id`=`customers`.`owner_user_id` AND pd.`customer_id`=`customers`.`id`
  AND pd.`period_key`=CASE WHEN `customers`.`billing_cycle`='monthly' THEN substr(`customers`.`follow_up_date`,1,7) ELSE 'one-time:' || `customers`.`id` END LIMIT 1)
WHERE `owner_user_id` IS NOT NULL AND `current_due_id` IS NULL;
