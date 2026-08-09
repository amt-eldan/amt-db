"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Search, X } from "lucide-react";
import { LineEditSheet } from "@/components/lines/line-edit-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { LineRow } from "@/db/queries";
import { formatDate, formatILS, formatMonth } from "@/lib/format";
import { lineProfit, lineValue } from "@/lib/profit";
import { cn } from "@/lib/utils";
import { MonthlySummaryTable, type MonthlyComputedRow } from "./monthly-summary-table";

export function MonthlyView({
  rows,
  months,
  selected,
}: {
  rows: LineRow[];
  months: string[];
  selected: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<LineRow | null>(null);
  // The ledger used to be closed-lines-only, which hid the running month
  // entirely. Open lines are in by default now; the switch brings back the
  // "finished business" view without changing which months exist.
  const [includeOpen, setIncludeOpen] = useState(true);
  const [search, setSearch] = useState("");

  // The search narrows the ledger itself, not just the table: the totals and the
  // CSV are built from `computed`, so "how much did this customer buy in August"
  // is one query away instead of an export plus a spreadsheet.
  const computed = useMemo<MonthlyComputedRow[]>(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((row) => includeOpen || !row.isOpen)
      .filter(
        (row) =>
          !q ||
          [
            row.customerName,
            row.orderNumber,
            row.pn,
            row.sku,
            row.poNumber,
            row.supplier,
            row.bol,
            row.notes,
          ].some((v) => v?.toLowerCase().includes(q)),
      )
      .map((row) => ({
        ...row,
        sale: lineValue(row),
        profit: lineProfit(row),
      }));
  }, [rows, includeOpen, search]);

  const searching = search.trim() !== "";

  /** Open lines in the month vs. open lines actually on screen — the totals talk
   *  about what is shown, the empty state about what is being hidden. */
  const openInMonth = useMemo(() => rows.filter((r) => r.isOpen).length, [rows]);
  const openShown = useMemo(() => computed.filter((r) => r.isOpen).length, [computed]);

  const totals = useMemo(() => {
    let sale = 0;
    let profit = 0;
    let shipping = 0;
    let pendingCount = 0;
    let missingShipping = 0;
    for (const row of computed) {
      if (row.sale !== null) sale += row.sale;
      if (row.profit === null) pendingCount++;
      else profit += row.profit;
      const rowShipping = row.shippingCost === null ? null : parseFloat(row.shippingCost);
      if (rowShipping !== null && !Number.isNaN(rowShipping)) shipping += rowShipping;
      else missingShipping++;
    }
    return { sale, profit, shipping, pendingCount, missingShipping };
  }, [computed]);

  function exportCsv() {
    const headers = [
      "לקוח", "מס' הזמנה", "תאריך קבלת ההזמנה", "מקור התאריך", "סטטוס", "P/N", "ספק", "כמות",
      "מחיר מכירה ליח'", "מחיר קנייה ליח'", "משלוח", "סך מכירה", "רווח", "שטר מטען", "הערות",
    ];
    const escape = (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = computed.map((row) =>
      [
        row.customerName,
        row.orderNumber,
        formatDate(row.receivedDate),
        row.orderDate === null ? "מועד קליטה" : "מסמך ההזמנה",
        row.isOpen ? "פתוחה" : "סגורה",
        row.pn,
        row.supplier,
        row.qty,
        row.unitPrice,
        row.buyPrice,
        row.shippingCost,
        row.sale?.toFixed(2),
        row.profit === null ? "ממתין" : row.profit.toFixed(2),
        row.bol,
        row.notes,
      ]
        .map(escape)
        .join(","),
    );
    const csv = "﻿" + [headers.join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `סיכום-${selected}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">סיכום חודשי</h1>
          <p className="text-xs text-muted-foreground">
            לפי חודש קבלת ההזמנה מהלקוח
            {includeOpen ? " · כולל שורות פתוחות" : " · שורות סגורות בלבד"}
            {searching && " · הסכומים מסוננים לפי החיפוש"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Switch id="include-open" checked={includeOpen} onCheckedChange={setIncludeOpen} />
            <label htmlFor="include-open" className="text-muted-foreground cursor-pointer">
              כולל פתוחות
            </label>
          </div>
          <Select value={selected} onValueChange={(v) => router.push(`/monthly?month=${v}`)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {formatMonth(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" className="gap-1" onClick={exportCsv} disabled={computed.length === 0}>
            <Download className="size-4" />
            ייצוא CSV
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder={`חיפוש לקוח / מס' הזמנה / P/N / מק"ט / ספק / שטר מטען / הערות...`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ps-9 pe-9"
        />
        {searching && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute end-1 top-1/2 -translate-y-1/2 size-7 text-muted-foreground"
            onClick={() => setSearch("")}
            title="נקה חיפוש"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <TotalCard
          label='סה"כ מכירות'
          value={formatILS(totals.sale)}
          sub={openShown > 0 ? `כולל ${openShown} שורות שעדיין פתוחות` : undefined}
        />
        <TotalCard
          label='סה"כ רווח'
          value={formatILS(totals.profit)}
          sub={totals.pendingCount > 0 ? `${totals.pendingCount} שורות ממתינות למחיר קנייה` : undefined}
          highlight={totals.profit >= 0 ? "positive" : "negative"}
        />
        <TotalCard
          label="עלות משלוח"
          value={formatILS(totals.shipping)}
          sub={
            totals.missingShipping > 0
              ? `${totals.missingShipping} שורות בלי עלות משלוח`
              : undefined
          }
        />
        <TotalCard label="שורות" value={String(computed.length)} />
      </div>

      {computed.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {searching
              ? `לא נמצאו שורות התואמות לחיפוש בחודש ${formatMonth(selected)}.`
              : includeOpen
                ? `אין שורות בחודש ${formatMonth(selected)}.`
                : `אין שורות סגורות בחודש ${formatMonth(selected)}${
                    openInMonth > 0 ? ` (${openInMonth} שורות פתוחות מוסתרות)` : ""
                  }.`}
          </CardContent>
        </Card>
      ) : (
        <MonthlySummaryTable rows={computed} onEdit={setEditing} />
      )}

      <LineEditSheet line={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function TotalCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "positive" | "negative";
}) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p
          dir="ltr"
          className={cn(
            "text-xl font-bold text-end",
            highlight === "positive" && "text-green-700",
            highlight === "negative" && "text-red-600",
          )}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-xs text-amber-600 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
