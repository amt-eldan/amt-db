ALTER TABLE "order_lines" ADD COLUMN "carrier" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "bol_source" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "bol_confidence" numeric;