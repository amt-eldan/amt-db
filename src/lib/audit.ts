import { db } from "@/db";
import { auditLog } from "@/db/schema";

/** Who a mutation is attributed to. See auditLog.actor. */
export type Actor = "user" | "anon" | `agent:${string}`;

/** Write an audit_log row. Never throws — auditing must not break mutations. */
export async function audit(
  entity: string,
  entityId: number | null,
  action: string,
  diff?: unknown,
  actor: Actor = "user",
) {
  try {
    await db.insert(auditLog).values({
      entity,
      entityId,
      action,
      actor,
      diff: diff ?? null,
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}
