"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { customers, orderLines, orders } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/require-session";
import { MANUAL_STATUSES } from "@/lib/status";
import { manualFieldsInput, orderInput, type OrderInput } from "@/lib/validation";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; duplicate?: boolean };

async function getOrCreateCustomer(
  tx: Pick<typeof db, "select" | "insert">,
  name: string,
  note: string | null,
): Promise<number> {
  const existing = await tx.select().from(customers).where(eq(customers.name, name)).limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await tx
    .insert(customers)
    .values({ name, note })
    .onConflictDoNothing()
    .returning({ id: customers.id });
  if (inserted[0]) return inserted[0].id;
  const again = await tx.select().from(customers).where(eq(customers.name, name)).limit(1);
  return again[0].id;
}

/** Creates order + lines in a transaction. Used by manual intake and staged approval. */
export async function createOrder(input: OrderInput): Promise<ActionResult> {
  await requireSession();
  const parsed = orderInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const data = parsed.data;

  try {
    const orderId = await db.transaction(async (tx) => {
      const customerId = await getOrCreateCustomer(tx, data.customerName, data.customerNote);

      const existing = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.orderNumber, data.orderNumber), eq(orders.customerId, customerId)))
        .limit(1);
      if (existing[0] && !data.allowDuplicate) {
        throw new DuplicateOrderError();
      }

      const [order] = await tx
        .insert(orders)
        .values({
          orderNumber: data.orderNumber,
          customerId,
          orderDate: data.orderDate,
          sourceFormat: data.sourceFormat,
          sourceFile: data.sourceFile,
        })
        .returning({ id: orders.id });

      await tx.insert(orderLines).values(
        data.lines.map((line, i) => ({
          orderId: order.id,
          lineNo: i + 1,
          pn: line.pn,
          sku: line.sku,
          qty: line.qty,
          unitPrice: line.unitPrice,
          contractDueDate: line.contractDueDate,
          notes: line.notes,
        })),
      );
      return order.id;
    });

    await audit("order", orderId, "create", {
      orderNumber: data.orderNumber,
      customer: data.customerName,
      lines: data.lines.length,
      source: data.sourceFormat,
    });
    revalidatePath("/");
    revalidatePath("/intake");
    revalidatePath("/monthly");
    return { ok: true, message: `הזמנה ${data.orderNumber} נוספה למעקב` };
  } catch (e) {
    if (e instanceof DuplicateOrderError) {
      return {
        ok: false,
        duplicate: true,
        error: `הזמנה ${data.orderNumber} כבר קיימת ללקוח ${data.customerName}`,
      };
    }
    console.error("createOrder failed", e);
    return { ok: false, error: "שגיאה בשמירת ההזמנה" };
  }
}

class DuplicateOrderError extends Error {}

/** Set manual_status; returns previous value so the toast "undo" can restore it. */
export async function setManualStatus(
  lineId: number,
  status: string | null,
): Promise<ActionResult & { previous?: string | null }> {
  await requireSession();
  if (status !== null && !MANUAL_STATUSES.includes(status as (typeof MANUAL_STATUSES)[number])) {
    return { ok: false, error: "סטטוס לא חוקי" };
  }
  const [existing] = await db
    .select({ manualStatus: orderLines.manualStatus })
    .from(orderLines)
    .where(eq(orderLines.id, lineId));
  if (!existing) return { ok: false, error: "השורה לא נמצאה" };

  await db
    .update(orderLines)
    .set({ manualStatus: status, updatedAt: new Date() })
    .where(eq(orderLines.id, lineId));
  await audit("order_line", lineId, "set_manual_status", {
    from: existing.manualStatus,
    to: status,
  });
  revalidatePath("/");
  return { ok: true, previous: existing.manualStatus };
}

export async function updateLineFields(input: unknown): Promise<ActionResult> {
  await requireSession();
  const parsed = manualFieldsInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }
  const { lineId, ...fields } = parsed.data;

  const [existing] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  if (!existing) return { ok: false, error: "השורה לא נמצאה" };

  await db
    .update(orderLines)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orderLines.id, lineId));

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(fields)) {
    const before = existing[k as keyof typeof existing];
    if (String(before ?? "") !== String(v ?? "")) diff[k] = { from: before, to: v };
  }
  await audit("order_line", lineId, "update", diff);
  revalidatePath("/");
  revalidatePath("/monthly");
  return { ok: true, message: "השורה עודכנה" };
}

export async function setLineOpen(lineId: number, isOpen: boolean): Promise<ActionResult> {
  await requireSession();
  await db
    .update(orderLines)
    .set({ isOpen, updatedAt: new Date() })
    .where(eq(orderLines.id, lineId));
  await audit("order_line", lineId, isOpen ? "reopen" : "close");
  revalidatePath("/");
  return { ok: true, message: isOpen ? "השורה נפתחה מחדש" : "השורה נסגרה" };
}

export async function deleteLine(lineId: number): Promise<ActionResult> {
  await requireSession();
  const [existing] = await db.select().from(orderLines).where(eq(orderLines.id, lineId));
  if (!existing) return { ok: false, error: "השורה לא נמצאה" };

  await db.transaction(async (tx) => {
    await tx.delete(orderLines).where(eq(orderLines.id, lineId));
    // Remove the parent order if it has no lines left.
    const remaining = await tx
      .select({ id: orderLines.id })
      .from(orderLines)
      .where(eq(orderLines.orderId, existing.orderId))
      .limit(1);
    if (!remaining[0]) {
      await tx.delete(orders).where(eq(orders.id, existing.orderId));
    }
  });
  await audit("order_line", lineId, "delete", { pn: existing.pn, orderId: existing.orderId });
  revalidatePath("/");
  revalidatePath("/monthly");
  return { ok: true, message: "השורה נמחקה" };
}
