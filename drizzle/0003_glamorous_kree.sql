CREATE TABLE IF NOT EXISTS "courier_invoice_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"line_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"bol" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_allocations_invoice_line_unique" UNIQUE("invoice_id","line_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courier_invoice_files" (
	"invoice_id" integer PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "courier_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"courier" text NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date,
	"amount" numeric,
	"currency" text DEFAULT 'ILS' NOT NULL,
	"notes" text,
	"file_name" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "courier_invoices_number_courier_unique" UNIQUE("courier","invoice_number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staged_courier_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"file_name" text,
	"mime_type" text,
	"size_bytes" integer,
	"bytes" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courier_invoice_allocations" ADD CONSTRAINT "courier_invoice_allocations_invoice_id_courier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."courier_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courier_invoice_allocations" ADD CONSTRAINT "courier_invoice_allocations_line_id_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "courier_invoice_files" ADD CONSTRAINT "courier_invoice_files_invoice_id_courier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."courier_invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
