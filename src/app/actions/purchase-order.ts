"use server";

import { writePurchaseOrderCosts, type PoWriteSummary } from "@/lib/po-write";
import { requireSession } from "@/lib/require-session";
import { poApplyInput } from "@/lib/validation";

export type PoApplyResult = PoWriteSummary | { ok: false; error: string };

/**
 * Applies the reviewed matches from an uploaded purchase order.
 *
 * Thin on purpose: authenticate, validate, hand over. Every rule about which line
 * may receive which cost lives in lib/po-match and is re-run inside
 * writePurchaseOrderCosts, so this action cannot be used to write a cost the
 * review screen would not have offered.
 */
export async function applyPurchaseOrder(input: unknown): Promise<PoApplyResult> {
  await requireSession();

  const parsed = poApplyInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "קלט לא תקין" };
  }

  try {
    return await writePurchaseOrderCosts(parsed.data);
  } catch (error) {
    console.error("purchase order apply failed", error);
    return { ok: false, error: "שמירת מחירי הקנייה נכשלה. הפרטים נרשמו בלוג השרת." };
  }
}
