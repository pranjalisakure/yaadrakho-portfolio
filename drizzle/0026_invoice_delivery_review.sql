ALTER TABLE invoice_deliveries ADD COLUMN review_note text NOT NULL DEFAULT '';
ALTER TABLE invoice_deliveries ADD COLUMN reviewed_at integer;
