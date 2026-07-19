"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MonthlyRow } from "@/db/queries";
import { formatDate, formatILS, formatMonth, formatNumber } from "@/lib/format";
import { lineProfit, lineValue } from "@/lib/profit";
import { cn } from "@/lib/utils";

export function MonthlyView({
  rows,
  months,
  selected,
}: {
  rows: MonthlyRow[];
  months: string[];
  selected: string;
}) {
  const router = useRouter();

  const computed = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        sale: lineValue(row),
        profit: lineProfit(row),
      })),
    [rows],
  );

  const totals = useMemo(() => {
    let sale = 0;
    let profit = 0;
    let pendingCount = 0;
    for (const row of computed) {
      if (row.sale !== null) sale += row.sale;
      if (row.profit === null) pendingCount++;
      else profit += row.profit;
    }
    return { sale, profit, pendingCount };
  }, [computed]);

  function exportCsv() {
    const headers = [
      "לקוח", "מס' הזמנה", "תאריך", "P/N", "ספק", "כמות",
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
        formatDate(row.orderDate),
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
        <h1 className="text-2xl font-bold">סיכום חודשי</h1>
        <div className="flex items-center gap-2">
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
          <Button variant="outline" className="gap-1" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="size-4" />
            ייצוא CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-4">
        <TotalCard label='סה"כ מכירות' value={formatILS(totals.sale)} />
        <TotalCard
          label='סה"כ רווח'
          value={formatILS(totals.profit)}
          sub={totals.pendingCount > 0 ? `${totals.pendingCount} שורות ממתינות למחיר קנייה` : undefined}
          highlight={totals.profit >= 0 ? "positive" : "negative"}
        />
        <TotalCard label="שורות" value={String(rows.length)} className="col-span-2 md:col-span-1" />
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            אין הזמנות בחודש {formatMonth(selected)}.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>לקוח</TableHead>
                  <TableHead>מס' הזמנה</TableHead>
                  <TableHead>תאריך</TableHead>
                  <TableHead>P/N</TableHead>
                  <TableHead>ספק</TableHead>
                  <TableHead>כמות</TableHead>
                  <TableHead>מכירה ליח&apos;</TableHead>
                  <TableHead>קנייה ליח&apos;</TableHead>
                  <TableHead>סך מכירה</TableHead>
                  <TableHead>רווח</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {computed.map((row) => (
                  <TableRow key={row.lineId}>
                    <TableCell>{row.customerName}</TableCell>
                    <TableCell dir="ltr" className="text-end">{row.orderNumber}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      {formatDate(row.orderDate)}
                    </TableCell>
                    <TableCell dir="ltr" className="text-end">{row.pn ?? "—"}</TableCell>
                    <TableCell>{row.supplier ?? "—"}</TableCell>
                    <TableCell dir="ltr" className="text-end">{formatNumber(row.qty)}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">{formatILS(row.unitPrice)}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">{formatILS(row.buyPrice)}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">{formatILS(row.sale)}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      {row.profit === null ? (
                        <Badge variant="outline" className="text-muted-foreground">ממתין</Badge>
                      ) : (
                        <span className={cn(row.profit < 0 && "text-red-600")}>{formatILS(row.profit)}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2">
            {computed.map((row) => (
              <Card key={row.lineId} className="py-3">
                <CardContent className="px-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate" dir="ltr">{row.pn ?? row.orderNumber}</span>
                    {row.profit === null ? (
                      <Badge variant="outline">ממתין</Badge>
                    ) : (
                      <span className={cn("text-sm", row.profit < 0 && "text-red-600")} dir="ltr">
                        {formatILS(row.profit)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{row.customerName}</span>
                    <span dir="ltr" className="text-start">{row.orderNumber}</span>
                    <span>ספק: {row.supplier ?? "—"}</span>
                    <span>מכירה: <bdi dir="ltr">{formatILS(row.sale)}</bdi></span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TotalCard({
  label,
  value,
  sub,
  highlight,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "positive" | "negative";
  className?: string;
}) {
  return (
    <Card className={cn("py-3", className)}>
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
