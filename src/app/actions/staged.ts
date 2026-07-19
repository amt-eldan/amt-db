"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { stagedOrders } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/require-session";
import { stagedPayload } from "@/lib/validation";
import { createOrder, type ActionResult } from "./orders";

/**
 * Approve a staged order: create order + lines (transaction inside
 * createOrder), then delete the staged row.
 * `edited` is the (possibly user-edited) payload from the review card.
 */
export async function approveStaged(
  stagedId: number,
  edited: unknown,
  allowDuplicate = false,
): Promise<ActionResult> {
  await requireSession();
  const [staged] = await db.select().from(stagedOrders).where(eq(stagedOrders.id, stagedId));
  if (!staged) return { ok: false, error: "ההזמנה הממתינה לא נמצאה (ייתכן שכבר טופלה)" };

  const parsed = stagedPayload.safeParse(edited);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "נתוני ההזמנה לא תקינים" };
  }
  const p = parsed.data;

  const result = await createOrder({
    customerName: p.customer,
    customerNote: p.customerNote,
    orderNumber: p.orderNumber,
    orderDate: p.orderDate,
    sourceFormat: p.sourceFormat,
    sourceFile: p.sourceFile,
    lines: p.lines.map((l) => ({
      pn: l.pn,
      sku: l.sku,
      qty: l.qty,
      unitPrice: l.unitPrice,
      contractDueDate: l.contractDueDate,
      notes: l.notes,
    })),
    allowDuplicate,
  });
  if (!result.ok) return result;

  await db.delete(stagedOrders).where(eq(stagedOrders.id, stagedId));
  await audit("staged_order", stagedId, "approve", { orderNumber: p.orderNumber });
  revalidatePath("/intake");
  return { ok: true, message: `הזמנה ${p.orderNumber} אושרה ונוספה למעקב` };
}

export async function rejectStaged(stagedId: number): Promise<ActionResult> {
  await requireSession();
  const [staged] = await db.select().from(stagedOrders).where(eq(stagedOrders.id, stagedId));
  if (!staged) return { ok: false, error: "ההזמנה הממתינה לא נמצאה" };

  await db.delete(stagedOrders).where(eq(stagedOrders.id, stagedId));
  await audit("staged_order", stagedId, "reject", staged.payload);
  revalidatePath("/intake");
  return { ok: true, message: "ההזמנה נדחתה ונמחקה" };
}
