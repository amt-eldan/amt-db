import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  orderLines,
  orders,
  stagedOrders,
  supplierInvoiceFiles,
  supplierInvoices,
} from "@/db/schema";

export interface LineRow {
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
 * Every column a line editor may write, shared by the open-orders list and the
 * monthly ledger: both hand the same row to the edit sheet, and a field missing
 * from the row would be saved back as empty.
 */
const lineColumns = {
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
};

export async function getLines(includeArchived: boolean): Promise<LineRow[]> {
  const rows = await db
    .select(lineColumns)
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(includeArchived ? undefined : eq(orderLines.isOpen, true))
    .orderBy(asc(customers.name), desc(orderLines.createdAt), desc(orderLines.id));
  return rows;
}

export async function getMonthlyLines(year: number, month: number): Promise<LineRow[]> {
  const rows = await db
    .select(lineColumns)
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

export interface SupplierInvoiceRow {
  id: number;
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  poNumber: string | null;
  orderId: number | null;
  orderNumber: string | null;
  customerName: string | null;
  amount: string | null;
  currency: string;
  notes: string | null;
  fileName: string | null;
  source: string;
  hasFile: boolean;
  createdAt: Date;
}

/**
 * Supplier invoices, newest document first. Deliberately never selects
 * `supplier_invoice_files.bytes` — the file is served by its own route.
 */
export async function getSupplierInvoices(): Promise<SupplierInvoiceRow[]> {
  return db
    .select({
      id: supplierInvoices.id,
      supplier: supplierInvoices.supplier,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate,
      poNumber: supplierInvoices.poNumber,
      orderId: supplierInvoices.orderId,
      orderNumber: orders.orderNumber,
      customerName: customers.name,
      amount: supplierInvoices.amount,
      currency: supplierInvoices.currency,
      notes: supplierInvoices.notes,
      fileName: supplierInvoices.fileName,
      source: supplierInvoices.source,
      hasFile: sql<boolean>`${supplierInvoiceFiles.invoiceId} is not null`,
      createdAt: supplierInvoices.createdAt,
    })
    .from(supplierInvoices)
    .leftJoin(orders, eq(supplierInvoices.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(supplierInvoiceFiles, eq(supplierInvoiceFiles.invoiceId, supplierInvoices.id))
    .orderBy(sql`${supplierInvoices.invoiceDate} desc nulls last`, desc(supplierInvoices.id));
}

/** The stored PDF for one invoice. Used only by the file-download route. */
export async function getSupplierInvoiceFile(invoiceId: number) {
  const rows = await db
    .select({
      bytes: supplierInvoiceFiles.bytes,
      mimeType: supplierInvoiceFiles.mimeType,
      fileName: supplierInvoices.fileName,
    })
    .from(supplierInvoiceFiles)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceFiles.invoiceId))
    .where(eq(supplierInvoiceFiles.invoiceId, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

/** Orders an invoice can be attached to, newest first. */
export async function getOrderOptions() {
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: customers.name,
      orderDate: orders.orderDate,
    })
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .orderBy(sql`${orders.orderDate} desc nulls last`, desc(orders.id));
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
