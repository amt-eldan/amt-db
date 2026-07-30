"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EditButton } from "@/components/lines/edit-button";
import type { LineRow } from "@/db/queries";
import { formatDate, formatILS, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A monthly ledger line with its sale value and profit precomputed. */
export type MonthlyComputedRow = LineRow & {
  sale: number | null;
  profit: number | null;
};

export function MonthlySummaryTable({
  rows,
  onEdit,
}: {
  rows: MonthlyComputedRow[];
  onEdit: (row: MonthlyComputedRow) => void;
}) {
  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>לקוח</TableHead>
              <TableHead>מס&apos; הזמנה</TableHead>
              <TableHead>תאריך</TableHead>
              <TableHead>P/N</TableHead>
              <TableHead>ספק</TableHead>
              <TableHead>כמות</TableHead>
              <TableHead>מכירה ליח&apos;</TableHead>
              <TableHead>קנייה ליח&apos;</TableHead>
              <TableHead>סך מכירה</TableHead>
              <TableHead>רווח</TableHead>
              <TableHead className="w-20">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
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
                <TableCell>
                  <EditButton onClick={() => onEdit(row)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2">
        {rows.map((row) => (
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
              <EditButton onClick={() => onEdit(row)} />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
