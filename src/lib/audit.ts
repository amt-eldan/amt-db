import { db } from "@/db";
import { auditLog } from "@/db/schema";

/** Write an audit_log row. Never throws — auditing must not break mutations. */
export async function audit(
  entity: string,
  entityId: number | null,
  action: string,
  diff?: unknown,
) {
  try {
    await db.insert(auditLog).values({
      entity,
      entityId,
      action,
      diff: diff ?? null,
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}
