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
import { LateDeliveryBadge } from "@/components/lines/late-delivery-badge";
import { ReceivedDate } from "@/components/lines/received-date";
import type { LineRow } from "@/db/queries";
import { formatDate, formatILS, formatNumber, formatUSD } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, asShipmentStatus } from "@/lib/shipment-status";
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
              <TableHead>תאריך קבלת ההזמנה</TableHead>
              <TableHead>P/N</TableHead>
              <TableHead>ספק</TableHead>
              <TableHead>הזמנת רכש</TableHead>
              <TableHead>שטר מטען</TableHead>
              <TableHead>מסירה</TableHead>
              <TableHead>כמות</TableHead>
              <TableHead>מכירה ליח&apos;</TableHead>
              <TableHead>קנייה ליח&apos;</TableHead>
              <TableHead>משלוח</TableHead>
              <TableHead>סך מכירה</TableHead>
              <TableHead>רווח</TableHead>
              <TableHead className="w-20">פעולות</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.lineId}>
                <TableCell>{row.customerName}</TableCell>
                <TableCell dir="ltr" className="text-end">
                  {row.orderNumber}
                  {row.isOpen && (
                    <Badge variant="outline" className="ms-1 text-amber-600">
                      פתוחה
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <ReceivedDate line={row} />
                </TableCell>
                <TableCell dir="ltr" className="text-end">{row.pn ?? "—"}</TableCell>
                <TableCell>{row.supplier ?? "—"}</TableCell>
                <TableCell dir="ltr" className="text-end">{row.poNumber ?? "—"}</TableCell>
                <TableCell className="max-w-36">
                  <BolCell row={row} />
                </TableCell>
                <TableCell>
                  <DeliveryCell row={row} />
                </TableCell>
                <TableCell dir="ltr" className="text-end">{formatNumber(row.qty)}</TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap">{formatILS(row.unitPrice)}</TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap">
                  <BuyPriceCell row={row} />
                </TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap">
                  {row.shippingCost ? (
                    formatILS(row.shippingCost)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
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
                {row.isOpen && (
                  <Badge variant="outline" className="text-amber-600">
                    פתוחה
                  </Badge>
                )}
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
                <span className="col-span-2">
                  התקבלה: <bdi dir="ltr">{formatDate(row.receivedDate)}</bdi>
                  {row.orderDate === null && " (לפי קליטה)"}
                </span>
                <span>ספק: {row.supplier ?? "—"}</span>
                <span>מכירה: <bdi dir="ltr">{formatILS(row.sale)}</bdi></span>
                <span>
                  משלוח: <bdi dir="ltr">{row.shippingCost ? formatILS(row.shippingCost) : "—"}</bdi>
                </span>
                {row.poNumber && <span>רכש: <bdi dir="ltr">{row.poNumber}</bdi></span>}
                <span>
                  קנייה: <bdi dir="ltr">{formatILS(row.buyPrice)}</bdi>
                  {row.buyPriceUsd && (
                    <bdi dir="ltr"> ({formatUSD(row.buyPriceUsd)}
                    {row.fxRate && ` × ${formatNumber(row.fxRate)}`})</bdi>
                  )}
                </span>
                {row.bol?.trim() && (
                  <span className="col-span-2">
                    שטר מטען: <bdi dir="ltr">{row.bol}</bdi>
                    {row.carrier && ` · ${row.carrier}`}
                  </span>
                )}
                {(row.shipmentStatus || row.deliveredAt) && (
                  <span className="col-span-2 flex flex-wrap items-center gap-1.5">
                    מסירה: <DeliveryCell row={row} />
                  </span>
                )}
              </div>
              <EditButton onClick={() => onEdit(row)} />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

/**
 * Purchase order price the way it has to be read: the shekel figure everything is
 * summed from, and underneath it where that figure came from — the dollar amount
 * on the purchase order, the representative rate, and the day that rate was
 * published.
 *
 * Showing the provenance is the point. The conversion happened once, when the
 * shipment was delivered, and this is what lets someone check it a month later
 * instead of wondering which rate was used.
 */
function BuyPriceCell({ row }: { row: MonthlyComputedRow }) {
  if (!row.buyPriceUsd) return <>{formatILS(row.buyPrice)}</>;
  return (
    <span className="flex flex-col items-end leading-tight">
      <span>{formatILS(row.buyPrice)}</span>
      <span className="text-xs text-muted-foreground">
        {formatUSD(row.buyPriceUsd)}
        {row.fxRate && ` × ${formatNumber(row.fxRate)}`}
        {row.fxRateDate && ` (${formatDate(row.fxRateDate)})`}
      </span>
      {row.buyPrice === null && (
        <span className="text-xs text-amber-600">ממתין לשער</span>
      )}
    </span>
  );
}

/**
 * Wraps inside its own cell rather than pushing the table sideways — a long
 * tracking number and a carrier name are not worth a horizontal scrollbar across
 * eleven other columns.
 */
function BolCell({ row }: { row: MonthlyComputedRow }) {
  if (!row.bol?.trim()) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col items-start gap-0.5 leading-tight">
      <bdi dir="ltr" className="break-all text-xs">
        {row.bol}
      </bdi>
      {row.carrier && <span className="text-xs text-muted-foreground">{row.carrier}</span>}
    </span>
  );
}

/** What the carrier said, and when the goods actually landed. */
function DeliveryCell({ row }: { row: MonthlyComputedRow }) {
  const status = asShipmentStatus(row.shipmentStatus);
  if (!status && !row.deliveredAt) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {status && (
        <Badge
          variant={status === "exception" ? "destructive" : "secondary"}
          className={cn(
            "whitespace-nowrap",
            status === "delivered" && "bg-green-500/15 text-green-700 dark:text-green-500",
          )}
        >
          {SHIPMENT_STATUS_LABELS[status]}
        </Badge>
      )}
      {row.deliveredAt && (
        <bdi dir="ltr" className="text-xs text-muted-foreground">
          {formatDate(row.deliveredAt)}
        </bdi>
      )}
      <LateDeliveryBadge line={row} />
    </span>
  );
}
