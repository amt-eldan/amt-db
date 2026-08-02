import {
  boolean,
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
