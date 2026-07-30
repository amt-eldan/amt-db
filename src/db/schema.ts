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
