import { getCustomers, getStagedOrders } from "@/db/queries";
import { IntakeForm } from "@/components/intake/intake-form";
import {
  StagedList,
  type InvalidStagedItem,
  type StagedItem,
} from "@/components/intake/staged-list";
import { UploadOrderButton } from "@/components/intake/upload-order-button";
import { Separator } from "@/components/ui/separator";
import { stagedPayload, stagedWarnings } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function IntakePage() {
  const [customers, staged] = await Promise.all([getCustomers(), getStagedOrders()]);

  const stagedItems: StagedItem[] = [];
  // Rows whose payload no longer parses used to be filtered out silently, which
  // left them sitting in the database invisible and unreviewable. They are listed
  // separately now so they can at least be seen and dismissed.
  const invalidStaged: InvalidStagedItem[] = [];

  for (const row of staged) {
    const parsed = stagedPayload.safeParse(row.payload);
    if (!parsed.success) {
      invalidStaged.push({
        id: row.id,
        createdAt: row.createdAt,
        reason: parsed.error.issues[0]?.message ?? "מבנה לא מזוהה",
      });
      continue;
    }
    // jsonb is not type-checked by the database, so re-validate on the way out —
    // and never let an odd warnings value cost us the whole card.
    const warnings = stagedWarnings.safeParse(row.warnings);
    stagedItems.push({
      id: row.id,
      createdAt: row.createdAt,
      payload: parsed.data,
      warnings: warnings.success ? warnings.data : [],
    });
  }

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">קליטת הזמנה</h1>
        <p className="text-sm text-muted-foreground">
          הזנה ידנית של הזמנת לקוח, או אישור הזמנות שנסרקו אוטומטית.
        </p>
      </div>

      <UploadOrderButton />

      <StagedList items={stagedItems} invalid={invalidStaged} />

      <Separator />

      <IntakeForm customers={customers} />
    </div>
  );
}
