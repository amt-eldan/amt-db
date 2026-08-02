import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, orderLines, orders, stagedOrders } from "@/db/schema";
import { monthRange } from "@/lib/format";

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
  carrier: string | null;
  bolSource: string | null;
  bolConfidence: string | null;
  notes: string | null;
  manualStatus: string | null;
  isOpen: boolean;
  createdAt: Date;
}

/**
 * Lines for the open-orders screen — **exactly one** of the two sets, because the
 * screen shows either open lines or the archive and never both. Loading both and
 * filtering in the browser meant every page load shipped the whole (ever-growing)
 * archive to the client just to hide it.
 */
export async function getLines(archived: boolean): Promise<OpenLineRow[]> {
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
      carrier: orderLines.carrier,
      bolSource: orderLines.bolSource,
      bolConfidence: orderLines.bolConfidence,
      notes: orderLines.notes,
      manualStatus: orderLines.manualStatus,
      isOpen: orderLines.isOpen,
      createdAt: orderLines.createdAt,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orderLines.isOpen, !archived))
    .orderBy(asc(customers.name), desc(orderLines.createdAt), desc(orderLines.id));
  return rows;
}

/** The columns lineStatus() needs, plus the customer, for the header stat cards. */
export type OpenStatusRow = Pick<
  OpenLineRow,
  "customerName" | "manualStatus" | "bol" | "deliveryUpdate" | "notes" | "contractDueDate"
>;

/**
 * Open lines, narrowed to just what the stat cards need.
 *
 * The "late" count depends on lineStatus(), whose priority rules must stay in one
 * place rather than being reimplemented in SQL — so the rows are still counted in
 * JS, but six columns of them instead of all twenty-five. Queried separately from
 * getLines so the cards keep showing open-line figures while the archive is on
 * screen.
 */
export async function getOpenStatusRows(): Promise<OpenStatusRow[]> {
  return db
    .select({
      customerName: customers.name,
      manualStatus: orderLines.manualStatus,
      bol: orderLines.bol,
      deliveryUpdate: orderLines.deliveryUpdate,
      notes: orderLines.notes,
      contractDueDate: orderLines.contractDueDate,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orderLines.isOpen, true));
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
  const { from, to } = monthRange(year, month);
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
        // A half-open range rather than extract(year/month from …): a function
        // over the column cannot use orders_order_date_idx, a range can.
        gte(orders.orderDate, from),
        lt(orders.orderDate, to),
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

export interface BolWorklistRow {
  lineId: number;
  orderNumber: string;
  customer: string;
  pn: string | null;
  sku: string | null;
  poNumber: string | null;
  supplier: string | null;
  contractDueDate: string | null;
}

/**
 * Open lines that still have no bill of lading, each with the keys the external
 * tracking agent searches the mailbox by (PO number, P/N, order number,
 * supplier). This is what turns a blind inbox scan into a targeted lookup: the
 * agent is told which lines need a number and echoes back the lineId, so a match
 * is never guessed against the table.
 *
 * Lines already marked "הגיע" by hand need no tracking. Most urgent first, so a
 * partial run still covers the lines that matter.
 */
export async function getBolWorklist(): Promise<BolWorklistRow[]> {
  return db
    .select({
      lineId: orderLines.id,
      orderNumber: orders.orderNumber,
      customer: customers.name,
      pn: orderLines.pn,
      sku: orderLines.sku,
      poNumber: orderLines.poNumber,
      supplier: orderLines.supplier,
      contractDueDate: orderLines.contractDueDate,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        eq(orderLines.isOpen, true),
        sql`coalesce(trim(${orderLines.bol}), '') = ''`,
        sql`${orderLines.manualStatus} is distinct from 'הגיע'`,
      ),
    )
    .orderBy(sql`${orderLines.contractDueDate} asc nulls last`, asc(orderLines.id));
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
