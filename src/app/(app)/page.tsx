import { getLines } from "@/db/queries";
import { OpenOrdersView } from "@/components/open-orders/open-orders-view";

export const dynamic = "force-dynamic";

export default async function OpenOrdersPage() {
  const lines = await getLines(true); // includes archived; client toggles visibility
  return <OpenOrdersView lines={lines} />;
}
