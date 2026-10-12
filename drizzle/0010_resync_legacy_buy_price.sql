-- 0009 copied buy_price_usd into buy_price_foreign once, while the previous
-- deployment kept serving and writing buy_price_usd only. Every build — preview
-- builds too, when they share the database — runs migrations before the new code
-- goes live, so dollar prices written in that window would otherwise be invisible
-- to the new code. This repeats the same guarded copy at the production build.
-- Idempotent: it only fills a foreign price that is still empty.
UPDATE "order_lines" SET "buy_price_foreign" = "buy_price_usd", "buy_currency" = 'USD'
	WHERE "buy_price_usd" IS NOT NULL AND "buy_price_foreign" IS NULL;
