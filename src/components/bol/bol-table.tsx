"use client";

import { Bot } from "lucide-react";
import { EditButton } from "@/components/lines/edit-button";
import { LateDeliveryBadge } from "@/components/lines/late-delivery-badge";
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
                <TableCell className="align-top">
                  {/* The width lives on a div, not the cell: CSS ignores max-width
                      on a table cell in auto layout, so the text would push the
                      whole table sideways instead of wrapping. */}
                  <div className="w-56">
                    <DeliveryUpdate text={row.deliveryUpdate} />
                  </div>
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
                {row.shipmentStatusText && (
                  <span className="col-span-2 flex gap-1 min-w-0">
                    <span className="shrink-0">המוביל:</span>
                    <span className="min-w-0 flex-1" dir="ltr">
                      <ClampedText text={row.shipmentStatusText} lines="line-clamp-2" />
                    </span>
                  </span>
                )}
                {row.deliveryUpdate && (
                  <span className="col-span-2 flex gap-1 min-w-0">
                    <span className="shrink-0">אספקה:</span>
                    <span className="min-w-0 flex-1">
                      <DeliveryUpdate text={row.deliveryUpdate} />
                    </span>
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
 *
 * "נמסר" is green here for the same reason it is green on the orders screen: it
 * is the one status that means the goods arrived, and two screens disagreeing
 * about what green means is worse than either choice.
 */
function ShipmentStatusBadge({ row }: { row: LineRow }) {
  if (!hasBol(row)) return <span className="text-muted-foreground">—</span>;

  const status = row.shipmentStatus;
  const known = status !== null && status in SHIPMENT_STATUS_LABELS;
  const label = known
    ? SHIPMENT_STATUS_LABELS[status as ShipmentStatus]
    : SHIPMENT_STATUS_UNKNOWN_LABEL;

  return (
    <div className="flex flex-col gap-1 w-44">
      <span className="flex flex-wrap items-center gap-1">
        <Badge
          variant={status === "exception" ? "destructive" : known ? "secondary" : "outline"}
          className={cn(
            "whitespace-nowrap",
            !known && "text-muted-foreground",
            status === "delivered" && "bg-green-500/15 text-green-700 dark:text-green-500",
          )}
        >
          {label}
        </Badge>
        {row.deliveredAt && (
          <span className="text-xs text-muted-foreground" dir="ltr">
            {formatDate(row.deliveredAt)}
          </span>
        )}
        <LateDeliveryBadge line={row} />
      </span>
      {/* What the carrier itself said, under what we made of it. The badge is a
          three-value enum, and "באוויר" does not distinguish a parcel that left
          the warehouse this morning from one held at customs for a week. */}
      {row.shipmentStatusText && (
        <span className="text-xs text-muted-foreground" dir="ltr">
          <ClampedText text={row.shipmentStatusText} lines="line-clamp-2" />
        </span>
      )}
    </div>
  );
}

/**
 * The free-text supply update, in the main table rather than behind the edit
 * sheet — it is what the carrier last said, and reading it is the reason to open
 * this screen. Wraps to at most three lines so one chatty carrier cannot stretch
 * every row, with the full text a click away for the ones that get cut.
 *
 * `break-words` matters: a tracking URL or a long unbroken token has no space to
 * wrap at, and without it the line would overflow its container.
 */
/**
 * Long text in a narrow cell: clamped, with the whole thing one click away.
 *
 * Shared by the human's delivery note and the carrier's own wording — both are
 * free text of unpredictable length in a table that must not scroll sideways.
 */
function ClampedText({ text, lines = "line-clamp-3" }: { text: string; lines?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "block w-full text-start break-words cursor-pointer hover:underline",
          lines,
        )}
      >
        {text}
      </PopoverTrigger>
      <PopoverContent className="w-80 max-h-80 overflow-y-auto text-sm whitespace-pre-wrap break-words">
        {text}
      </PopoverContent>
    </Popover>
  );
}

function DeliveryUpdate({ text }: { text: string | null }) {
  if (!text?.trim()) return <span className="text-muted-foreground">—</span>;
  return <ClampedText text={text} />;
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
