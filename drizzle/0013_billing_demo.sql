CREATE TABLE IF NOT EXISTS `product_catalog` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `name` text NOT NULL,
  `name_key` text NOT NULL,
  `price` integer NOT NULL CHECK(`price` >= 0),
  `gst_rate` integer DEFAULT 0 NOT NULL CHECK(`gst_rate` IN (0,5,12,18,28)),
  `unit` text DEFAULT 'item' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  UNIQUE(`owner_user_id`,`name_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_sequences` (
  `owner_user_id` integer PRIMARY KEY NOT NULL,
  `next_value` integer DEFAULT 1 NOT NULL CHECK(`next_value` > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoices` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `owner_user_id` integer NOT NULL,
  `owner_key` text NOT NULL,
  `customer_id` integer NOT NULL,
  `due_id` integer,
  `invoice_number` text NOT NULL,
  `billing_mode` text DEFAULT 'separate' NOT NULL CHECK(`billing_mode` IN ('separate','monthly_statement')),
  `issue_date` text NOT NULL,
  `due_date` text NOT NULL,
  `subtotal` integer NOT NULL CHECK(`subtotal` >= 0),
  `tax_amount` integer DEFAULT 0 NOT NULL CHECK(`tax_amount` >= 0),
  `total_amount` integer NOT NULL CHECK(`total_amount` > 0),
  `amount_paid` integer DEFAULT 0 NOT NULL CHECK(`amount_paid` >= 0 AND `amount_paid` <= `total_amount`),
  `status` text DEFAULT 'issued' NOT NULL CHECK(`status` IN ('issued','partial','paid','cancelled')),
  `notes` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  UNIQUE(`owner_user_id`,`invoice_number`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invoice_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invoice_id` integer NOT NULL,
  `product_id` integer,
  `description` text NOT NULL,
  `quantity_milli` integer NOT NULL CHECK(`quantity_milli` > 0),
  `unit` text DEFAULT 'item' NOT NULL,
  `unit_price` integer NOT NULL CHECK(`unit_price` >= 0),
  `gst_rate` integer DEFAULT 0 NOT NULL CHECK(`gst_rate` IN (0,5,12,18,28)),
  `line_subtotal` integer NOT NULL CHECK(`line_subtotal` >= 0),
  `line_tax` integer DEFAULT 0 NOT NULL CHECK(`line_tax` >= 0),
  `line_total` integer NOT NULL CHECK(`line_total` >= 0),
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_catalog_owner_idx` ON `product_catalog` (`owner_user_id`,`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_owner_date_idx` ON `invoices` (`owner_user_id`,`issue_date`,`id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoices_customer_idx` ON `invoices` (`owner_user_id`,`customer_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invoices_due_unique` ON `invoices` (`due_id`) WHERE `due_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invoice_items_invoice_idx` ON `invoice_items` (`invoice_id`,`id`);
