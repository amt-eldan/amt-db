import {
  getCourierAllocations,
  getCourierInvoices,
  getCourierLineOptions,
  getStagedCourierInvoices,
} from "@/db/queries";
import { CourierView } from "@/components/courier/courier-view";

export const dynamic = "force-dynamic";

export default async function CourierPage() {
  const [invoices, allocations, staged, lines] = await Promise.all([
    getCourierInvoices(),
    getCourierAllocations(),
    getStagedCourierInvoices(),
    getCourierLineOptions(),
  ]);

  return (
    <CourierView invoices={invoices} allocations={allocations} staged={staged} lines={lines} />
  );
}
