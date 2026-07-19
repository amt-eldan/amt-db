import {
  boolean,
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
