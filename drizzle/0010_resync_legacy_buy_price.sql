-- One more pass of the 0009 copy (buy_price_usd -> buy_price_foreign), for dollar
-- prices the previous deployment wrote after 0009 ran. Not enough on its own: a
-- migration runs once, at the first build that sees it (which may be a preview
-- sharing the database), so the ongoing carry-over lives in scripts/migrate.ts
-- (releaseLegacyDollarPrices), which runs at every build. Idempotent.
UPDATE "order_lines" SET "buy_price_foreign" = "buy_price_usd", "buy_currency" = 'USD'
	WHERE "buy_price_usd" IS NOT NULL AND "buy_price_foreign" IS NULL;
