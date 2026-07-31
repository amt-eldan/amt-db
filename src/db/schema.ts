import {
  boolean,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** drizzle has no built-in bytea; the driver hands Buffers both ways. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  note: text("note"),
});

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: text("order_number").notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    orderDate: date("order_date"),
    sourceFormat: text("source_format").notNull().default("manual"), // 'standard' | 'mod' | 'manual'
    sourceFile: text("source_file"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("orders_number_customer_unique").on(t.orderNumber, t.customerId)],
);

export const orderLines = pgTable("order_lines", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull().default(1),
  pn: text("pn"),
  sku: text("sku"),
  qty: numeric("qty"),
  unitPrice: numeric("unit_price"),
  poNumber: text("po_number"),
  supplier: text("supplier"),
  buyPrice: numeric("buy_price"),
  shippingCost: numeric("shipping_cost"),
  contractDueDate: date("contract_due_date"),
  deliveryUpdate: text("delivery_update"),
  paymentMethod: text("payment_method"),
  bol: text("bol"),
  carrier: text("carrier"),
  // Provenance for `bol`: 'auto' when the tracking agent filled it, 'manual'
  // once a human typed or corrected it. Lets the UI flag unreviewed values.
  bolSource: text("bol_source"), // NULL | 'auto' | 'manual'
  bolConfidence: numeric("bol_confidence"), // 0..1, only meaningful for 'auto'
  notes: text("notes"),
  manualStatus: text("manual_status"), // NULL | 'הגיע' | 'סופק חלקי' | 'מאחר'
  isOpen: boolean("is_open").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const stagedOrders = pgTable("staged_orders", {
  id: serial("id").primaryKey(),
  payload: jsonb("payload").notNull(), // { customer, orderNumber, orderDate, sourceFormat, sourceFile, lines: [...] }
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Supplier invoices — the documents the buy prices come from. Added by hand or
 * from a PDF that Claude read; either way one row per invoice, editable after
 * the fact (no staging step, unlike orders, which fan out into many lines).
 *
 * `order_id` is the loose link back to what the invoice is for. It is nullable
 * and `set null` on delete: an invoice is a record of money owed and must
 * survive the order it referenced.
 */
export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: serial("id").primaryKey(),
    supplier: text("supplier").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date"),
    poNumber: text("po_number"), // our PO as quoted by the supplier
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    amount: numeric("amount"), // invoice total as printed on the document
    currency: text("currency").notNull().default("ILS"),
    notes: text("notes"),
    fileName: text("file_name"),
    source: text("source").notNull().default("manual"), // 'manual' | 'extracted'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  // Same guard as orders: the pair identifies the document, so entering it
  // twice fails instead of silently duplicating a payable.
  (t) => [unique("supplier_invoices_number_supplier_unique").on(t.supplier, t.invoiceNumber)],
);

/**
 * The uploaded PDF itself, in a table of its own so that listing invoices
 * cannot accidentally select megabytes of file data.
 */
export const supplierInvoiceFiles = pgTable("supplier_invoice_files", {
  invoiceId: integer("invoice_id")
    .primaryKey()
    .references(() => supplierInvoices.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  bytes: bytea("bytes").notNull(),
});

/**
 * Courier invoices — what the shipping companies (בלדרים) charge us.
 *
 * A supplier invoice is only recorded; a courier invoice has to *land* somewhere:
 * its money is the `shipping_cost` of the lines it shipped, and that is what the
 * monthly summary subtracts to get profit. Which is why this one gets a staging
 * step and supplier invoices do not — an invoice enters the ledger only after a
 * human said which lines it paid for. Until then it sits in
 * `staged_courier_invoices` and no `courier_invoices` row exists.
 */
export const stagedCourierInvoices = pgTable("staged_courier_invoices", {
  id: serial("id").primaryKey(),
  // CourierInvoiceDraft (lib/validation): header + shipments, each shipment
  // already matched to a line where the tracking number gave it away.
  payload: jsonb("payload").notNull(),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  // The uploaded PDF travels with the pending row so approving it does not need
  // a second upload. Never selected when listing — see getStagedCourierInvoices.
  bytes: bytea("bytes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const courierInvoices = pgTable(
  "courier_invoices",
  {
    id: serial("id").primaryKey(),
    courier: text("courier").notNull(), // חברת השילוח / הבלדר
    invoiceNumber: text("invoice_number").notNull(),
    invoiceDate: date("invoice_date"),
    amount: numeric("amount"), // invoice total as printed on the document
    currency: text("currency").notNull().default("ILS"),
    notes: text("notes"),
    fileName: text("file_name"),
    source: text("source").notNull().default("manual"), // 'manual' | 'extracted'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [unique("courier_invoices_number_courier_unique").on(t.courier, t.invoiceNumber)],
);

export const courierInvoiceFiles = pgTable("courier_invoice_files", {
  invoiceId: integer("invoice_id")
    .primaryKey()
    .references(() => courierInvoices.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  bytes: bytea("bytes").notNull(),
});

/**
 * How much of a courier invoice belongs to one order line. These rows are the
 * source of truth behind `order_lines.shipping_cost`: it is always the sum of a
 * line's allocations, so deleting the invoice takes its cost back out of the
 * monthly profit instead of leaving an unexplained number behind.
 *
 * One row per (invoice, line) — a document that lists the same line twice is
 * summed into a single allocation on approval, so the sum stays well defined.
 */
export const courierInvoiceAllocations = pgTable(
  "courier_invoice_allocations",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => courierInvoices.id, { onDelete: "cascade" }),
    lineId: integer("line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    amount: numeric("amount").notNull(),
    bol: text("bol"), // the tracking number on the invoice that matched this line
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("courier_allocations_invoice_line_unique").on(t.invoiceId, t.lineId)],
);

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  entity: text("entity").notNull(),
  entityId: integer("entity_id"),
  action: text("action").notNull(),
  diff: jsonb("diff"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type StagedOrder = typeof stagedOrders.$inferSelect;
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type CourierInvoice = typeof courierInvoices.$inferSelect;
export type CourierInvoiceAllocation = typeof courierInvoiceAllocations.$inferSelect;
