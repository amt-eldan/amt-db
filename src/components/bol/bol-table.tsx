"use client";

import { Bot } from "lucide-react";
import { EditButton } from "@/components/lines/edit-button";
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
import type { LineRow } from "@/db/queries";
import { hasBol } from "@/lib/bol";
import { cn } from "@/lib/utils";
import { formatDate, formatTimestamp } from "@/lib/format";
import {
  SHIPMENT_STATUS_LABELS,
  SHIPMENT_STATUS_UNKNOWN_LABEL,
  type ShipmentStatus,
} from "@/lib/shipment-status";

export function BolTable({
  rows,
  onEdit,
}: {
  rows: LineRow[];
  onEdit: (row: LineRow) => void;
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
              <TableHead>שטר מטען</TableHead>
              <TableHead>חברת הובלה</TableHead>
              <TableHead>סטטוס משלוח</TableHead>
              <TableHead>צפי הגעה</TableHead>
              <TableHead>מקור</TableHead>
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
                <TableCell>
                  {hasBol(row) ? (
                    <Badge variant="secondary" dir="ltr" className="max-w-40 truncate">
                      {row.bol}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-600">חסר</Badge>
                  )}
                </TableCell>
                <TableCell>{row.carrier ?? "—"}</TableCell>
                <TableCell>
                  <ShipmentStatusBadge row={row} />
                </TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap">
                  {formatDate(row.shipmentEta)}
                </TableCell>
                <TableCell>
                  <BolSource row={row} />
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
                {hasBol(row) ? (
                  <Badge variant="secondary" dir="ltr" className="max-w-40 truncate">
                    {row.bol}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-amber-600">חסר</Badge>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{row.customerName}</span>
                <span dir="ltr" className="text-start">{row.orderNumber}</span>
                <span>ספק: {row.supplier ?? "—"}</span>
                <span>הובלה: {row.carrier ?? "—"}</span>
                <span>
                  צפי: <bdi dir="ltr">{formatDate(row.shipmentEta)}</bdi>
                </span>
                {row.shipmentStatusAt && (
                  <span className="col-span-2">
                    עדכון: <bdi dir="ltr">{formatTimestamp(row.shipmentStatusAt)}</bdi>
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <EditButton onClick={() => onEdit(row)} />
                <div className="flex items-center gap-2">
                  <ShipmentStatusBadge row={row} />
                  <BolSource row={row} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

/**
 * The normalized shipment status, with the carrier's own wording as the tooltip.
 * A line holding a BOL but no readable status reads "לא ידוע" rather than being
 * dressed up as in transit — the normalization exists for filtering, so the raw
 * text has to stay reachable.
 */
function ShipmentStatusBadge({ row }: { row: LineRow }) {
  if (!hasBol(row)) return <span className="text-muted-foreground">—</span>;

  const status = row.shipmentStatus;
  const known = status !== null && status in SHIPMENT_STATUS_LABELS;
  const label = known
    ? SHIPMENT_STATUS_LABELS[status as ShipmentStatus]
    : SHIPMENT_STATUS_UNKNOWN_LABEL;

  return (
    <Badge
      variant={status === "exception" ? "destructive" : known ? "secondary" : "outline"}
      className={cn("whitespace-nowrap", !known && "text-muted-foreground")}
      title={row.deliveryUpdate ?? undefined}
    >
      {label}
    </Badge>
  );
}

function BolSource({ row }: { row: LineRow }) {
  if (!hasBol(row)) return <span className="text-muted-foreground">—</span>;
  if (row.bolSource === "auto") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
        <Bot className="size-3.5 shrink-0" />
        אוטומטי
        {row.bolConfidence && ` (${row.bolConfidence})`}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">ידני</span>;
}
