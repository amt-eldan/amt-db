import { getCustomers, getStagedOrders } from "@/db/queries";
import { IntakeForm } from "@/components/intake/intake-form";
import { StagedList } from "@/components/intake/staged-list";
import { Separator } from "@/components/ui/separator";
import { stagedPayload, type StagedPayload } from "@/lib/validation";

export const dynamic = "force-dynamic";

export default async function IntakePage() {
  const [customers, staged] = await Promise.all([getCustomers(), getStagedOrders()]);

  const stagedItems = staged
    .map((row) => {
      const parsed = stagedPayload.safeParse(row.payload);
      return parsed.success
        ? { id: row.id, createdAt: row.createdAt, payload: parsed.data as StagedPayload }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">קליטת הזמנה</h1>
        <p className="text-sm text-muted-foreground">
          הזנה ידנית של הזמנת לקוח, או אישור הזמנות שנסרקו אוטומטית.
        </p>
      </div>

      <StagedList items={stagedItems} />

      <Separator />

      <IntakeForm customers={customers} />
    </div>
  );
}
