import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLog,
  courierInvoiceAllocations,
  courierInvoiceFiles,
  courierInvoices,
  customers,
  orderLines,
  orders,
  stagedCourierInvoices,
  stagedOrders,
  supplierInvoiceFiles,
  supplierInvoices,
} from "@/db/schema";
import type { BolCandidateLine } from "@/lib/bol-match";
import type { CourierLineOption } from "@/lib/courier-match";
import { monthRange } from "@/lib/format";
import {
  courierInvoiceDraft,
  courierShipmentInput,
  type CourierInvoiceDraft,
  type CourierShipmentInput,
} from "@/lib/validation";

export interface LineRow {
  lineId: number;
  orderId: number;
  orderNumber: string;
  orderDate: string | null;
  /** When the order came in from the customer — see `receivedDateSql`. */
  receivedDate: string;
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
  shipmentStatus: string | null;
  shipmentStatusAt: Date | null;
  shipmentEta: string | null;
  notes: string | null;
  manualStatus: string | null;
  isOpen: boolean;
  createdAt: Date;
}

/**
 * The date an order was received from the customer: what the document says, and
 * failing that the moment it was entered into the system. The fallback is what
 * keeps an order without a printed date from falling out of the monthly ledger
 * entirely — it is always in *some* month, and the screens mark which orders
 * are dated by their intake rather than by the document.
 *
 * Cast in Asia/Jerusalem (Neon runs in UTC) so an order entered late at night
 * lands in the month it was actually entered, and `::text` so the driver hands
 * back "yyyy-mm-dd" like every other date in `LineRow`.
 */
const receivedDateSql = sql<string>`coalesce(${orders.orderDate}, (${orders.createdAt} at time zone 'Asia/Jerusalem')::date)`;

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
  receivedDate: sql<string>`${receivedDateSql}::text`,
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
  shipmentStatus: orderLines.shipmentStatus,
  shipmentStatusAt: orderLines.shipmentStatusAt,
  shipmentEta: orderLines.shipmentEta,
  notes: orderLines.notes,
  manualStatus: orderLines.manualStatus,
  isOpen: orderLines.isOpen,
  createdAt: orderLines.createdAt,
};

/**
 * Every line, or only the open ones. The dashboard and the bills-of-lading screen
 * both need the full set — the first to chart history, the second to let the
 * archive be toggled without a round-trip.
 *
 * Screens that show open **or** archive and never both should use getLineSet
 * instead, which does the split in SQL.
 */
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

/**
 * **Exactly one** of the two sets, for the open-orders screen — which shows either
 * open lines or the archive, never both. Loading both and hiding half in the
 * browser meant every page load shipped the whole (ever-growing) archive just to
 * filter it away again.
 */
export async function getLineSet(archived: boolean): Promise<LineRow[]> {
  const rows = await db
    .select(lineColumns)
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(eq(orderLines.isOpen, !archived))
    .orderBy(asc(customers.name), desc(orderLines.createdAt), desc(orderLines.id));
  return rows;
}

/** The columns lineStatus() needs, plus the customer, for the header stat cards. */
export type OpenStatusRow = Pick<
  LineRow,
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

export async function getMonthlyLines(year: number, month: number): Promise<LineRow[]> {
  const { from, to } = monthRange(year, month);
  const rows = await db
    .select(lineColumns)
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .where(
      and(
        // Open and closed alike: a month's page is "what came in that month",
        // so an order received in August shows up in August even though nothing
        // has been delivered or closed yet. The view separates the two, and
        // profit stays "ממתין" on any line whose buy price is still unknown.
        //
        // A half-open range rather than extract(year/month from …), so the
        // comparison stays one expression per row instead of two. It cannot use
        // orders_order_date_idx — the coalesce in receivedDateSql makes it a
        // function over the column — but the month page reads a bounded slice
        // and a scan here is cheap.
        sql`${receivedDateSql} >= ${from}`,
        sql`${receivedDateSql} < ${to}`,
      ),
    )
    .orderBy(asc(customers.name), asc(receivedDateSql), asc(orderLines.id));
  return rows;
}

