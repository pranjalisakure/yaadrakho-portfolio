CREATE TABLE IF NOT EXISTS `razorpay_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `customer_id` integer NOT NULL,
  `invoice_id` integer NOT NULL,
  `due_id` integer NOT NULL,
  `request_key` text NOT NULL,
  `razorpay_order_id` text,
  `amount` integer NOT NULL CHECK (`amount` > 0),
  `currency` text DEFAULT 'INR' NOT NULL CHECK (`currency` = 'INR'),
  `status` text DEFAULT 'creating' NOT NULL CHECK (`status` IN ('creating','created','paid','failed','cancelled')),
  `payment_id` text,
  `error_message` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `paid_at` integer,
  UNIQUE (`owner_user_id`,`request_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `razorpay_webhook_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `event_type` text NOT NULL,
  `status` text DEFAULT 'received' NOT NULL CHECK (`status` IN ('received','processed','ignored','failed')),
  `error_message` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `razorpay_orders_order_unique`
  ON `razorpay_orders` (`razorpay_order_id`) WHERE `razorpay_order_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `razorpay_orders_payment_unique`
  ON `razorpay_orders` (`payment_id`) WHERE `payment_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `razorpay_orders_invoice_idx`
  ON `razorpay_orders` (`invoice_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `razorpay_orders_owner_idx`
  ON `razorpay_orders` (`owner_user_id`,`status`,`created_at`);
