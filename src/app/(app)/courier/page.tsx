import { after } from "next/server";
import {
  getCourierAllocations,
  getCourierInvoices,
  getCourierLineOptions,
  getStagedCourierInvoices,
} from "@/db/queries";
import { CourierView } from "@/components/courier/courier-view";
import { allocatePendingCourierShipments } from "@/lib/courier-allocate";

export const dynamic = "force-dynamic";

export default async function CourierPage() {
  const [invoices, allocations, staged, lines] = await Promise.all([
    getCourierInvoices(),
    getCourierAllocations(),
    getStagedCourierInvoices(),
    getCourierLineOptions(),
  ]);

  // Shipments still waiting for their line whose bill of lading has since arrived
  // (including ones billed before this check existed) are placed once the page
  // is sent; the next load shows the shipping cost on the line.
  after(() => allocatePendingCourierShipments());

  return (
    <CourierView invoices={invoices} allocations={allocations} staged={staged} lines={lines} />
  );
}
