import { after } from "next/server";
import { getAvailableMonths, getMonthlyLines } from "@/db/queries";
import { allocatePendingCourierShipments } from "@/lib/courier-allocate";
import { convertPendingBuyPrices } from "@/lib/fx-apply";
import { MonthlyView } from "@/components/monthly/monthly-view";

export const dynamic = "force-dynamic";

export default async function MonthlyPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const months = await getAvailableMonths();
  const now = new Date();
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const selected =
    params.month && /^\d{4}-\d{2}$/.test(params.month)
      ? params.month
      : months[0] ?? currentYm;

  const [year, month] = selected.split("-").map(Number);
  const rows = await getMonthlyLines(year, month);

  // A delivered line priced in dollars, euros or pounds waits for the day's
  // representative rate. Converting it is not this page's job, but this page is
  // where a missing figure is noticed — so the check runs once the page is sent,
  // and the next load shows the shekel amount.
  // Likewise a shipping cost whose courier invoice is in, but whose bill of lading
  // reached the line only afterwards.
  after(async () => {
    await convertPendingBuyPrices();
    await allocatePendingCourierShipments();
  });

  const monthOptions = months.includes(selected) ? months : [selected, ...months];

  return <MonthlyView rows={rows} months={monthOptions} selected={selected} />;
}
