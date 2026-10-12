import { getMailUpdates } from "@/db/queries";
import { UpdatesView } from "@/components/updates/updates-view";
import { isMailUpdateKind } from "@/lib/mail-updates";

export const dynamic = "force-dynamic";

export default async function UpdatesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const params = await searchParams;
  const updates = await getMailUpdates();
  // The dashboard's alerts link here with ?kind=… so a click lands on that list.
  const kind = isMailUpdateKind(params.kind) ? params.kind : "all";
  return <UpdatesView updates={updates} initialKind={kind} />;
}
