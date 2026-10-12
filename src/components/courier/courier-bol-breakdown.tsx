"use client";

import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BolBreakdown, BolBreakdownRow } from "@/lib/courier-breakdown";
import { downloadCsv, toCsv, type CsvCell } from "@/lib/csv";
import { formatDate, formatILS, formatNumber } from "@/lib/format";

/** A courier amount in its own currency — shekels formatted, anything else labelled. */
function money(value: number | null, currency: string): string {
  if (value === null) return "—";
  return currency === "ILS" ? formatILS(value) : `${formatNumber(value)} ${currency}`;
}

function percent(share: number | null): string {
  return share === null ? "—" : `${(share * 100).toFixed(1)}%`;
}

/** "5975 · Ness-Tech", once per order the waybill's cost landed on. */
function orderLabels(row: BolBreakdownRow): string[] {
  return [...new Set(row.lines.map((l) => `${l.orderNumber} · ${l.customerName}`))];
}

function linesLabel(row: BolBreakdownRow): string {
  return orderLabels(row).join(", ");
}

/**
 * Courier invoices as the courier prints them: the bill of lading first, then the
 * invoice it was billed on, a column per charge item, what the waybill cost, and
 * — last — its proportional part of the whole invoice.
 */
export function CourierBolBreakdown({ breakdown }: { breakdown: BolBreakdown }) {
  const { rows, columns, totals } = breakdown;

  function exportCsv() {
    const headers = [
      "שטר מטען", "בלדר", "מס' חשבונית", "תאריך חשבונית", "תאריך משלוח", "אסמכתא",
      "הזמנות", ...columns.map((c) => c.label), "סה\"כ למשלוח", "מטבע",
      "חלק בחשבונית (%)", "חיוב יחסי מסה\"כ החשבונית",
    ];
    const body: CsvCell[][] = rows.map((row) => [
      row.bol,
      row.courier,
      row.invoiceNumber,
      formatDate(row.invoiceDate),
      formatDate(row.shipmentDate),
      row.reference,
      linesLabel(row),
      ...columns.map((c) => row.charges[c.key]?.toFixed(2) ?? ""),
      row.amount?.toFixed(2),
      row.currency,
      row.share === null ? "" : (row.share * 100).toFixed(2),
      row.relative?.toFixed(2),
    ]);
    downloadCsv("חשבוניות-בלדר-לפי-שטר-מטען.csv", toCsv(headers, body));
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          אין משלוחים להצגה.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          שורה לכל שטר מטען, עמודה לכל סעיף חיוב כפי שמופיע בחשבונית. &quot;חיוב יחסי&quot; הוא חלקו
          של שטר המטען מסה&quot;כ החשבונית — כולל חיובים ברמת החשבונית שאינם שייכים למשלוח אחד.
          {breakdown.foreignRows > 0 && ` ${breakdown.foreignRows} שורות במטבע זר לא נכללו בסיכום.`}
        </p>
        <Button variant="outline" size="sm" className="gap-1" onClick={exportCsv}>
          <Download className="size-4" />
          ייצוא CSV
        </Button>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>שטר מטען</TableHead>
              <TableHead>חשבונית</TableHead>
              <TableHead>הזמנות</TableHead>
              {columns.map((c) => (
                <TableHead key={c.key} className="text-end whitespace-nowrap">
                  {c.label}
                </TableHead>
              ))}
              <TableHead className="text-end whitespace-nowrap">סה&quot;כ למשלוח</TableHead>
              <TableHead className="text-end whitespace-nowrap">חלק בחשבונית</TableHead>
              <TableHead className="text-end whitespace-nowrap">חיוב יחסי</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="whitespace-nowrap">
                  {row.bol ? (
                    <bdi dir="ltr" className="font-medium">{row.bol}</bdi>
                  ) : (
                    <span className="text-muted-foreground">ללא שטר מטען</span>
                  )}
                  {row.shipmentDate && (
                    <span className="block text-xs text-muted-foreground" dir="ltr">
                      {formatDate(row.shipmentDate)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {row.courier} · <bdi dir="ltr">{row.invoiceNumber}</bdi>
                  {row.invoiceDate && (
                    <span className="block text-xs text-muted-foreground" dir="ltr">
                      {formatDate(row.invoiceDate)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs min-w-40 max-w-56 whitespace-normal">
                  {row.lines.length > 0 ? (
                    <ul className="flex flex-col gap-0.5">
                      {orderLabels(row).map((label) => (
                        <li key={label}>{label}</li>
                      ))}
                    </ul>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 border-amber-300 font-normal">
                      לא שויך
                    </Badge>
                  )}
                </TableCell>
                {columns.map((c) => (
                  <TableCell key={c.key} dir="ltr" className="text-end whitespace-nowrap">
                    {row.charges[c.key] === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      money(row.charges[c.key], row.currency)
                    )}
                  </TableCell>
                ))}
                <TableCell dir="ltr" className="text-end whitespace-nowrap font-medium">
                  {money(row.amount, row.currency)}
                </TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap text-muted-foreground">
                  {percent(row.share)}
                </TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap font-medium">
                  {money(row.relative, row.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell colSpan={3} className="font-medium">
                סה&quot;כ ({rows.length - breakdown.foreignRows} שטרי מטען בשקלים)
              </TableCell>
              {columns.map((c) => (
                <TableCell key={c.key} dir="ltr" className="text-end whitespace-nowrap">
                  {totals.charges[c.key] === undefined ? "—" : formatILS(totals.charges[c.key])}
                </TableCell>
              ))}
              <TableCell dir="ltr" className="text-end whitespace-nowrap font-medium">
                {formatILS(totals.amount)}
              </TableCell>
              <TableCell />
              <TableCell dir="ltr" className="text-end whitespace-nowrap font-medium">
                {formatILS(totals.relative)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2">
        {rows.map((row) => (
          <Card key={row.key} className="py-3">
            <CardContent className="px-3 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <bdi dir="ltr" className="font-medium truncate">
                  {row.bol ?? "ללא שטר מטען"}
                </bdi>
                <span className="text-sm whitespace-nowrap" dir="ltr">
                  {money(row.relative ?? row.amount, row.currency)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {row.courier} · <bdi dir="ltr">{row.invoiceNumber}</bdi>
                {row.share !== null && ` · ${percent(row.share)} מהחשבונית`}
              </div>
              {row.lines.length > 0 && <div className="text-xs">{linesLabel(row)}</div>}
              {columns.some((c) => row.charges[c.key] !== undefined) && (
                <ul className="text-xs grid grid-cols-2 gap-x-3">
                  {columns
                    .filter((c) => row.charges[c.key] !== undefined)
                    .map((c) => (
                      <li key={c.key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground truncate">{c.label}</span>
                        <bdi dir="ltr">{money(row.charges[c.key], row.currency)}</bdi>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