/** Months that have any order lines, as "yyyy-mm" strings, newest first. */
export async function getAvailableMonths(): Promise<string[]> {
  const ym = sql<string>`to_char(${receivedDateSql}, 'YYYY-MM')`;
  const rows = await db
    .select({ ym })
    .from(orders)
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .groupBy(ym)
    .orderBy(desc(ym));
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

/**
 * Every line a tracking number could belong to, with the keys an email may quote
 * it by. Feeds resolveBolLine when a match arrives without a lineId — the agent
 * read a P/N in the mail and never saw our worklist.
 *
 * Closed lines and lines that already have a BOL are included on purpose: the
 * resolver needs to see them to answer "that line is closed" or "that number is
 * already there" instead of the useless "no match".
 */
export async function getBolCandidateLines(): Promise<BolCandidateLine[]> {
  return db
    .select({
      lineId: orderLines.id,
      orderNumber: orders.orderNumber,
      pn: orderLines.pn,
      sku: orderLines.sku,
      poNumber: orderLines.poNumber,
      supplier: orderLines.supplier,
      bol: orderLines.bol,
      isOpen: orderLines.isOpen,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .orderBy(asc(orderLines.id));
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

export interface CourierInvoiceRow {
  id: number;
  courier: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  amount: string | null;
  currency: string;
  notes: string | null;
  fileName: string | null;
  source: string;
  hasFile: boolean;
  /** What this invoice actually put on order lines — may differ from `amount`. */
  allocatedTotal: string | null;
  allocatedLines: number;
  /**
   * The document's own itemization as it was reviewed on approval: one entry per
   * shipment, each with the charges its total is made of. Empty for invoices
   * approved before this was kept — the allocations are still the record of money.
   */
  shipments: CourierShipmentInput[];
  createdAt: Date;
}

/**
 * Approved courier invoices, newest document first, each with what it charged to
 * order lines. Never selects `courier_invoice_files.bytes` — the file is served by
 * its own route.
 */
export async function getCourierInvoices(): Promise<CourierInvoiceRow[]> {
  const rows = await db
    .select({
      id: courierInvoices.id,
      courier: courierInvoices.courier,
      invoiceNumber: courierInvoices.invoiceNumber,
      invoiceDate: courierInvoices.invoiceDate,
      amount: courierInvoices.amount,
      currency: courierInvoices.currency,
      notes: courierInvoices.notes,
      fileName: courierInvoices.fileName,
      source: courierInvoices.source,
      hasFile: sql<boolean>`${courierInvoiceFiles.invoiceId} is not null`,
      allocatedTotal: sql<string | null>`sum(${courierInvoiceAllocations.amount})`,
      allocatedLines: sql<number>`count(${courierInvoiceAllocations.id})::int`,
      shipments: courierInvoices.shipments,
      createdAt: courierInvoices.createdAt,
    })
    .from(courierInvoices)
    .leftJoin(courierInvoiceFiles, eq(courierInvoiceFiles.invoiceId, courierInvoices.id))
    .leftJoin(courierInvoiceAllocations, eq(courierInvoiceAllocations.invoiceId, courierInvoices.id))
    // Grouping by the primary key is enough for Postgres to allow the other
    // courier_invoices columns; the files join contributes only its own key.
    .groupBy(courierInvoices.id, courierInvoiceFiles.invoiceId)
    .orderBy(sql`${courierInvoices.invoiceDate} desc nulls last`, desc(courierInvoices.id));
  return rows.map((row) => ({ ...row, shipments: readCourierShipments(row.shipments) }));
}

export interface CourierAllocationRow {
  id: number;
  invoiceId: number;
  lineId: number;
  amount: string;
  bol: string | null;
  description: string | null;
  orderNumber: string;
  customerName: string;
  pn: string | null;
  poNumber: string | null;
  orderDate: string | null;
  isOpen: boolean;
  /** The line's current shipping cost — the sum of all its allocations. */
  lineShippingCost: string | null;
}

/** Every allocation with the line it sits on, for the courier page to group by invoice. */
export async function getCourierAllocations(): Promise<CourierAllocationRow[]> {
  return db
    .select({
      id: courierInvoiceAllocations.id,
      invoiceId: courierInvoiceAllocations.invoiceId,
      lineId: courierInvoiceAllocations.lineId,
      amount: courierInvoiceAllocations.amount,
      bol: courierInvoiceAllocations.bol,
      description: courierInvoiceAllocations.description,
      orderNumber: orders.orderNumber,
      customerName: customers.name,
      pn: orderLines.pn,
      poNumber: orderLines.poNumber,
      orderDate: orders.orderDate,
      isOpen: orderLines.isOpen,
      lineShippingCost: orderLines.shippingCost,
    })
    .from(courierInvoiceAllocations)
    .innerJoin(orderLines, eq(orderLines.id, courierInvoiceAllocations.lineId))
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .orderBy(asc(courierInvoiceAllocations.invoiceId), asc(courierInvoiceAllocations.id));
}

export interface StagedCourierInvoiceRow {
  id: number;
  createdAt: Date;
  fileName: string | null;
  hasFile: boolean;
  payload: CourierInvoiceDraft;
}

/**
 * Courier invoices waiting for approval. Selects columns explicitly so the stored
 * PDF (which lives in the same row) is never dragged into the list.
 */
export async function getStagedCourierInvoices(): Promise<StagedCourierInvoiceRow[]> {
  const rows = await db
    .select({
      id: stagedCourierInvoices.id,
      createdAt: stagedCourierInvoices.createdAt,
      fileName: stagedCourierInvoices.fileName,
      hasFile: sql<boolean>`${stagedCourierInvoices.bytes} is not null`,
      payload: stagedCourierInvoices.payload,
    })
    .from(stagedCourierInvoices)
    .orderBy(desc(stagedCourierInvoices.createdAt), desc(stagedCourierInvoices.id));
  return rows.map((row) => ({ ...row, payload: readCourierDraft(row.payload) }));
}

/**
 * A staged payload was written through courierInvoiceDraft — but not necessarily
 * through today's version of it: a row staged before shipments carried `charges`
 * has no such field. Reading it back through the schema is what fills the defaults
 * in, so the review UI never meets a half-shaped draft it will crash on.
 */
export function readCourierDraft(payload: unknown): CourierInvoiceDraft {
  const parsed = courierInvoiceDraft.safeParse(payload);
  if (parsed.success) return parsed.data;

  // Can't-happen: every staged row went in through the schema. Keep the pending
  // list renderable rather than losing it all to one unreadable row, and say so
  // instead of showing shipments nobody can trust.
  const raw = asDraftish(payload);
  return {
    courier: raw.courier ?? "",
    invoiceNumber: raw.invoiceNumber ?? "",
    invoiceDate: raw.invoiceDate ?? null,
    amount: raw.amount ?? null,
    currency: raw.currency ?? "ILS",
    notes: raw.notes ?? null,
    fileName: raw.fileName ?? null,
    shipments: [],
    warnings: [
      ...(Array.isArray(raw.warnings) ? raw.warnings : []),
      "הנתונים השמורים של החשבונית לא נקראו במלואם — יש להזין את המשלוחים מול המסמך",
    ],
  };
}

function asDraftish(payload: unknown): Partial<CourierInvoiceDraft> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Partial<CourierInvoiceDraft>)
    : {};
}

/**
 * The shipment list stored on an approved invoice, read back through the schema so
 * a row written before `charges` existed still comes out well-shaped. Null/absent
 * (invoices approved before the column existed) means "the document's own
 * itemization was not kept" — the allocations are still there.
 */
export function readCourierShipments(stored: unknown): CourierShipmentInput[] {
  if (!Array.isArray(stored)) return [];
  const parsed = z.array(courierShipmentInput).safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** The stored PDF for one approved courier invoice. Used only by the file route. */
export async function getCourierInvoiceFile(invoiceId: number) {
  const rows = await db
    .select({
      bytes: courierInvoiceFiles.bytes,
      mimeType: courierInvoiceFiles.mimeType,
      fileName: courierInvoices.fileName,
    })
    .from(courierInvoiceFiles)
    .innerJoin(courierInvoices, eq(courierInvoices.id, courierInvoiceFiles.invoiceId))
    .where(eq(courierInvoiceFiles.invoiceId, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The stored PDF of a pending courier invoice — the reviewer needs to read the
 * document while deciding which lines it covers.
 */
export async function getStagedCourierInvoiceFile(stagedId: number) {
  const rows = await db
    .select({
      bytes: stagedCourierInvoices.bytes,
      mimeType: stagedCourierInvoices.mimeType,
      fileName: stagedCourierInvoices.fileName,
    })
    .from(stagedCourierInvoices)
    .where(eq(stagedCourierInvoices.id, stagedId))
    .limit(1);
  const row = rows[0];
  if (!row?.bytes) return null;
  return { bytes: row.bytes, mimeType: row.mimeType, fileName: row.fileName };
}

/**
 * Lines a courier charge can be attached to — open and closed alike, because the
 * shipping cost of a closed line is exactly what the monthly summary needs.
 * Deliberately narrow: these fields are the matcher's input and the picker's
 * labels, nothing more.
 */
export async function getCourierLineOptions(): Promise<CourierLineOption[]> {
  return db
    .select({
      lineId: orderLines.id,
      orderNumber: orders.orderNumber,
      customerName: customers.name,
      pn: orderLines.pn,
      poNumber: orderLines.poNumber,
      // The supplier key's other half. Selected here rather than joined later
      // because matching runs on this exact row set — see matchShipmentsToLines.
      supplier: orderLines.supplier,
      bol: orderLines.bol,
      shippingCost: orderLines.shippingCost,
      orderDate: orders.orderDate,
      isOpen: orderLines.isOpen,
    })
    .from(orderLines)
    .innerJoin(orders, eq(orderLines.orderId, orders.id))
    .innerJoin(customers, eq(orders.customerId, customers.id))
    .orderBy(sql`${orders.orderDate} desc nulls last`, desc(orderLines.id));
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

export interface ActivityRow {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  createdAt: Date;
}

/**
 * The last few audited writes, for the dashboard's activity panel. Deliberately
 * without `diff` — the panel says what happened, and the audit row itself is where
 * anyone goes for what exactly changed.
 */
export async function getRecentActivity(limit = 8): Promise<ActivityRow[]> {
  return db
    .select({
      id: auditLog.id,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      action: auditLog.action,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(limit);
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
