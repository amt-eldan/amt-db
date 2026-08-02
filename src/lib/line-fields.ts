import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { audit, type Actor } from "@/lib/audit";

/**
 * Writes already-validated field updates onto a line and records the before/after
 * diff in audit_log. Shared by the manual edit action (updateLineFields) and the
 * /api/bol/matches auto-fill endpoint, so a value written by the tracking agent
 * leaves the same audit trail as one typed by hand.
 *
 * `provenance` is stored under diff.source — for auto-filled BOLs this is the
 * email the number came from, which is what makes an automatic write reviewable.
 *
 * Callers own authentication and revalidatePath; this function does neither.
 */
export async function applyLineFields(
  existing: OrderLine,
  fields: Record<string, unknown>,
  provenance?: Record<string, unknown>,
  actor: Actor = "user",
): Promise<void> {
  await db
    .update(orderLines)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(orderLines.id, existing.id));

  const diff: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const before = existing[k as keyof OrderLine];
    if (String(before ?? "") !== String(v ?? "")) diff[k] = { from: before, to: v };
  }
  if (provenance) diff.source = provenance;
  await audit("order_line", existing.id, "update", diff, actor);
}
