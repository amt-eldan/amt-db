"use client";

import { Bot } from "lucide-react";
import { EditButton } from "@/components/lines/edit-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
              <TableHead>עדכון אספקה</TableHead>
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
                <TableCell className="max-w-56 align-top">
                  <DeliveryUpdate text={row.deliveryUpdate} />
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
                {row.deliveryUpdate && (
                  <span className="col-span-2 flex gap-1">
                    <span className="shrink-0">אספקה:</span>
                    <DeliveryUpdate text={row.deliveryUpdate} />
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
 * The normalized shipment status. A line holding a BOL but no readable status
 * reads "לא ידוע" rather than being dressed up as in transit — the normalization
 * exists for filtering, and the carrier's own wording stays reachable in the
 * "עדכון אספקה" column next door.
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
    >
      {label}
    </Badge>
  );
}

/**
 * The free-text supply update, in the main table rather than behind the edit
 * sheet — it is what the carrier last said, and reading it is the reason to open
 * this screen. Clamped to two lines so one chatty carrier cannot stretch every
 * row, with the full text a click away for the ones that get cut.
 */
function DeliveryUpdate({ text }: { text: string | null }) {
  if (!text?.trim()) return <span className="text-muted-foreground">—</span>;

  return (
    <Popover>
      <PopoverTrigger className="text-start line-clamp-2 cursor-pointer hover:underline">
        {text}
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm whitespace-pre-wrap">{text}</PopoverContent>
    </Popover>
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
