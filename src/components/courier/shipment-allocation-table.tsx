"use client";

import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { allocationTotals, type CourierLineOption } from "@/lib/courier-match";
import { formatILS } from "@/lib/format";
import type { CourierShipmentInput } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { LinePicker } from "./line-picker";

const emptyShipment: CourierShipmentInput = {
  bol: null,
  reference: null,
  description: null,
  amount: null,
  lineId: null,
};

/**
 * The split: one row per charge on the invoice, each pointing at the order line it
 * belongs to. This table is the whole approval — what is on screen here is what
 * gets written to `order_lines.shipping_cost`, which is what makes the monthly
 * profit of those lines true.
 *
 * Shared by the pending card and by re-allocating an already approved invoice, so
 * both do the arithmetic the same way.
 */
export function ShipmentAllocationTable({
  shipments,
  lines,
  invoiceAmount,
  currency,
  disabled,
  onChange,
}: {
  shipments: CourierShipmentInput[];
  lines: CourierLineOption[];
  invoiceAmount: string | null;
  currency: string;
  disabled?: boolean;
  onChange: (next: CourierShipmentInput[]) => void;
}) {
  const totals = allocationTotals(shipments, invoiceAmount);
  const byId = new Map(lines.map((l) => [l.lineId, l]));

  function set(index: number, key: keyof CourierShipmentInput, value: string | number | null) {
    onChange(
      shipments.map((s, i) =>
        i === index ? { ...s, [key]: value === "" ? null : value } : s,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" className="font-normal">
          משויך: <bdi dir="ltr" className="font-medium">{formatILS(totals.allocated)}</bdi>
        </Badge>
        <Badge variant="secondary" className="font-normal">
          שורות שיקבלו עלות משלוח: {totals.lines}
        </Badge>
        {totals.unmatched > 0 && (
          <Badge variant="outline" className="font-normal text-amber-600 border-amber-300">
            {totals.unmatched} משלוחים ללא שורה
          </Badge>
        )}
        {totals.difference !== null && Math.abs(totals.difference) >= 0.01 && (
          <span className="flex items-center gap-1 text-amber-600">
            <TriangleAlert className="size-3.5 shrink-0" />
            הפרש מסכום החשבונית: <bdi dir="ltr">{formatILS(totals.difference)}</bdi> (ייתכן שההפרש
            הוא מע&quot;מ)
          </span>
        )}
      </div>

      {currency !== "ILS" && (
        <p className="text-xs text-destructive">
          החשבונית במטבע {currency} — לא ניתן לשייך עלות משלוח שאינה בשקלים. יש להזין את הסכום
          בשקלים לפני אישור.
        </p>
      )}

      <div className="rounded-lg border bg-background overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">שטר מטען</TableHead>
              <TableHead className="w-28">אסמכתא</TableHead>
              <TableHead>תיאור</TableHead>
              <TableHead className="w-24">עלות</TableHead>
              <TableHead className="w-64">שורה בהזמנה</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">
                  אין משלוחים בחשבונית. אפשר להוסיף שורה ולשייך את העלות ידנית.
                </TableCell>
              </TableRow>
            )}
            {shipments.map((shipment, i) => {
              const line = shipment.lineId === null ? null : byId.get(shipment.lineId) ?? null;
              return (
                <TableRow key={i} className={cn(shipment.lineId === null && "bg-amber-50/40 dark:bg-amber-950/10")}>
                  <TableCell>
                    <Input
                      dir="ltr"
                      className="h-8"
                      disabled={disabled}
                      value={shipment.bol ?? ""}
                      onChange={(e) => set(i, "bol", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      dir="ltr"
                      className="h-8"
                      disabled={disabled}
                      value={shipment.reference ?? ""}
                      onChange={(e) => set(i, "reference", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      className="h-8"
                      disabled={disabled}
                      value={shipment.description ?? ""}
                      onChange={(e) => set(i, "description", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      dir="ltr"
                      className="h-8"
                      inputMode="decimal"
                      disabled={disabled}
                      value={shipment.amount ?? ""}
                      onChange={(e) => set(i, "amount", e.target.value)}
                    />
                  </TableCell>
                  <TableCell>
                    <LinePicker
                      lines={lines}
                      value={shipment.lineId}
                      onChange={(lineId) => set(i, "lineId", lineId)}
                    />
                    {line?.shippingCost && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        לשורה רשומה כבר עלות משלוח {formatILS(line.shippingCost)} — היא תחושב מחדש
                        לפי השיוכים
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      disabled={disabled}
                      onClick={() => onChange(shipments.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start gap-1"
        disabled={disabled}
        onClick={() => onChange([...shipments, { ...emptyShipment }])}
      >
        <Plus className="size-3.5" />
        הוסף משלוח
      </Button>
    </div>
  );
}
