ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "carrier" text;
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "bol_source" text;
--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN IF NOT EXISTS "bol_confidence" numeric;
