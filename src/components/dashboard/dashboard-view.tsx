import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Bike,
  CircleAlert,
  Clock,
  ReceiptText,
  TriangleAlert,
  TrendingUp,
  Users,
} from "lucide-react";
import { StatusDot } from "@/components/open-orders/status-dot";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActivityRow } from "@/db/queries";
import { activityHref, describeActivity } from "@/lib/activity";
import type { DashboardData, RankedEntry } from "@/lib/dashboard";
import { countLabel, formatDate, formatILS } from "@/lib/format";
import { STATUS_LABELS, type LineStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { TrendChart } from "./trend-chart";

const STATUS_ORDER: LineStatus[] = ["red", "orange", "blue", "green", "neutral"];
const STATUS_FILLS: Record<LineStatus, string> = {
  red: "bg-red-500",
  orange: "bg-orange-400",
  blue: "bg-blue-500",
  green: "bg-green-500",
  neutral: "bg-muted-foreground/30",
};

/**
 * The management view: where the money is, what it turned into last month, and what
 * is waiting for someone. Every figure links to the page that can change it —
 * nothing here is a number you can only look at.
 */
export function DashboardView({
  data,
  activity,
  today,
}: {
  data: DashboardData;
  activity: ActivityRow[];
  today: string;
}) {
  const { open, month, docs } = data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">דשבורד ניהול</h1>
          <p className="text-xs text-muted-foreground">
            תמונת מצב של ההזמנות, החשבוניות והרווחיות · {formatDate(today)}
          </p>
        </div>
        <Link
          href="/orders"
          className="flex items-center gap-1 text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground"
        >
          למסך ההזמנות הפתוחות
          <ArrowLeft className="size-4" />
        </Link>
      </div>

      {/* ---- the four numbers that answer "how are we doing" ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
        <Tile
          label="צבר פתוח"
          value={formatILS(open.value)}
          sub={`${countLabel(open.lines, "שורה אחת", "שורות")} · ${countLabel(open.customers, "לקוח אחד", "לקוחות")}`}
          icon={<TrendingUp className="size-4" />}
          href="/orders"
        />
        <Tile
          label="רווח צפוי בצבר"
          value={formatILS(open.expectedProfit)}
          sub={
            open.expectedProfitLines === open.lines
              ? "כל השורות הפתוחות"
              : `לפי ${countLabel(open.expectedProfitLines, "שורה אחת", "שורות")} שיש בהן מחיר קנייה`
          }
          tone={open.expectedProfit >= 0 ? "positive" : "negative"}
          href="/orders"
        />
        <Tile
          label={`רווח ${month.label}`}
          value={formatILS(month.profit)}
          sub={
            month.margin === null
              ? "אין שורות בחודש"
              : `שיעור רווח ${(month.margin * 100).toFixed(1)}%${
                  month.pending > 0
                    ? ` · ${countLabel(month.pending, "שורה אחת ממתינה", "שורות ממתינות")} למחיר קנייה`
                    : ""
                }`
          }
          tone={month.profit >= 0 ? "positive" : "negative"}
          href={`/monthly?month=${month.ym}`}
        />
        <Tile
          label={`מכירות ${month.label}`}
          value={formatILS(month.sale)}
          sub={`${countLabel(month.lines, "שורה אחת", "שורות")}${
            month.open > 0 ? ` · ${month.open} עוד פתוחות` : ""
          } · משלוח ${formatILS(month.shipping)}`}
          href={`/monthly?month=${month.ym}`}
        />
      </div>

      {month.stale && (
        <p className="text-xs text-muted-foreground">
          החודש המסוכם הוא {month.label} — החודש האחרון שיש בו שורות. בחודש הנוכחי עוד לא נקלטה
          אף הזמנה.
        </p>
      )}

      {/* ---- trend + what needs a human ---- */}
      <div className="grid lg:grid-cols-3 gap-2 md:gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between gap-2">
              <span>מכירות ורווח לפי חודש</span>
              <Link
                href="/monthly"
                className="text-xs font-normal underline underline-offset-4 text-muted-foreground hover:text-foreground"
              >
                פירוט מלא
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart points={data.trend} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">דורש טיפול</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5">
            {data.alerts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                אין פערים פתוחים — הכל מעודכן.
              </p>
            ) : (
              data.alerts.map((alert) => (
                <Link
                  key={alert.id}
                  href={alert.href}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  {alert.tone === "danger" ? (
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-600" />
                  ) : alert.tone === "warning" ? (
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  ) : (
                    <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1">{alert.label}</span>
                  <Badge
                    variant={alert.tone === "danger" ? "destructive" : "secondary"}
                    className="shrink-0"
                  >
                    {alert.count}
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- pipeline health + who we sell to and buy from ---- */}
      <div className="grid lg:grid-cols-3 gap-2 md:gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">מצב השורות הפתוחות</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {open.lines === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                אין שורות פתוחות.
              </p>
            ) : (
              <>
                <div className="flex gap-0.5 h-3" aria-hidden>
                  {STATUS_ORDER.filter((s) => open.byStatus[s] > 0).map((status) => (
                    <div
                      key={status}
                      className={cn("rounded-sm", STATUS_FILLS[status])}
                      style={{ width: `${(open.byStatus[status] / open.lines) * 100}%` }}
                    />
                  ))}
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  {STATUS_ORDER.map((status) => (
                    <Link
                      key={status}
                      href="/orders"
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted"
                    >
                      <StatusDot status={status} />
                      <span className="flex-1 text-muted-foreground">
                        {STATUS_LABELS[status]}
                      </span>
                      <span className="font-medium">{open.byStatus[status]}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <RankedCard
          title="לקוחות לפי צבר פתוח"
          icon={<Users className="size-4" />}
          entries={data.topCustomers}
          emptyText="אין שורות פתוחות."
          oneLabel="שורה אחת"
          manyLabel="שורות"
          href="/orders"
        />

        <RankedCard
          title="ספקים לפי חשבוניות שהתקבלו"
          icon={<ReceiptText className="size-4" />}
          entries={data.topSuppliers}
          emptyText="אין עדיין חשבוניות ספק בשקלים."
          oneLabel="חשבונית אחת"
          manyLabel="חשבוניות"
          href="/invoices"
        />
      </div>

      {/* ---- the documents behind the numbers ---- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-4">
        <Tile
          label="חשבוניות ספק"
          value={formatILS(docs.supplierIls)}
          sub={`${countLabel(docs.supplierCount, "חשבונית אחת", "חשבוניות")}${
            docs.supplierUnlinked > 0 ? ` · ${docs.supplierUnlinked} בלי הזמנה מקושרת` : ""
          }`}
          icon={<ReceiptText className="size-4" />}
          href="/invoices"
        />
        <Tile
          label="חשבוניות בלדר"
          value={formatILS(docs.courierIls)}
          sub={`${countLabel(docs.courierCount, "חשבונית אחת", "חשבוניות")}${
            docs.courierUnallocated > 0 ? ` · ${docs.courierUnallocated} בלי שיוך` : ""
          }`}
          icon={<Bike className="size-4" />}
          href="/courier"
        />
        <Tile
          label="עלות משלוח שנרשמה לשורות"
          value={formatILS(docs.courierAllocated)}
          sub="מתוך חשבוניות הבלדר שאושרו"
          icon={<Bike className="size-4" />}
          href="/courier"
        />
      </div>

      {/* ---- what happened lately ---- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            פעילות אחרונה
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">אין עדיין פעילות.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {activity.map((row) => {
                const href = activityHref(row.entity);
                const text = describeActivity(row.entity, row.action);
                return (
                  <li key={row.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    {href ? (
                      <Link href={href} className="hover:underline underline-offset-4">
                        {text}
                      </Link>
                    ) : (
                      <span>{text}</span>
                    )}
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {row.createdAt.toLocaleString("he-IL", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  icon,
  tone,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  tone?: "positive" | "negative";
  href: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="py-3 h-full transition-colors hover:border-foreground/20">
        <CardContent className="px-4 flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-muted-foreground">{icon}</span>
          </div>
          <p
            dir="ltr"
            className={cn(
              "text-2xl font-bold text-end",
              tone === "positive" && "text-green-700 dark:text-green-500",
              tone === "negative" && "text-red-600",
            )}
          >
            {value}
          </p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * A ranked list as bars: one series, so no legend — the label names it and every
 * bar carries its own value.
 */
function RankedCard({
  title,
  icon,
  entries,
  emptyText,
  oneLabel,
  manyLabel,
  href,
}: {
  title: string;
  icon: React.ReactNode;
  entries: RankedEntry[];
  emptyText: string;
  oneLabel: string;
  manyLabel: string;
  href: string;
}) {
  const max = Math.max(...entries.map((e) => e.value), 1);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">{icon}</span>
            {title}
          </span>
          <Link
            href={href}
            className="text-xs font-normal underline underline-offset-4 text-muted-foreground hover:text-foreground"
          >
            הכל
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.name} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{entry.name}</span>
                  <span className="shrink-0 whitespace-nowrap" dir="ltr">
                    {formatILS(entry.value)}
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {countLabel(entry.count, oneLabel, manyLabel)}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 rounded-sm bg-muted">
                  <div
                    className="h-full rounded-sm bg-foreground/70"
                    style={{ width: `${Math.max(2, (entry.value / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
