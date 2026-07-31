"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateCourierAllocations } from "@/app/actions/courier";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { CourierAllocationRow, CourierInvoiceRow } from "@/db/queries";
import type { CourierLineOption } from "@/lib/courier-match";
import type { CourierShipmentInput } from "@/lib/validation";
import { ShipmentAllocationTable } from "./shipment-allocation-table";

/**
 * Re-split an invoice that was already approved — a charge put on the wrong line
 * is the kind of mistake that only shows up when someone reads the monthly summary.
 * Saving recomputes the shipping cost of both the lines it adds and the lines it
 * drops, so no line keeps money this invoice no longer gives it.
 */
export function CourierAllocationsSheet({
  invoice,
  allocations,
  lines,
  onClose,
}: {
  invoice: CourierInvoiceRow | null;
  allocations: CourierAllocationRow[];
  lines: CourierLineOption[];
  onClose: () => void;
}) {
  return (
    <Sheet open={!!invoice} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="left" className="w-full sm:max-w-3xl overflow-y-auto">
        {invoice && (
          <AllocationsForm
            key={invoice.id}
            invoice={invoice}
            allocations={allocations}
            lines={lines}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function AllocationsForm({
  invoice,
  allocations,
  lines,
  onClose,
}: {
  invoice: CourierInvoiceRow;
  allocations: CourierAllocationRow[];
  lines: CourierLineOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shipments, setShipments] = useState<CourierShipmentInput[]>(
    allocations.map((a) => ({
      bol: a.bol,
      reference: null,
      description: a.description,
      amount: a.amount,
      lineId: a.lineId,
    })),
  );

  function save() {
    startTransition(async () => {
      const result = await updateCourierAllocations({ invoiceId: invoice.id, shipments });
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
        <SheetTitle>שיוך עלות משלוח</SheetTitle>
        <SheetDescription>
          {invoice.courier} · {invoice.invoiceNumber} — העלות שתירשם לשורות היא מה שמופיע כאן.
        </SheetDescription>
      </SheetHeader>

      <div className="px-4 pb-4">
        <ShipmentAllocationTable
          shipments={shipments}
          lines={lines}
          invoiceAmount={invoice.amount}
          currency={invoice.currency}
          disabled={pending}
          onChange={setShipments}
        />
      </div>

      <SheetFooter className="flex-row gap-2">
        <Button onClick={save} disabled={pending} className="flex-1">
          {pending ? "שומר..." : "שמור שיוך"}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          ביטול
        </Button>
      </SheetFooter>
    </>
  );
}
