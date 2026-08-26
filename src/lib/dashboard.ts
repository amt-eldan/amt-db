/**
 * Everything the management dashboard shows, computed from rows the pages already
 * load. Pure on purpose: the numbers a manager acts on are exactly the ones worth
 * unit-testing, and none of them need a database to be checked.
 *
 * Definitions follow the pages they summarize, so a figure here never disagrees
 * with the screen it links to: profit uses lib/profit, status uses lib/status, and
 * a month is a month of *received dates* over *every* line — open and closed
 * alike — which is the cut /monthly makes and the page these cards link to.
 *
 * That alignment used to be claimed here and not implemented, and it hid a whole
 * month: totals were summed over closed lines only, keyed on `order_date`. So a
 * month whose orders had all arrived but none had been closed read as zero, and a
 * line on an order with no explicit `order_date` (the column is nullable, and
 * intake often leaves it so) was dropped from every month at once. Both are why
 * the trend showed an empty August while /monthly listed August's rows.
 */
import { hasBol } from "./bol";
import { HEBREW_MONTHS } from "./format";
import { lineProfit, lineValue } from "./profit";
import { lineStatus, type LineStatus } from "./status";

/** The line fields the dashboard reads — LineRow satisfies this. */
export interface DashboardLine {
  lineId: number;
  orderNumber: string;
  customerName: string;
  supplier: string | null;
  qty: string | null;
  unitPrice: string | null;
  buyPrice: string | null;
  shippingCost: string | null;
  orderDate: string | null;
  /**
   * The month a line belongs to, already coalesced by the query
   * (`coalesce(order_date, created_at)`) so it is never null — unlike orderDate,
   * which is why it and not orderDate decides the month here.
   */
  receivedDate: string;
  contractDueDate: string | null;
  bol: string | null;
  bolSource: string | null;
  bolConfidence: string | null;
  shipmentStatus: string | null;
  deliveryUpdate: string | null;
  notes: string | null;
  manualStatus: string | null;
  isOpen: boolean;
}

export interface DashboardSupplierInvoice {
  supplier: string;
  amount: string | null;
  currency: string;
  orderId: number | null;
}

export interface DashboardCourierInvoice {
  courier: string;
  amount: string | null;
  currency: string;
  allocatedTotal: string | null;
  allocatedLines: number;
}

export interface DashboardInput {
  lines: DashboardLine[];
  supplierInvoices: DashboardSupplierInvoice[];
  courierInvoices: DashboardCourierInvoice[];
  pendingOrders: number;
  pendingCourierInvoices: number;
  today?: Date;
}

export interface MonthPoint {
  ym: string; // yyyy-mm
  label: string; // "יוני"
  sale: number;
  profit: number;
  lines: number;
  /** Lines whose profit is unknown (no buy price) — the bar understates by these. */
  pending: number;
  /** Still-open lines among them, so a month in progress is not read as final. */
  open: number;
}

export interface RankedEntry {
  name: string;
  value: number;
  count: number;
}

export type AlertTone = "danger" | "warning" | "info";

export interface DashboardAlert {
  id: string;
  label: string;
  count: number;
  href: string;
  tone: AlertTone;
}

export interface DashboardData {
  open: {
    lines: number;
    value: number;
    customers: number;
    /** Expected profit over the open lines that already have a buy price. */
    expectedProfit: number;
    expectedProfitLines: number;
    byStatus: Record<LineStatus, number>;
  };
  month: {
    ym: string;
    label: string; // "יוני 2026"
    sale: number;
    profit: number;
    shipping: number;
    margin: number | null;
    lines: number;
    pending: number;
    /** Still-open lines in the month — the sale total is booked, not all realized. */
    open: number;
    /** True when the headline month is not the current calendar month. */
    stale: boolean;
  };
  trend: MonthPoint[];
  alerts: DashboardAlert[];
  topCustomers: RankedEntry[];
  topSuppliers: RankedEntry[];
  docs: {
    supplierCount: number;
    supplierIls: number;
    supplierUnlinked: number;
    courierCount: number;
    courierIls: number;
    courierAllocated: number;
    courierUnallocated: number;
    foreignCurrency: number;
  };
}

const TREND_MONTHS = 6;
/** Below this, an auto-filled bill of lading is a guess worth reviewing. */
const LOW_CONFIDENCE = 0.8;

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Money adds up in agorot, so a total of many lines does not drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ymOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [, m] = ym.split("-");
  return HEBREW_MONTHS[Number(m) - 1] ?? ym;
}

