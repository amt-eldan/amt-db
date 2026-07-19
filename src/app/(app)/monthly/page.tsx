import { getAvailableMonths, getMonthlyLines } from "@/db/queries";
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

  const monthOptions = months.includes(selected) ? months : [selected, ...months];

  return <MonthlyView rows={rows} months={monthOptions} selected={selected} />;
}
