"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createStagedCourierInvoice, updateCourierInvoice } from "@/app/actions/courier";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { CourierInvoiceRow } from "@/db/queries";
import { COURIER_CURRENCIES } from "./staged-courier-list";

/**
 * One sheet for two jobs, because the fields are identical:
 * - new invoice → a *pending* row, so a hand-typed invoice goes through the same
 *   approval (and the same "which lines did this ship?" question) as an uploaded one.
 * - editing an approved invoice → header only; the split has its own sheet.
 */
export function CourierInvoiceFormSheet({
  open,
  invoice,
  onClose,
}: {
  open: boolean;
  invoice: CourierInvoiceRow | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto">
        {open && <CourierInvoiceForm key={invoice?.id ?? "new"} invoice={invoice} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function CourierInvoiceForm({
  invoice,
  onClose,
}: {
  invoice: CourierInvoiceRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    courier: invoice?.courier ?? "",
    invoiceNumber: invoice?.invoiceNumber ?? "",
    invoiceDate: invoice?.invoiceDate ?? "",
    amount: invoice?.amount ?? "",
    currency: invoice?.currency ?? "ILS",
    notes: invoice?.notes ?? "",
  });

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    startTransition(async () => {
      const result = invoice
        ? await updateCourierInvoice({ ...form, id: invoice.id })
        : await createStagedCourierInvoice({ ...form, shipments: [], warnings: [] });
      if (result.ok) {
        toast.success(result.message);
        onClose();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{invoice ? "עריכת חשבונית בלדר" : "חשבונית בלדר חדשה"}</SheetTitle>
        <SheetDescription>
          {invoice
            ? `${invoice.courier} · ${invoice.invoiceNumber}`
            : "החשבונית תיכנס לרשימת ההמתנה; שיוך המשלוחים לשורות נעשה באישור."}
        </SheetDescription>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-3 px-4 pb-4">
        <Field label="בלדר" full>
          <Input value={form.courier} onChange={(e) => set("courier", e.target.value)} />
        </Field>
        <Field label="מספר חשבונית">
          <Input
            dir="ltr"
            value={form.invoiceNumber}
            onChange={(e) => set("invoiceNumber", e.target.value)}
          />
        </Field>
        <Field label="תאריך חשבונית">
          <Input
            dir="ltr"
            type="date"
            value={form.invoiceDate}
            onChange={(e) => set("invoiceDate", e.target.value)}
          />
        </Field>
        <Field label="סכום">
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.amount}
            onChange={(e) => set("amount", e.target.value)}
          />
        </Field>
        <Field label="מטבע">
          <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
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
        </Field>
        <Field label="הערות" full>
          <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>

      <SheetFooter className="flex-row gap-2">
        <Button onClick={save} disabled={pending} className="flex-1">
          {pending ? "שומר..." : invoice ? "שמור" : "הוסף להמתנה לאישור"}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          ביטול
        </Button>
      </SheetFooter>
    </>
  );
}

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-2 flex flex-col gap-1.5" : "flex flex-col gap-1.5"}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