/** The six months ending with `today`, oldest first. */
function recentMonths(today: Date): string[] {
  const months: string[] = [];
  for (let back = TREND_MONTHS - 1; back >= 0; back--) {
    months.push(ymOf(new Date(today.getFullYear(), today.getMonth() - back, 1)));
  }
  return months;
}

function rank(totals: Map<string, { value: number; count: number }>, limit: number): RankedEntry[] {
  return [...totals.entries()]
    .map(([name, t]) => ({ name, value: round2(t.value), count: t.count }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "he"))
    .slice(0, limit);
}

export function buildDashboard(input: DashboardInput): DashboardData {
  const today = input.today ?? new Date();
  const { lines, supplierInvoices, courierInvoices } = input;

  // --- open pipeline -------------------------------------------------------
  const byStatus: Record<LineStatus, number> = { green: 0, blue: 0, orange: 0, red: 0, neutral: 0 };
  const openCustomers = new Set<string>();
  const customerTotals = new Map<string, { value: number; count: number }>();
  let openLines = 0;
  let openValue = 0;
  let expectedProfit = 0;
  let expectedProfitLines = 0;
  let missingBol = 0;
  let lowConfidenceBol = 0;

  // --- every line, grouped by the month it came in -------------------------
  type MonthTotals = {
    sale: number;
    profit: number;
    shipping: number;
    lines: number;
    pending: number;
    open: number;
  };
  const emptyMonth = (): MonthTotals => ({
    sale: 0,
    profit: 0,
    shipping: 0,
    lines: 0,
    pending: 0,
    open: 0,
  });
  const monthTotals = new Map<string, MonthTotals>();
  let closedMissingBuyPrice = 0;
  let closedMissingShipping = 0;

  for (const line of lines) {
    const value = lineValue(line) ?? 0;
    const profit = lineProfit(line);

    // The month cut, for open and closed lines alike: a month is "what came in",
    // so an order received in August counts in August while it is still in the
    // air. Profit only adds up over lines that have one — the rest raise
    // `pending`, exactly as /monthly shows them as "ממתין".
    const ym = (line.receivedDate ?? line.orderDate)?.slice(0, 7) ?? null;
    if (ym) {
      const entry = monthTotals.get(ym) ?? emptyMonth();
      entry.sale += value;
      entry.lines++;
      if (line.isOpen) entry.open++;
      if (profit === null) entry.pending++;
      else entry.profit += profit;
      entry.shipping += num(line.shippingCost) ?? 0;
      monthTotals.set(ym, entry);
    }

    if (line.isOpen) {
      openLines++;
      openValue += value;
      openCustomers.add(line.customerName);
      const entry = customerTotals.get(line.customerName) ?? { value: 0, count: 0 };
      entry.value += value;
      entry.count++;
      customerTotals.set(line.customerName, entry);

      byStatus[lineStatus(line, today)]++;
      // Same rule as the BOL worklist: a line marked "arrived" by hand needs no
      // tracking number, so it is not a gap.
      if (!hasBol(line) && line.manualStatus !== "הגיע") missingBol++;
      if (profit !== null) {
        expectedProfit += profit;
        expectedProfitLines++;
      }
    } else {
      if (num(line.buyPrice) === null) closedMissingBuyPrice++;
      if (num(line.shippingCost) === null) closedMissingShipping++;
    }

    if (line.bolSource === "auto") {
      const confidence = num(line.bolConfidence);
      if (confidence !== null && confidence < LOW_CONFIDENCE) lowConfidenceBol++;
    }
  }

  // --- headline month: the latest one that has lines ----------------------
  // Never a future one. A contract can be dated ahead, and a headline card for a
  // month that has not happened would push the month being worked on off screen.
  const currentYm = ymOf(today);
  const headlineYm =
    [...monthTotals.keys()]
      .filter((ym) => ym <= currentYm)
      .sort()
      .reverse()[0] ?? currentYm;
  const headline = monthTotals.get(headlineYm) ?? emptyMonth();

  const trend: MonthPoint[] = recentMonths(today).map((ym) => {
    const entry = monthTotals.get(ym);
    return {
      ym,
      label: monthLabel(ym),
      sale: round2(entry?.sale ?? 0),
      profit: round2(entry?.profit ?? 0),
      lines: entry?.lines ?? 0,
      pending: entry?.pending ?? 0,
      open: entry?.open ?? 0,
    };
  });

  // --- documents -----------------------------------------------------------
  const supplierTotals = new Map<string, { value: number; count: number }>();
  let supplierIls = 0;
  let supplierUnlinked = 0;
  let foreignCurrency = 0;
  for (const invoice of supplierInvoices) {
    const amount = num(invoice.amount);
    if (invoice.currency === "ILS") {
      if (amount !== null) {
        supplierIls += amount;
        const entry = supplierTotals.get(invoice.supplier) ?? { value: 0, count: 0 };
        entry.value += amount;
        entry.count++;
        supplierTotals.set(invoice.supplier, entry);
      }
    } else {
      foreignCurrency++;
    }
    if (invoice.orderId === null) supplierUnlinked++;
  }

  let courierIls = 0;
  let courierAllocated = 0;
  let courierUnallocated = 0;
  for (const invoice of courierInvoices) {
    const amount = num(invoice.amount);
    if (invoice.currency === "ILS") {
      if (amount !== null) courierIls += amount;
    } else {
      foreignCurrency++;
    }
    courierAllocated += num(invoice.allocatedTotal) ?? 0;
    if (invoice.allocatedLines === 0) courierUnallocated++;
  }

  // --- what needs a human, most urgent first ------------------------------
  const alerts: DashboardAlert[] = [
    {
      id: "late",
      label: "שורות פתוחות שעבר תאריך האספקה החוזי",
      count: byStatus.red,
      href: "/orders",
      tone: "danger",
    },
    {
      id: "staged-orders",
      label: "הזמנות סרוקות ממתינות לאישור",
      count: input.pendingOrders,
      href: "/intake",
      tone: "warning",
    },
    {
      id: "staged-courier",
      label: "חשבוניות בלדר ממתינות לאישור",
      count: input.pendingCourierInvoices,
      href: "/courier",
      tone: "warning",
    },
    {
      id: "missing-bol",
      label: "שורות פתוחות בלי שטר מטען",
      count: missingBol,
      href: "/bol",
      tone: "warning",
    },
    {
      id: "missing-buy-price",
      label: "שורות סגורות בלי מחיר קנייה — הרווח שלהן לא נכנס לסיכום",
      count: closedMissingBuyPrice,
      href: "/monthly",
      tone: "warning",
    },
    {
      id: "courier-unallocated",
      label: "חשבוניות בלדר שלא שויכו לשורות",
      count: courierUnallocated,
      href: "/courier",
      tone: "warning",
    },
    {
      id: "low-confidence-bol",
      label: "שטרי מטען שמולאו אוטומטית בוודאות נמוכה",
      count: lowConfidenceBol,
      href: "/bol",
      tone: "warning",
    },
    {
      id: "missing-shipping",
      label: "שורות סגורות בלי עלות משלוח",
      count: closedMissingShipping,
      href: "/courier",
      tone: "info",
    },
    {
      id: "supplier-unlinked",
      label: "חשבוניות ספק בלי הזמנה מקושרת",
      count: supplierUnlinked,
      href: "/invoices",
      tone: "info",
    },
    {
      id: "foreign-currency",
      label: 'חשבוניות במטבע זר שלא נכללות בסכומים בש"ח',
      count: foreignCurrency,
      href: "/invoices",
      tone: "info",
    },
  ];
  const toneOrder: Record<AlertTone, number> = { danger: 0, warning: 1, info: 2 };

  return {
    open: {
      lines: openLines,
      value: round2(openValue),
      customers: openCustomers.size,
      expectedProfit: round2(expectedProfit),
      expectedProfitLines,
      byStatus,
    },
    month: {
      ym: headlineYm,
      label: `${monthLabel(headlineYm)} ${headlineYm.slice(0, 4)}`,
      sale: round2(headline.sale),
      profit: round2(headline.profit),
      shipping: round2(headline.shipping),
      margin: headline.sale > 0 ? headline.profit / headline.sale : null,
      lines: headline.lines,
      pending: headline.pending,
      open: headline.open,
      stale: headlineYm !== currentYm,
    },
    trend,
    alerts: alerts
      .filter((a) => a.count > 0)
      .sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone] || b.count - a.count),
    topCustomers: rank(customerTotals, 5),
    topSuppliers: rank(supplierTotals, 5),
    docs: {
      supplierCount: supplierInvoices.length,
      supplierIls: round2(supplierIls),
      supplierUnlinked,
      courierCount: courierInvoices.length,
      courierIls: round2(courierIls),
      courierAllocated: round2(courierAllocated),
      courierUnallocated,
      foreignCurrency,
    },
  };
}
