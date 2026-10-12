/**
 * Where a courier invoice's money lands on order lines — and the second look that
 * lands it when the key arrives after the invoice did.
 *
 * Server-only, and deliberately not in src/app/actions/courier.ts: everything a
 * "use server" file exports becomes an action the browser can call, and these
 * write shipping costs with no session check of their own.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getCourierLineOptions, readCourierDraft, readCourierShipments } from "@/db/queries";
import {
  courierInvoiceAllocations,
  courierInvoices,
  orderLines,
  stagedCourierInvoices,
} from "@/db/schema";
import { audit } from "./audit";
import { allocationsFromShipments, placeUnplacedShipments } from "./courier-match";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Rewrites `order_lines.shipping_cost` for the given lines as the sum of their
 * allocations — the one rule that keeps the number explainable: every shekel of
 * shipping cost on a line traces back to a courier invoice, and a line with no
 * allocations left goes back to empty rather than keeping a figure nobody can
 * account for.
 *
 * Returns what it wrote, so the caller can put it in the audit entry.
 */
export async function applyShippingCosts(
  tx: Tx,
  lineIds: number[],
): Promise<Record<number, string | null>> {
  const unique = [...new Set(lineIds)];
  if (unique.length === 0) return {};

  const sums = await tx
    .select({
      lineId: courierInvoiceAllocations.lineId,
      total: sql<string>`sum(${courierInvoiceAllocations.amount})`,
    })
    .from(courierInvoiceAllocations)
    .where(inArray(courierInvoiceAllocations.lineId, unique))
    .groupBy(courierInvoiceAllocations.lineId);

  const totals = new Map(sums.map((row) => [row.lineId, row.total]));
  const written: Record<number, string | null> = {};
  for (const lineId of unique) {
    const value = totals.get(lineId) ?? null;
    written[lineId] = value;
    await tx
      .update(orderLines)
      .set({ shippingCost: value, updatedAt: new Date() })
      .where(eq(orderLines.id, lineId));
  }
  return written;
}

export interface PendingAllocationSummary {
  /** Approved invoices whose split changed. */
  invoices: number;
  /** Shipments that found their line(s) on this pass. */
  placed: number;
  /** Pending (not yet approved) invoices whose proposal was filled in. */
  staged: number;
}

/**
 * Places courier shipments that were left without a line because the key that
 * identifies them — usually the bill of lading — reached the line only after the
 * invoice was uploaded or approved.
 *
 * The courier bills a waybill; the tracking agent finds that waybill in the mail
 * and writes it on the line days later. Matching ran once, at upload, so the
 * shipment stayed unplaced and its cost never reached the monthly summary although
 * the line now carried the very number the invoice printed. This runs after every
 * write that can bring such a key (a bill of lading, a purchase-order number) and
 * when the courier and monthly pages load, so that cost lands by itself.
 *
 * Only the identifying keys may place a shipment here — tracking number, PO,
 * order number — never the supplier guess, which still needs a person. On an
 * approved invoice the split is rewritten and the lines' shipping costs
 * recomputed in one transaction, exactly as a re-split by hand would; on a
 * pending one only the proposal is filled in, and approving it stays a person's
 * decision. Shekel invoices only: a foreign total is never converted into a
 * shipping cost.
 *
 * Never throws — it runs behind writes that must not fail because of it.
 */
export async function allocatePendingCourierShipments(): Promise<PendingAllocationSummary> {
  const summary: PendingAllocationSummary = { invoices: 0, placed: 0, staged: 0 };
  try {
    const approved = (
      await db
        .select({
          id: courierInvoices.id,
          currency: courierInvoices.currency,
          shipments: courierInvoices.shipments,
        })
        .from(courierInvoices)
    )
      .map((inv) => ({ ...inv, shipments: readCourierShipments(inv.shipments) }))
      .filter((inv) => inv.currency === "ILS" && inv.shipments.some((s) => s.lineId === null));

    const staged = (
      await db
        .select({ id: stagedCourierInvoices.id, payload: stagedCourierInvoices.payload })
        .from(stagedCourierInvoices)
    )
      .map((row) => ({ id: row.id, draft: readCourierDraft(row.payload) }))
      .filter((row) => row.draft.shipments.some((s) => s.lineId === null));

    if (approved.length === 0 && staged.length === 0) return summary;
    const lines = await getCourierLineOptions();

    for (const invoice of approved) {
      const { shipments, placed } = placeUnplacedShipments(invoice.shipments, lines, {
        allowGuess: false,
      });
      if (placed === 0) continue;
      const allocations = allocationsFromShipments(shipments);

      const written = await db.transaction(async (tx) => {
        const previous = await tx
          .select({ lineId: courierInvoiceAllocations.lineId })
          .from(courierInvoiceAllocations)
          .where(eq(courierInvoiceAllocations.invoiceId, invoice.id));
        await tx
          .delete(courierInvoiceAllocations)
          .where(eq(courierInvoiceAllocations.invoiceId, invoice.id));
        if (allocations.length > 0) {
          await tx
            .insert(courierInvoiceAllocations)
            .values(allocations.map((a) => ({ ...a, invoiceId: invoice.id })));
        }
        await tx
          .update(courierInvoices)
          .set({ shipments, updatedAt: new Date() })
          .where(eq(courierInvoices.id, invoice.id));
        return applyShippingCosts(tx, [
          ...previous.map((p) => p.lineId),
          ...allocations.map((a) => a.lineId),
        ]);
      });

      await audit(
        "courier_invoice",
        invoice.id,
        "auto_allocate",
        { placed, shippingCosts: written },
        "agent:courier",
      );
      summary.invoices++;
      summary.placed += placed;
    }

    for (const row of staged) {
      const { shipments, placed } = placeUnplacedShipments(row.draft.shipments, lines, {
        allowGuess: false,
      });
      if (placed === 0) continue;
      await db
        .update(stagedCourierInvoices)
        .set({ payload: { ...row.draft, shipments } })
        .where(eq(stagedCourierInvoices.id, row.id));
      summary.staged++;
    }

    if (summary.invoices > 0 || summary.staged > 0) {
      revalidatePath("/courier");
      revalidatePath("/monthly");
      revalidatePath("/orders");
      revalidatePath("/");
    }
  } catch (error) {
    console.error("allocatePendingCourierShipments failed", error);
  }
  return summary;
}
