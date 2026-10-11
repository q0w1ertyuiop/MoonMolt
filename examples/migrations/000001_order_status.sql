ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
UPDATE orders SET status='paid' WHERE amount_cents > 0;
