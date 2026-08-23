CREATE TABLE "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric NOT NULL,
	"source" text DEFAULT 'boi' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_currency_date_unique" UNIQUE("currency","rate_date")
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "delivered_at" date;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "buy_price_usd" numeric;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "fx_rate" numeric;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "fx_rate_date" date;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "fx_rate_source" text;--> statement-breakpoint
CREATE INDEX "fx_rates_currency_date_idx" ON "fx_rates" USING btree ("currency","rate_date");--> statement-breakpoint
CREATE INDEX "order_lines_status_checked_idx" ON "order_lines" USING btree ("is_open","shipment_status_at");