CREATE TABLE IF NOT EXISTS "mail_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"po_number" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text,
	"sender" text,
	"received_at" date,
	"quote" text,
	"bol" text,
	"new_date" date,
	"source" text DEFAULT 'sync' NOT NULL,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_updates_message_po_kind_unique" UNIQUE("message_id","po_number","kind")
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "buy_price_foreign" numeric;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "buy_currency" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "po_unit_cost" numeric;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "po_currency" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "po_qty" numeric;--> statement-breakpoint
-- Dollar prices move to the currency-aware pair. buy_price_usd itself stays: the
-- deployment still serving while this one builds selects it (see schema.ts).
UPDATE "order_lines" SET "buy_price_foreign" = "buy_price_usd", "buy_currency" = 'USD'
	WHERE "buy_price_usd" IS NOT NULL AND "buy_price_foreign" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_updates_handled_idx" ON "mail_updates" USING btree ("handled_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_updates_po_idx" ON "mail_updates" USING btree ("po_number");
