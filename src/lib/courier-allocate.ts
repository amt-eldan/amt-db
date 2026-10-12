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
  /** Invoices that could not be processed this time (logged; the rest went on). */
  failed: number;
}

/** Money compared in agorot, so "150" and "150.00" are the same allocation. */
function sameAmount(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
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
 * What it will not do, because each would overrule a person:
 *  - place a shipment a reviewer left or made unplaced (see placeUnplacedShipments
 *    — only shipments with no line *and no decision* are eligible);
 *  - place by the supplier guess — identifying keys only (bol / po / order);
 *  - charge a line whose shipping cost was typed by hand (a cost with no
 *    allocation behind it): that shipment stays unplaced for a person to decide;
 *  - touch the shipping cost of a line whose allocation did not change.
 *
 * On an approved invoice the split is rewritten and the affected lines' shipping
 * costs recomputed in one transaction, from the invoice as it is *inside* that
 * transaction (row-locked), so a re-split saved a moment earlier is not written
 * over. On a pending invoice only the proposal is filled in, and approving it stays
 * a person's decision. Shekel invoices only.
 *
 * Never throws, and one bad invoice does not stop the others — it runs behind
 * writes that must not fail because of it.
 */
export async function allocatePendingCourierShipments(): Promise<PendingAllocationSummary> {
  const summary: PendingAllocationSummary = { invoices: 0, placed: 0, staged: 0, failed: 0 };
  let approved: { id: number; currency: string; shipments: unknown }[] = [];
  let staged: { id: number; payload: unknown }[] = [];
  try {
    [approved, staged] = await Promise.all([
      db
        .select({
          id: courierInvoices.id,
          currency: courierInvoices.currency,
          shipments: courierInvoices.shipments,
        })
        .from(courierInvoices),
      db
        .select({ id: stagedCourierInvoices.id, payload: stagedCourierInvoices.payload })
        .from(stagedCourierInvoices),
    ]);
  } catch (error) {
    console.error("allocatePendingCourierShipments: reading invoices failed", error);
    return summary;
  }

  const eligible = (s: { lineId: number | null; matchedBy: string | null }) =>
    s.lineId === null && s.matchedBy === null;
  const approvedWork = approved.filter(
    (inv) => inv.currency === "ILS" && readCourierShipments(inv.shipments).some(eligible),
  );
  const stagedWork = staged
    .map((row) => ({ id: row.id, draft: readCourierDraft(row.payload) }))
    .filter((row) => row.draft.shipments.some(eligible));
  if (approvedWork.length === 0 && stagedWork.length === 0) return summary;

  let lines: Awaited<ReturnType<typeof getCourierLineOptions>>;
  let blockedLineIds: Set<number>;
  try {
    lines = await getCourierLineOptions();
    const allocated = new Set(
      (
        await db
          .selectDistinct({ lineId: courierInvoiceAllocations.lineId })
          .from(courierInvoiceAllocations)
      ).map((r) => r.lineId),
    );
    // A shipping cost no allocation explains was typed by hand. The unattended
    // pass does not overwrite it — applyShippingCosts would replace it with the
    // allocation sum — so a shipment that would land there waits for a person.
    blockedLineIds = new Set(
      lines.filter((l) => l.shippingCost !== null && !allocated.has(l.lineId)).map((l) => l.lineId),
    );
  } catch (error) {
    console.error("allocatePendingCourierShipments: reading lines failed", error);
    return summary;
  }
  const knownLines = new Set(lines.map((l) => l.lineId));

  for (const { id } of approvedWork) {
    try {
      const result = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .select({ shipments: courierInvoices.shipments })
          .from(courierInvoices)
          .where(eq(courierInvoices.id, id))
          .for("update");
        if (!invoice) return null;
        const { shipments, placed } = placeUnplacedShipments(
          readCourierShipments(invoice.shipments),
          lines,
          { allowGuess: false, blockedLineIds },
        );
        if (placed === 0) return null;

        // A line deleted since approval took its allocation with it (cascade) but
        // is still named in the stored list; writing it back would fail the FK.
        const allocations = allocationsFromShipments(shipments).filter((a) =>
          knownLines.has(a.lineId),
        );
        const previous = await tx
          .select({ lineId: courierInvoiceAllocations.lineId, amount: courierInvoiceAllocations.amount })
          .from(courierInvoiceAllocations)
          .where(eq(courierInvoiceAllocations.invoiceId, id));
        await tx.delete(courierInvoiceAllocations).where(eq(courierInvoiceAllocations.invoiceId, id));
        if (allocations.length > 0) {
          await tx
            .insert(courierInvoiceAllocations)
            .values(allocations.map((a) => ({ ...a, invoiceId: id })));
        }
        await tx
          .update(courierInvoices)
          .set({ shipments, updatedAt: new Date() })
          .where(eq(courierInvoices.id, id));

        // Only the lines whose share of this invoice moved are recomputed.
        const before = new Map(previous.map((p) => [p.lineId, p.amount]));
        const after = new Map(allocations.map((a) => [a.lineId, a.amount]));
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
          (lineId) => !sameAmount(before.get(lineId), after.get(lineId)),
        );
        const written = await applyShippingCosts(tx, changed);
        return { placed, written };
      });
      if (!result) continue;
      await audit(
        "courier_invoice",
        id,
        "auto_allocate",
        { placed: result.placed, shippingCosts: result.written },
        "agent:courier",
      );
      summary.invoices++;
      summary.placed += result.placed;
    } catch (error) {
      summary.failed++;
      console.error(`allocatePendingCourierShipments: invoice ${id} failed`, error);
    }
  }

  for (const row of stagedWork) {
    try {
      const { shipments, placed } = placeUnplacedShipments(row.draft.shipments, lines, {
        allowGuess: false,
        blockedLineIds,
      });
      if (placed === 0) continue;
      await db
        .update(stagedCourierInvoices)
        .set({ payload: { ...row.draft, shipments } })
        .where(eq(stagedCourierInvoices.id, row.id));
      await audit("staged_courier_invoice", row.id, "auto_allocate", { placed }, "agent:courier");
      summary.staged++;
    } catch (error) {
      summary.failed++;
      console.error(`allocatePendingCourierShipments: staged invoice ${row.id} failed`, error);
    }
  }

  if (summary.invoices > 0 || summary.staged > 0) {
    try {
      revalidatePath("/courier");
      revalidatePath("/monthly");
      revalidatePath("/orders");
      revalidatePath("/");
    } catch (error) {
      console.error("allocatePendingCourierShipments: revalidate failed", error);
    }
  }
  return summary;
}
