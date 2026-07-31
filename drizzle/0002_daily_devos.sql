CREATE TABLE IF NOT EXISTS "supplier_invoice_files" (
	"invoice_id" integer PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier" text NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date,
	"po_number" text,
	"order_id" integer,
	"amount" numeric,
	"currency" text DEFAULT 'ILS' NOT NULL,
	"notes" text,
	"file_name" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "supplier_invoices_number_supplier_unique" UNIQUE("supplier","invoice_number")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoice_files" ADD CONSTRAINT "supplier_invoice_files_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
