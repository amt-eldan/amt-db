"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, FileText, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { approveCourierInvoice, rejectStagedCourierInvoice } from "@/app/actions/courier";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { StagedCourierInvoiceRow } from "@/db/queries";
import { allocationsFromShipments, type CourierLineOption } from "@/lib/courier-match";
import { formatDate } from "@/lib/format";
import type { CourierInvoiceDraft } from "@/lib/validation";
import { ShipmentAllocationTable } from "./shipment-allocation-table";

export const COURIER_CURRENCIES = ["ILS", "USD", "EUR"];

export function StagedCourierList({
  items,
  lines,
}: {
  items: StagedCourierInvoiceRow[];
  lines: CourierLineOption[];
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        אין חשבוניות בלדר שממתינות לאישור.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">
        ממתינות לאישור <Badge variant="secondary">{items.length}</Badge>
      </h2>
      {items.map((item) => (
        <StagedCourierCard key={item.id} item={item} lines={lines} />
      ))}
    </div>
  );
}

/**
 * One pending courier invoice. Everything is editable — the extraction is a
 * proposal — and approving is the only way into the ledger: it writes the invoice
 * and the shipping cost of every line in the split together.
 */
function StagedCourierCard({
  item,
  lines,
}: {
  item: StagedCourierInvoiceRow;
  lines: CourierLineOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<CourierInvoiceDraft>(item.payload);
  const [rejecting, setRejecting] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const allocations = allocationsFromShipments(draft.shipments);

  function set<K extends keyof CourierInvoiceDraft>(key: K, value: CourierInvoiceDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function approve() {
    startTransition(async () => {
      const result = await approveCourierInvoice(item.id, draft);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function reject() {
    setRejecting(false);
    startTransition(async () => {
      const result = await rejectStagedCourierInvoice(item.id);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <Card className="border-amber-300/60 bg-amber-50/30 dark:bg-amber-950/10">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FileText className="size-4 text-muted-foreground" />
          <span>{draft.courier || "בלדר לא מזוהה"}</span>
          <span className="text-muted-foreground font-normal">·</span>
          <bdi dir="ltr">{draft.invoiceNumber || "—"}</bdi>
          {item.hasFile && (
            <a
              href={`/api/courier-invoices/staged/${item.id}/file`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-normal underline underline-offset-4"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              צפה במסמך
            </a>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {draft.warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-amber-300/70 bg-amber-100/40 p-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            {draft.warnings.map((warning, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">בלדר</Label>
            <Input value={draft.courier} onChange={(e) => set("courier", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">מספר חשבונית</Label>
            <Input
              dir="ltr"
              value={draft.invoiceNumber}
              onChange={(e) => set("invoiceNumber", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">תאריך חשבונית</Label>
            <Input
              dir="ltr"
              type="date"
              value={draft.invoiceDate ?? ""}
              onChange={(e) => set("invoiceDate", e.target.value || null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">סכום החשבונית</Label>
            <Input
              dir="ltr"
              inputMode="decimal"
              value={draft.amount ?? ""}
              onChange={(e) => set("amount", e.target.value || null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">מטבע</Label>
            <Select value={draft.currency} onValueChange={(v) => set("currency", v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COURIER_CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <ShipmentAllocationTable
          shipments={draft.shipments}
          lines={lines}
          invoiceAmount={draft.amount}
          currency={draft.currency}
          onChange={(shipments) => set("shipments", shipments)}
        />

        <div className="flex flex-col gap-1">
          <Label className="text-xs">הערות</Label>
          <Textarea
            rows={2}
            value={draft.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            נקלט: {formatDate(item.createdAt.toISOString().slice(0, 10))}
            {item.fileName && (
              <>
                {" · "}
                <bdi dir="ltr">{item.fileName}</bdi>
              </>
            )}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="gap-1 text-destructive"
              disabled={pending}
              onClick={() => setRejecting(true)}
            >
              <X className="size-4" />
              דחה
            </Button>
            <Button
              className="gap-1"
              disabled={pending}
              onClick={() => (allocations.length === 0 ? setConfirmEmpty(true) : approve())}
            >
              <Check className="size-4" />
              {pending
                ? "שומר..."
                : allocations.length === 0
                  ? "אשר והוסף למסד"
                  : `אשר ורשום עלות ל-${allocations.length} שורות`}
            </Button>
          </div>
        </div>
      </CardContent>

      <AlertDialog open={rejecting} onOpenChange={setRejecting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>דחיית חשבונית בלדר</AlertDialogTitle>
            <AlertDialogDescription>
              לדחות ולמחוק את חשבונית <bdi dir="ltr">{draft.invoiceNumber}</bdi> מ-{draft.courier}?
              המסמך המצורף יימחק גם הוא, ולא תירשם עלות משלוח. הפעולה אינה הפיכה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={reject}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              דחה ומחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>אישור בלי שיוך לשורות</AlertDialogTitle>
            <AlertDialogDescription>
              אף משלוח לא שויך לשורה עם סכום, ולכן החשבונית תישמר בלי לרשום עלות משלוח — הרווח
              בסיכום החודשי לא יתעדכן. אפשר לשייך עכשיו, או לאשר ולשייך אחר כך דרך עריכת השיוך.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>חזור לשיוך</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmEmpty(false);
                approve();
              }}
            >
              אשר בלי שיוך
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
