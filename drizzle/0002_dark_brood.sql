ALTER TABLE `customers` ADD `amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `contact_consent` integer DEFAULT false NOT NULL;