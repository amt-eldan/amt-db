"use client";

import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  chargeTolerance,
  chargeTotals,
  type CourierChargeKind,
  type CourierShipment,
} from "@/lib/courier-match";
import { formatILS } from "@/lib/format";
import type { CourierChargeInput } from "@/lib/validation";

/** What each kind is called on screen, and the order the picker offers them in. */
const CHARGE_KINDS: { value: CourierChargeKind; label: string }[] = [
  { value: "service", label: "שירות / שילוח" },
  { value: "tax", label: "מיסי יבוא ומכס" },
  { value: "fee", label: "אגרה / דמי טיפול" },
  { value: "vat", label: 'מע"מ' },
  { value: "discount", label: "הנחה / זיכוי" },
  { value: "other", label: "אחר" },
];

const KIND_LABELS = new Map(CHARGE_KINDS.map((k) => [k.value, k.label]));

const emptyCharge: CourierChargeInput = { label: "", amount: null, kind: "other" };

/** One line of the collapsed summary: "אגרת מחשב למכס 21.00 · מע"מ 12.78 · ...". */
export function ChargeSummary({ shipment }: { shipment: CourierShipment }) {
  const totals = chargeTotals(shipment, chargeTolerance(shipment.charges));
  if (shipment.charges.length === 0) return null;
  return (
    <span className="text-[11px] text-muted-foreground">
      {shipment.charges.length} חיובים
      {totals.sum !== null && (
        <>
          {" · "}
          <bdi dir="ltr">{formatILS(totals.sum)}</bdi>
        </>
      )}
      {totals.vat !== 0 && (
        <>
          {' · מע"מ '}
          <bdi dir="ltr">{formatILS(totals.vat)}</bdi>
        </>
      )}
      {totals.difference !== null && totals.difference !== 0 && (
        <span className="text-amber-600"> · לא מסתכם</span>
      )}
    </span>
  );
}

/**
 * The breakdown behind one shipment's cost: the customs fees, the clearance
 * service, the VAT — whatever the courier itemized. Editable, because the
 * extraction is a proposal like everything else on the approval card, and because
 * a shipment whose total was never printed gets it from these rows (see
 * `shipmentTotal`).
 *
 * Nothing here is allocated on its own — the money that reaches an order line is
 * still the shipment's total. What these rows buy is an answer to "why 531.78?".
 */
export function ShipmentChargesEditor({
  shipment,
  disabled,
  onChange,
}: {
  shipment: CourierShipment;
  disabled?: boolean;
  onChange: (next: CourierChargeInput[]) => void;
}) {
  const charges = shipment.charges;
  const totals = chargeTotals(shipment, chargeTolerance(charges));

  function set(index: number, patch: Partial<CourierChargeInput>) {
    onChange(charges.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium">פירוט החיובים</span>
        {totals.sum !== null && (
          <span className="text-muted-foreground">
            סכום הפירוט: <bdi dir="ltr">{formatILS(totals.sum)}</bdi>
          </span>
        )}
        {totals.vat !== 0 && (
          <span className="text-muted-foreground">
            מתוכו מע&quot;מ: <bdi dir="ltr">{formatILS(totals.vat)}</bdi>
          </span>
        )}
        {totals.difference !== null && totals.difference !== 0 && (
          <span className="flex items-center gap-1 text-amber-600">
            <TriangleAlert className="size-3.5 shrink-0" />
            הפרש מעלות המשלוח: <bdi dir="ltr">{formatILS(totals.difference)}</bdi>
          </span>
        )}
        {totals.missing > 0 && (
          <span className="text-amber-600">
            {totals.missing === 1 ? "חיוב אחד ללא סכום" : `${totals.missing} חיובים ללא סכום`}
          </span>
        )}
      </div>

      {charges.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          החשבונית לא פירטה ממה מורכבת עלות המשלוח. אפשר להוסיף את המרכיבים ידנית.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {charges.map((charge, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <Input
                className="h-8 flex-1"
                placeholder="תיאור החיוב"
                disabled={disabled}
                value={charge.label}
                onChange={(e) => set(i, { label: e.target.value })}
              />
              <Input
                dir="ltr"
                className="h-8 w-24"
                inputMode="decimal"
                disabled={disabled}
                value={charge.amount ?? ""}
                onChange={(e) => set(i, { amount: e.target.value === "" ? null : e.target.value })}
              />
              <Select
                value={charge.kind}
                disabled={disabled}
                onValueChange={(v) => set(i, { kind: v as CourierChargeKind })}
              >
                <SelectTrigger className="w-36 shrink-0">
                  <SelectValue placeholder={KIND_LABELS.get(charge.kind)} />
                </SelectTrigger>
                <SelectContent>
                  {CHARGE_KINDS.map((kind) => (
                    <SelectItem key={kind.value} value={kind.value}>
                      {kind.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                disabled={disabled}
                onClick={() => onChange(charges.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 self-start gap-1 text-xs"
        disabled={disabled}
        onClick={() => onChange([...charges, { ...emptyCharge }])}
      >
        <Plus className="size-3" />
        הוסף חיוב
      </Button>
    </div>
  );
}
