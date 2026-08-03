import {
  getCourierInvoices,
  getLines,
  getRecentActivity,
  getStagedCourierInvoices,
  getStagedOrders,
  getSupplierInvoices,
} from "@/db/queries";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { buildDashboard } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

/**
 * The landing page: one screen across every module. It reads the same rows the
 * individual pages read and puts them through lib/dashboard, so a figure here can
 * never drift from the page it links to.
 */
export default async function DashboardPage() {
  const [lines, supplierInvoices, courierInvoices, stagedCourier, stagedOrders, activity] =
    await Promise.all([
      getLines(true), // open and closed: the pipeline and the history
      getSupplierInvoices(),
      getCourierInvoices(),
      getStagedCourierInvoices(),
      getStagedOrders(),
      getRecentActivity(8),
    ]);

  const today = new Date();
  const data = buildDashboard({
    lines,
    supplierInvoices,
    courierInvoices,
    pendingOrders: stagedOrders.length,
    pendingCourierInvoices: stagedCourier.length,
    today,
  });

  return (
    <DashboardView data={data} activity={activity} today={today.toISOString().slice(0, 10)} />
  );
}
