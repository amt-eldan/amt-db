ALTER TABLE "courier_invoices" ADD COLUMN IF NOT EXISTS "shipments" jsonb;
