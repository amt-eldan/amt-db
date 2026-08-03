"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createSupplierInvoice, updateSupplierInvoice } from "@/app/actions/invoices";
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
import type { SupplierInvoiceRow } from "@/db/queries";
import { formatDate } from "@/lib/format";

const NO_ORDER = "__none__";
const CURRENCIES = ["ILS", "USD", "EUR"];

export interface OrderOption {
  id: number;
  orderNumber: string;
  customerName: string;
  orderDate: string | null;
}

/**
 * One sheet for both "new invoice" and "edit invoice" — the fields are the same
 * and an extracted invoice is corrected through exactly the same form a manual
 * one is typed into.
 *
 * The form is a separate component mounted only while the sheet is open and
 * keyed by the invoice, so its state is initialized from the row rather than
 * synced to it by an effect.
 */
export function InvoiceFormSheet({
  open,
  invoice,
  orders,
  onClose,
}: {
  open: boolean;
  invoice: SupplierInvoiceRow | null;
  orders: OrderOption[];
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto">
        {open && (
          <InvoiceForm
            key={invoice?.id ?? "new"}
            invoice={invoice}
            orders={orders}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function InvoiceForm({
  invoice,
  orders,
  onClose,
}: {
  invoice: SupplierInvoiceRow | null;
  orders: OrderOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Record<string, string>>({
    supplier: invoice?.supplier ?? "",
    invoiceNumber: invoice?.invoiceNumber ?? "",
    invoiceDate: invoice?.invoiceDate ?? "",
    poNumber: invoice?.poNumber ?? "",
    amount: invoice?.amount ?? "",
    currency: invoice?.currency ?? "ILS",
    notes: invoice?.notes ?? "",
    orderId: invoice?.orderId ? String(invoice.orderId) : NO_ORDER,
  });

  function set(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    const payload = {
      ...form,
      orderId: form.orderId === NO_ORDER ? null : Number(form.orderId),
    };
    startTransition(async () => {
      const result = invoice
        ? await updateSupplierInvoice({ ...payload, id: invoice.id })
        : await createSupplierInvoice(payload);
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
        <SheetTitle>{invoice ? "עריכת חשבונית ספק" : "חשבונית ספק חדשה"}</SheetTitle>
        <SheetDescription>
          {invoice
            ? `${invoice.supplier} · ${invoice.invoiceNumber}`
            : "ספק ומספר חשבונית הם שדות חובה; את השאר אפשר להשלים אחר כך."}
        </SheetDescription>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-3 px-4 pb-4">
        <Field label="ספק" full>
          <Input value={form.supplier ?? ""} onChange={(e) => set("supplier", e.target.value)} />
        </Field>
        <Field label="מספר חשבונית">
          <Input
            dir="ltr"
            value={form.invoiceNumber ?? ""}
            onChange={(e) => set("invoiceNumber", e.target.value)}
          />
        </Field>
        <Field label="תאריך חשבונית">
          <Input
            dir="ltr"
            type="date"
            value={form.invoiceDate ?? ""}
            onChange={(e) => set("invoiceDate", e.target.value)}
          />
        </Field>
        <Field label="סכום">
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.amount ?? ""}
            onChange={(e) => set("amount", e.target.value)}
          />
        </Field>
        <Field label="מטבע">
          <Select value={form.currency ?? "ILS"} onValueChange={(v) => set("currency", v)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="הזמנת רכש (PO)" full>
          <Input
            dir="ltr"
            value={form.poNumber ?? ""}
            onChange={(e) => set("poNumber", e.target.value)}
          />
        </Field>
        <Field label="הזמנה מקושרת" full>
          <Select value={form.orderId ?? NO_ORDER} onValueChange={(v) => set("orderId", v)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ORDER}>ללא הזמנה</SelectItem>
              {orders.map((o) => (
                <SelectItem key={o.id} value={String(o.id)}>
                  {o.orderNumber} · {o.customerName}
                  {o.orderDate ? ` · ${formatDate(o.orderDate)}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="הערות" full>
          <Textarea
            rows={3}
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>

      <SheetFooter className="flex-row gap-2">
        <Button onClick={save} disabled={pending} className="flex-1">
          {pending ? "שומר..." : "שמור"}
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
