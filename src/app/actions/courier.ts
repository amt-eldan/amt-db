"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  courierInvoiceAllocations,
  courierInvoiceFiles,
  courierInvoices,
  orderLines,
  stagedCourierInvoices,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import { allocationsFromShipments } from "@/lib/courier-match";
import { isUniqueViolation } from "@/lib/pg-error";
import { requireSession } from "@/lib/require-session";
import {
  courierAllocationsUpdate,
  courierInvoiceDraft,
  courierInvoiceUpdate,
} from "@/lib/validation";
import type { ActionResult } from "./orders";

/** Everything a courier invoice touches: its own page, and profit everywhere. */
function revalidateCourier() {
  revalidatePath("/courier");
  revalidatePath("/monthly");
  revalidatePath("/orders");
  revalidatePath("/");
}

function duplicateError(courier: string, invoiceNumber: string): ActionResult {
  return {
    ok: false,
    duplicate: true,
    error: `חשבונית ${invoiceNumber} מ-${courier} כבר קיימת`,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Rewrites `order_lines.shipping_cost` for the given lines as the sum of their
 * allocations — the one rule that keeps the number explainable: every shekel of
 * shipping cost on a line traces back to a courier invoice, and a line with no
 * allocations left goes back to empty rather than keeping a figure nobody can
 * account for.
 *
 * Returns what it wrote, so the caller can put it in the audit entry.
 */
async function applyShippingCosts(tx: Tx, lineIds: number[]): Promise<Record<number, string | null>> {
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

/** Lines an allocation points at must still exist, or the FK would fail unexplained. */
async function findMissingLines(tx: Tx, lineIds: number[]): Promise<number[]> {
  if (lineIds.length === 0) return [];
  const found = await tx
    .select({ id: orderLines.id })
    .from(orderLines)
    .where(inArray(orderLines.id, lineIds));
  const ids = new Set(found.map((row) => row.id));
  return lineIds.filter((id) => !ids.has(id));
}

/**
 * A courier charge is in shekels or it is not a shipping cost we can put on a
 * line: order lines hold plain numbers, and converting a foreign total here would
 * invent an exchange rate. Same refusal as the extraction's.
 */
function foreignCurrencyError(currency: string): ActionResult {
  return {
    ok: false,
    error: `החשבונית במטבע ${currency} — לא ניתן לשייך עלות משלוח שאינה בשקלים. יש להזין את הסכום בשקלים ולשייך שוב.`,
  };
}

/**
 * Manual entry — a draft, not an invoice. It lands in the pending list like an
 * uploaded PDF does, so allocating the shipping cost is part of getting it into
 * the ledger rather than a step someone may forget afterwards.
 */
export async function createStagedCourierInvoice(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = courierInvoiceDraft.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const draft = parsed.data;

  // Staging a document that could never be approved is not worth the round trip.
  const [existing] = await db
    .select({ id: courierInvoices.id })
    .from(courierInvoices)
    .where(
      and(
        eq(courierInvoices.courier, draft.courier),
        eq(courierInvoices.invoiceNumber, draft.invoiceNumber),
      ),
    )
    .limit(1);
  if (existing) return duplicateError(draft.courier, draft.invoiceNumber);

  const [row] = await db
    .insert(stagedCourierInvoices)
    .values({ payload: draft, fileName: draft.fileName })
    .returning({ id: stagedCourierInvoices.id });

  await audit("staged_courier_invoice", row.id, "create", {
    courier: draft.courier,
    invoiceNumber: draft.invoiceNumber,
    amount: draft.amount,
    shipments: draft.shipments.length,
    source: "manual",
  });
  revalidatePath("/courier");
  return { ok: true, message: `חשבונית ${draft.invoiceNumber} נוספה לרשימת ההמתנה לאישור` };
}

/**
 * Approve: the invoice enters the ledger and its cost lands on the lines it
 * shipped, in one transaction — an invoice that is recorded without its shipping
 * cost reaching the monthly summary is the failure this whole page exists to
 * prevent, so the two cannot come apart.
 *
 * `edited` is the reviewed payload from the card, not what was extracted.
 */
export async function approveCourierInvoice(
  stagedId: number,
  edited: unknown,
): Promise<ActionResult> {
  await requireSession();
  const parsed = courierInvoiceDraft.safeParse(edited);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "נתוני החשבונית לא תקינים" };
  }
  const draft = parsed.data;
  const allocations = allocationsFromShipments(draft.shipments);
  if (allocations.length > 0 && draft.currency !== "ILS") {
    return foreignCurrencyError(draft.currency);
  }

  const [staged] = await db
    .select({
      id: stagedCourierInvoices.id,
      fileName: stagedCourierInvoices.fileName,
      mimeType: stagedCourierInvoices.mimeType,
      sizeBytes: stagedCourierInvoices.sizeBytes,
      bytes: stagedCourierInvoices.bytes,
    })
    .from(stagedCourierInvoices)
    .where(eq(stagedCourierInvoices.id, stagedId));
  if (!staged) {
    return { ok: false, error: "החשבונית הממתינה לא נמצאה (ייתכן שכבר טופלה)" };
  }

  let invoiceId: number;
  let written: Record<number, string | null> = {};
  try {
    const result = await db.transaction(async (tx) => {
      const missing = await findMissingLines(
        tx,
        allocations.map((a) => a.lineId),
      );
      if (missing.length > 0) throw new MissingLinesError(missing);

      const [invoice] = await tx
        .insert(courierInvoices)
        .values({
          courier: draft.courier,
          invoiceNumber: draft.invoiceNumber,
          invoiceDate: draft.invoiceDate,
          amount: draft.amount,
          currency: draft.currency,
          notes: draft.notes,
          // Keep the document's own itemization, not just where the money landed:
          // the allocations say a line was charged 531.78, these say it was customs
          // fees + clearance + VAT. The staged row (and its copy of this) is deleted
          // a few statements below, so this is the last chance to keep it.
          shipments: draft.shipments,
          fileName: staged.fileName ?? draft.fileName,
          source: staged.bytes ? "extracted" : "manual",
        })
        .returning({ id: courierInvoices.id });

      if (staged.bytes) {
        await tx.insert(courierInvoiceFiles).values({
          invoiceId: invoice.id,
          mimeType: staged.mimeType ?? "application/pdf",
          sizeBytes: staged.sizeBytes ?? staged.bytes.byteLength,
          bytes: staged.bytes,
        });
      }

      if (allocations.length > 0) {
        await tx.insert(courierInvoiceAllocations).values(
          allocations.map((a) => ({
            invoiceId: invoice.id,
            lineId: a.lineId,
            amount: a.amount,
            bol: a.bol,
            description: a.description,
          })),
        );
      }
      const costs = await applyShippingCosts(
        tx,
        allocations.map((a) => a.lineId),
      );
      await tx.delete(stagedCourierInvoices).where(eq(stagedCourierInvoices.id, stagedId));
      return { invoiceId: invoice.id, costs };
    });
    invoiceId = result.invoiceId;
    written = result.costs;
  } catch (e) {
    if (e instanceof MissingLinesError) {
      return {
        ok: false,
        error: `שורות שנבחרו כבר לא קיימות (${e.lineIds.join(", ")}) — יש לרענן את העמוד ולשייך מחדש`,
      };
    }
    if (isUniqueViolation(e)) return duplicateError(draft.courier, draft.invoiceNumber);
    console.error("approveCourierInvoice failed", e);
    return { ok: false, error: "שגיאה בשמירת החשבונית" };
  }

  await audit("courier_invoice", invoiceId, "approve", {
    courier: draft.courier,
    invoiceNumber: draft.invoiceNumber,
    amount: draft.amount,
    stagedId,
    shippingCosts: written,
  });
  revalidateCourier();

  const lines = allocations.length;
  return {
    ok: true,
    message:
      lines === 0
        ? `חשבונית ${draft.invoiceNumber} אושרה (בלי שיוך לשורות)`
        : `חשבונית ${draft.invoiceNumber} אושרה — עלות משלוח נרשמה ל-${lines} שורות`,
  };
}

class MissingLinesError extends Error {
  constructor(readonly lineIds: number[]) {
    super("missing lines");
  }
}

export async function rejectStagedCourierInvoice(stagedId: number): Promise<ActionResult> {
  await requireSession();
  const [staged] = await db
    .select({ id: stagedCourierInvoices.id, payload: stagedCourierInvoices.payload })
    .from(stagedCourierInvoices)
    .where(eq(stagedCourierInvoices.id, stagedId));
  if (!staged) return { ok: false, error: "החשבונית הממתינה לא נמצאה" };

  await db.delete(stagedCourierInvoices).where(eq(stagedCourierInvoices.id, stagedId));
  await audit("staged_courier_invoice", stagedId, "reject", staged.payload);
  revalidatePath("/courier");
  return { ok: true, message: "החשבונית נדחתה ונמחקה" };
}

/** Header-only edit of an approved invoice; the split has its own action. */
export async function updateCourierInvoice(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = courierInvoiceUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const { id, ...fields } = parsed.data;

  const [existing] = await db.select().from(courierInvoices).where(eq(courierInvoices.id, id));
  if (!existing) return { ok: false, error: "החשבונית לא נמצאה" };

  try {
    await db
      .update(courierInvoices)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(courierInvoices.id, id));
  } catch (e) {
    if (isUniqueViolation(e)) return duplicateError(fields.courier, fields.invoiceNumber);
    console.error("updateCourierInvoice failed", e);
    return { ok: false, error: "שגיאה בעדכון החשבונית" };
  }

  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const before = existing[k as keyof typeof existing];
    if (String(before ?? "") !== String(v ?? "")) diff[k] = { from: before, to: v };
  }
  await audit("courier_invoice", id, "update", diff);
  revalidateCourier();
  return { ok: true, message: "החשבונית עודכנה" };
}

