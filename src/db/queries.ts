import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, orderLines, orders, stagedOrders } from "@/db/schema";

export interface OpenLineRow {
  lineId: number;
  orderId: number;
  orderNumber: string;
  orderDate: string | null;
  customerId: number;
  customerName: string;
  customerNote: string | null;
  pn: string | null;
  sku: string | null;
  qty: string | null;
  unitPrice: string | null;
  poNumber: string | null;
  supplier: string | null;
  buyPrice: string | null;
  shippingCost: string | null;
  contractDueDate: string | null;
  deliveryUpdate: string | null;
  paymentMethod: string | null;
  bol: string | null;
  notes: string | null;
  manualStatus: string | null;
  isOpen: boolean;
  createdAt: Date;
}

export async function getLines(includeArchived: boolean): Promise<OpenLineRow[]> {
  const rows = await db
    .select({
      lineId: orderLines.id,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      customerId: customers.id,
      customerName: customers.name,
      customerNote: customers.note,
      pn: orderLines.pn,
      sku: orderLines.sku,
      qty: orderLines.qty,
      unitPrice: orderLines.unitPrice,
      poNumber: orderLines.poNumber,
      supplier: orderLines.supplier,
      buyPrice: orderLines.buyPrice,
      shippingCost: orderLines.shippingCost,
      contractDueDate: orderLines.contractDueDate,
      deliveryUpdate: orderLines.deliveryUpdate,
      paymentMethod: orderLines.paymentMethod,
      bol: orderLines.bol,
      notes: orderLines.notes,
      manualStatus: orderLines.manualStatus,
      isOpen: orderLines.isOpen,
      createdAt: orderLines.createdAt,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(includeArchived ? undefined : eq(orderLines.isOpen, true))
    .orderBy(asc(customers.name), desc(orderLines.createdAt), desc(orderLines.id));
  return rows;
}

export interface MonthlyRow {
  lineId: number;
  orderNumber: string;
  orderDate: string | null;
  customerName: string;
  pn: string | null;
  supplier: string | null;
  qty: string | null;
  unitPrice: string | null;
  buyPrice: string | null;
  shippingCost: string | null;
  bol: string | null;
  notes: string | null;
}

export async function getMonthlyLines(year: number, month: number): Promise<MonthlyRow[]> {
  const rows = await db
    .select({
      lineId: orderLines.id,
      orderNumber: orders.orderNumber,
      orderDate: orders.orderDate,
      customerName: customers.name,
      pn: orderLines.pn,
      supplier: orderLines.supplier,
      qty: orderLines.qty,
      unitPrice: orderLines.unitPrice,
      buyPrice: orderLines.buyPrice,
      shippingCost: orderLines.shippingCost,
      bol: orderLines.bol,
      notes: orderLines.notes,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        // The monthly ledger reflects closed lines only (like the legacy
        // monthly sheets); open lines join it once they are closed.
        eq(orderLines.isOpen, false),
        sql`extract(year from ${orders.orderDate}) = ${year}`,
        sql`extract(month from ${orders.orderDate}) = ${month}`,
      ),
    )
    .orderBy(asc(customers.name), asc(orders.orderDate), asc(orderLines.id));
  return rows;
}

/** Months that have any order lines, as "yyyy-mm" strings, newest first. */
export async function getAvailableMonths(): Promise<string[]> {
  const rows = await db
    .select({ ym: sql<string>`to_char(${orders.orderDate}, 'YYYY-MM')` })
    .from(orders)
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .where(and(sql`${orders.orderDate} is not null`, eq(orderLines.isOpen, false)))
    .groupBy(sql`to_char(${orders.orderDate}, 'YYYY-MM')`)
    .orderBy(desc(sql`to_char(${orders.orderDate}, 'YYYY-MM')`));
  return rows.map((r) => r.ym);
}

export async function getCustomers() {
  return db.select().from(customers).orderBy(asc(customers.name));
}

export async function getStagedOrders() {
  return db.select().from(stagedOrders).orderBy(desc(stagedOrders.createdAt));
}

export async function findDuplicateOrder(orderNumber: string, customerName: string) {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(and(eq(orders.orderNumber, orderNumber), eq(customers.name, customerName)))
    .limit(1);
  return rows[0] ?? null;
}
