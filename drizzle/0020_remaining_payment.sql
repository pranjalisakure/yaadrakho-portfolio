ALTER TABLE invoices ADD COLUMN remaining_payment text NOT NULL DEFAULT 'online' CHECK(remaining_payment IN ('online','cash'));
