import { getLines } from "@/db/queries";
import { BolView } from "@/components/bol/bol-view";

export const dynamic = "force-dynamic";

export default async function BolPage() {
  // Both open and archived lines: the page filters client-side, same as the
  // open-orders list.
  const lines = await getLines(true);

  return <BolView lines={lines} />;
}
