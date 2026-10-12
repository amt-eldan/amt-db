import { after } from "next/server";
import {
  getCourierInvoices,
  getLines,
  getMailUpdates,
  getRecentActivity,
  getStagedCourierInvoices,
  getStagedOrders,
  getSupplierInvoices,
  getUnhandledMailUpdateCounts,
} from "@/db/queries";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { buildDashboard } from "@/lib/dashboard";
import { convertPendingBuyPrices } from "@/lib/fx-apply";

export const dynamic = "force-dynamic";

/**
 * The landing page: one screen across every module. It reads the same rows the
 * individual pages read and puts them through lib/dashboard, so a figure here can
 * never drift from the page it links to.
 */
export default async function DashboardPage() {
  const [
    lines,
    supplierInvoices,
    courierInvoices,
    stagedCourier,
    stagedOrders,
    activity,
    mailUpdates,
    recentMail,
  ] = await Promise.all([
    getLines(true), // open and closed: the pipeline and the history
    getSupplierInvoices(),
    getCourierInvoices(),
    getStagedCourierInvoices(),
    getStagedOrders(),
    getRecentActivity(8),
    getUnhandledMailUpdateCounts(),
    getMailUpdates(30),
  ]);

  // Delivered lines priced abroad that are still waiting for the day's rate —
  // checked once the page is on its way, so the next load shows the figure.
  after(() => convertPendingBuyPrices());

  const today = new Date();
  const data = buildDashboard({
    lines,
    supplierInvoices,
    courierInvoices,
    pendingOrders: stagedOrders.length,
    pendingCourierInvoices: stagedCourier.length,
    mailUpdates,
    today,
  });

  return (
    <DashboardView
      data={data}
      activity={activity}
      mailUpdates={recentMail.filter((u) => u.handledAt === null).slice(0, 6)}
      today={today.toISOString().slice(0, 10)}
    />
  );
}
