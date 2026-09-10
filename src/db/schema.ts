import {
  boolean,
  customType,
  date,
  index,
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
  (t) => [
    unique("orders_number_customer_unique").on(t.orderNumber, t.customerId),
    index("orders_customer_id_idx").on(t.customerId),
    // Monthly ledger filters on a date range (see getMonthlyLines).
    index("orders_order_date_idx").on(t.orderDate),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
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
    // Machine-readable shipment state, normalized from what the carrier reports.
    // `delivery_update` above keeps the raw text a human reads; this column is
    // what decides colour — **it, and not `bol`, is what makes a row green.** A
    // bill of lading only means a box left a warehouse.
    shipmentStatus: text("shipment_status"), // NULL (unknown) | see SHIPMENT_STATUSES
    shipmentStatusAt: timestamp("shipment_status_at", { withTimezone: true }),
    // The carrier's own wording for that state — "In transit - Departed Facility,
    // Cologne", "Delivered - Signed for by: E.LEVI". Refreshed on every check.
    //
    // Separate from `delivery_update` because the two have opposite lifecycles,
    // and sharing one column silently lost this text: `delivery_update` is a
    // person's note, so an unattended run may only fill it while it is empty —
    // which meant the first status a shipment ever reported was the last one the
    // screen ever showed, while every later reading was dropped. The enum above
    // kept moving, the prose did not. A field that must be replaced twice a day
    // cannot live behind a rule designed to protect something written once.
    shipmentStatusText: text("shipment_status_text"),
    shipmentEta: date("shipment_eta"),
    // The date the carrier says the goods were handed over. Distinct from
    // shipment_status_at, which is when *we looked* — and it is this date, not
    // ours, that picks the representative exchange rate below.
    deliveredAt: date("delivered_at"),
    // Purchase orders are priced in dollars while everything else in this table
    // is shekels. buy_price stays the shekel figure the whole app already sums;
    // these three record where it came from, so the number is auditable instead
    // of being re-derived at display time with whatever rate is current.
    buyPriceUsd: numeric("buy_price_usd"),
    fxRate: numeric("fx_rate"), // ILS per 1 USD, as published
    fxRateDate: date("fx_rate_date"), // the day that rate was published (see fx.ts)
    fxRateSource: text("fx_rate_source"), // NULL | 'boi' | 'manual'
    notes: text("notes"),
    manualStatus: text("manual_status"), // NULL | 'הגיע' | 'סופק חלקי' | 'מאחר'
    isOpen: boolean("is_open").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    // The FK Postgres does not index for us — used by every join and by the
    // "delete the order when its last line goes" check in deleteLine.
    index("order_lines_order_id_idx").on(t.orderId),
    // Open/archived split (getLines) and the BOL worklist's due-date ordering.
    index("order_lines_open_due_idx").on(t.isOpen, t.contractDueDate),
    // The in-the-air filter on the bills-of-lading screen, and the twice-daily
    // status worklist: open lines whose shipment is not settled yet, oldest
    // observation first.
    index("order_lines_shipment_idx").on(t.isOpen, t.shipmentStatus),
    index("order_lines_status_checked_idx").on(t.isOpen, t.shipmentStatusAt),
  ],
);

export const stagedOrders = pgTable("staged_orders", {
  id: serial("id").primaryKey(),
  payload: jsonb("payload").notNull(), // { customer, orderNumber, orderDate, sourceFormat, sourceFile, lines: [...] }
  // Things a human should double-check before approving (blurred field, total
  // mismatch, missing order date). Kept out of `payload` because `payload` is
  // both the documented API contract and what the review card sends back after
  // editing — warnings are provenance, not editable order data.
  warnings: jsonb("warnings").$type<string[]>(),
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
    // CourierShipmentInput[] (lib/validation): the reviewed shipment list, each
    // with the charges the document said its total is made of. The allocations
    // table records where the money *went*; this records what the document *said*,
    // and it is the only thing left that can explain a shipping cost of 531.78 as
    // "customs fees + clearance + VAT" once the staged row is gone. Null on
    // invoices approved before it existed.
    shipments: jsonb("shipments"),
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

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    action: text("action").notNull(),
    // Who caused it: 'user' (the shared login), 'agent:<name>' for an automated
    // writer, 'anon' for pre-login events. Ready for real multi-user auth.
    actor: text("actor"),
    diff: jsonb("diff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entity, t.entityId, t.createdAt)],
);

/**
 * Representative exchange rates (שער יציג) as the Bank of Israel published them.
 *
 * A cache, not a source of truth: the rate that a line was actually converted at
 * is snapshotted onto the line itself (order_lines.fx_rate). This table exists so
 * a run does not re-ask the Bank of Israel for a day it already knows, and so a
 * rate stays available after the fact even if the upstream series moves.
 *
 * One row per published day — the rate is published once per business day and not
 * at all on weekends and holidays, which is why the lookup asks for "the last rate
 * on or before" a date rather than for the date itself (see src/lib/fx.ts).
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: serial("id").primaryKey(),
    currency: text("currency").notNull(), // 'USD'
    rateDate: date("rate_date").notNull(), // the day the rate was published for
    rate: numeric("rate").notNull(), // ILS per 1 unit of `currency`
    source: text("source").notNull().default("boi"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("fx_rates_currency_date_unique").on(t.currency, t.rateDate),
    // The lookup is always "newest rate at or before this date, for this currency".
    index("fx_rates_currency_date_idx").on(t.currency, t.rateDate),
  ],
);

/**
 * Failed login attempts, for the brute-force lock in src/lib/login-throttle.ts.
 * A row per failure; an IP's rows are cleared on a successful login and aged out
 * of the counting window otherwise, so the table stays small.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: serial("id").primaryKey(),
    ip: text("ip").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("login_attempts_ip_created_idx").on(t.ip, t.createdAt)],
);

export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type StagedOrder = typeof stagedOrders.$inferSelect;
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type CourierInvoice = typeof courierInvoices.$inferSelect;
export type CourierInvoiceAllocation = typeof courierInvoiceAllocations.$inferSelect;
export type FxRate = typeof fxRates.$inferSelect;
