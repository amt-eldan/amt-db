"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateLineFields } from "@/app/actions/orders";
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
import type { OpenLineRow } from "@/db/queries";
import { MANUAL_STATUSES } from "@/lib/status";

const AUTO = "__auto__";

export function LineEditSheet({
  line,
  onClose,
}: {
  line: OpenLineRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!line) return;
    setForm({
      qty: line.qty ?? "",
      unitPrice: line.unitPrice ?? "",
      poNumber: line.poNumber ?? "",
      supplier: line.supplier ?? "",
      buyPrice: line.buyPrice ?? "",
      shippingCost: line.shippingCost ?? "",
      contractDueDate: line.contractDueDate ?? "",
      deliveryUpdate: line.deliveryUpdate ?? "",
      paymentMethod: line.paymentMethod ?? "",
      bol: line.bol ?? "",
      notes: line.notes ?? "",
      manualStatus: line.manualStatus ?? AUTO,
    });
  }, [line]);

  function set(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    if (!line) return;
    startTransition(async () => {
      const result = await updateLineFields({
        lineId: line.lineId,
        ...form,
        manualStatus: form.manualStatus === AUTO ? null : form.manualStatus,
      });
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
    <Sheet open={!!line} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="left" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>עריכת שורה</SheetTitle>
          <SheetDescription dir="ltr" className="text-end">
            {line?.customerName} · {line?.orderNumber} · {line?.pn}
          </SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-3 px-4 pb-4">
          <Field label="כמות">
            <Input dir="ltr" inputMode="decimal" value={form.qty ?? ""} onChange={(e) => set("qty", e.target.value)} />
          </Field>
          <Field label="מחיר מכירה ליח' (₪)">
            <Input dir="ltr" inputMode="decimal" value={form.unitPrice ?? ""} onChange={(e) => set("unitPrice", e.target.value)} />
          </Field>
          <Field label="הזמנת רכש (PO)">
            <Input dir="ltr" value={form.poNumber ?? ""} onChange={(e) => set("poNumber", e.target.value)} />
          </Field>
          <Field label="ספק">
            <Input value={form.supplier ?? ""} onChange={(e) => set("supplier", e.target.value)} />
          </Field>
          <Field label="מחיר קנייה ליח' (₪)">
            <Input dir="ltr" inputMode="decimal" value={form.buyPrice ?? ""} onChange={(e) => set("buyPrice", e.target.value)} />
          </Field>
          <Field label="עלות משלוח (₪)">
            <Input dir="ltr" inputMode="decimal" value={form.shippingCost ?? ""} onChange={(e) => set("shippingCost", e.target.value)} />
          </Field>
          <Field label="תאריך אספקה חוזי">
            <Input dir="ltr" type="date" value={form.contractDueDate ?? ""} onChange={(e) => set("contractDueDate", e.target.value)} />
          </Field>
          <Field label="שיטת תשלום">
            <Input value={form.paymentMethod ?? ""} onChange={(e) => set("paymentMethod", e.target.value)} />
          </Field>
          <Field label="שטר מטען (BOL)" full>
            <Input dir="ltr" value={form.bol ?? ""} onChange={(e) => set("bol", e.target.value)} />
          </Field>
          <Field label="עדכון אספקה" full>
            <Textarea rows={2} value={form.deliveryUpdate ?? ""} onChange={(e) => set("deliveryUpdate", e.target.value)} />
          </Field>
          <Field label="הערות" full>
            <Textarea rows={2} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <Field label="סטטוס ידני" full>
            <Select value={form.manualStatus ?? AUTO} onValueChange={(v) => set("manualStatus", v)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO}>אוטומטי (לפי הנתונים)</SelectItem>
                {MANUAL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
      </SheetContent>
    </Sheet>
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
