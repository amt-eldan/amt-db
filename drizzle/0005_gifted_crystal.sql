CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor" text;--> statement-breakpoint
ALTER TABLE "staged_orders" ADD COLUMN "warnings" jsonb;--> statement-breakpoint
CREATE INDEX "login_attempts_ip_created_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_id_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_open_due_idx" ON "order_lines" USING btree ("is_open","contract_due_date");--> statement-breakpoint
CREATE INDEX "order_lines_shipment_idx" ON "order_lines" USING btree ("is_open","shipment_status");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_order_date_idx" ON "orders" USING btree ("order_date");