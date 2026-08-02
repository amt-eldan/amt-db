ALTER TABLE "order_lines" ADD COLUMN "shipment_status" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "shipment_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "shipment_eta" date;