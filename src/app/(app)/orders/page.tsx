import { getLineSet, getOpenStatusRows } from "@/db/queries";
import { OpenOrdersView } from "@/components/open-orders/open-orders-view";
import { isGmailConfigured } from "@/lib/gmail";
import { lineStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function OpenOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const params = await searchParams;
  const showArchived = params.archived === "1";

  // Only the set that is actually on screen, plus the narrow row set behind the
  // header cards — which always count open lines, including while the archive is
  // being viewed. The archive is in the URL so the view survives a refresh and
  // can be linked to.
  const [lines, openRows] = await Promise.all([getLineSet(showArchived), getOpenStatusRows()]);

  const stats = {
    open: openRows.length,
    customers: new Set(openRows.map((r) => r.customerName)).size,
    late: openRows.filter((r) => lineStatus(r) === "red").length,
  };

  return (
    <OpenOrdersView
      lines={lines}
      stats={stats}
      showArchived={showArchived}
      // Read here rather than in the client component: the mailbox credentials
      // are server-only, and the button needs to know whether it can work at all
      // without any of them crossing to the browser.
      gmailConfigured={isGmailConfigured()}
    />
  );
}