/**
 * Re-split an approved invoice. Lines it used to pay for are recomputed too, so a
 * line dropped from the split loses the cost it was given instead of keeping it.
 */
export async function updateCourierAllocations(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = courierAllocationsUpdate.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const { invoiceId, shipments } = parsed.data;
  const allocations = allocationsFromShipments(shipments);

  const [invoice] = await db
    .select({ currency: courierInvoices.currency, invoiceNumber: courierInvoices.invoiceNumber })
    .from(courierInvoices)
    .where(eq(courierInvoices.id, invoiceId));
  if (!invoice) return { ok: false, error: "החשבונית לא נמצאה" };
  if (allocations.length > 0 && invoice.currency !== "ILS") {
    return foreignCurrencyError(invoice.currency);
  }

  let written: Record<number, string | null>;
  try {
    written = await db.transaction(async (tx) => {
      const missing = await findMissingLines(
        tx,
        allocations.map((a) => a.lineId),
      );
      if (missing.length > 0) throw new MissingLinesError(missing);

      const previous = await tx
        .select({ lineId: courierInvoiceAllocations.lineId })
        .from(courierInvoiceAllocations)
        .where(eq(courierInvoiceAllocations.invoiceId, invoiceId));

      await tx
        .delete(courierInvoiceAllocations)
        .where(eq(courierInvoiceAllocations.invoiceId, invoiceId));
      if (allocations.length > 0) {
        await tx
          .insert(courierInvoiceAllocations)
          .values(allocations.map((a) => ({ ...a, invoiceId })));
      }
      // The reviewed list is the document's record and it was just re-edited, so it
      // is rewritten alongside the allocations rather than left describing the
      // previous split.
      await tx
        .update(courierInvoices)
        .set({ shipments, updatedAt: new Date() })
        .where(eq(courierInvoices.id, invoiceId));
      return applyShippingCosts(tx, [
        ...previous.map((p) => p.lineId),
        ...allocations.map((a) => a.lineId),
      ]);
    });
  } catch (e) {
    if (e instanceof MissingLinesError) {
      return {
        ok: false,
        error: `שורות שנבחרו כבר לא קיימות (${e.lineIds.join(", ")}) — יש לרענן את העמוד ולשייך מחדש`,
      };
    }
    console.error("updateCourierAllocations failed", e);
    return { ok: false, error: "שגיאה בעדכון השיוך" };
  }

  await audit("courier_invoice", invoiceId, "reallocate", { shippingCosts: written });
  revalidateCourier();
  return {
    ok: true,
    message:
      allocations.length === 0
        ? "השיוך בוטל — עלות המשלוח הוסרה מהשורות"
        : `השיוך עודכן ל-${allocations.length} שורות`,
  };
}

/**
 * Delete an approved invoice. Its allocations go with it (cascade) and the lines
 * it paid for are recomputed, so the monthly profit stops counting a cost that no
 * longer has a document behind it.
 */
export async function deleteCourierInvoice(id: number): Promise<ActionResult> {
  await requireSession();
  const [existing] = await db.select().from(courierInvoices).where(eq(courierInvoices.id, id));
  if (!existing) return { ok: false, error: "החשבונית לא נמצאה" };

  const written = await db.transaction(async (tx) => {
    const affected = await tx
      .select({ lineId: courierInvoiceAllocations.lineId })
      .from(courierInvoiceAllocations)
      .where(eq(courierInvoiceAllocations.invoiceId, id));
    // The stored PDF and the allocations cascade with the invoice row.
    await tx.delete(courierInvoices).where(eq(courierInvoices.id, id));
    return applyShippingCosts(
      tx,
      affected.map((a) => a.lineId),
    );
  });

  await audit("courier_invoice", id, "delete", {
    courier: existing.courier,
    invoiceNumber: existing.invoiceNumber,
    shippingCosts: written,
  });
  revalidateCourier();
  return { ok: true, message: "החשבונית נמחקה ועלות המשלוח הוסרה מהשורות" };
}
