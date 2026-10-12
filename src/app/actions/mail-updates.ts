"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { mailUpdates } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/require-session";
import type { ActionResult } from "./orders";

/**
 * Marking a supplier update as handled (or back). The only thing a person changes
 * on these rows: what the mail said is the mail's, and the dashboard counts what
 * nobody has dealt with yet.
 */
export async function setMailUpdateHandled(id: number, handled: boolean): Promise<ActionResult> {
  await requireSession();
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "מזהה לא תקין" };

  const [row] = await db
    .update(mailUpdates)
    .set({ handledAt: handled ? new Date() : null })
    .where(eq(mailUpdates.id, id))
    .returning({ id: mailUpdates.id });
  if (!row) return { ok: false, error: "העדכון לא נמצא" };

  await audit("mail_update", id, handled ? "handle" : "unhandle");
  revalidatePath("/");
  revalidatePath("/updates");
  return { ok: true, message: handled ? "סומן כטופל" : "הוחזר לרשימת הממתינים לטיפול" };
}
