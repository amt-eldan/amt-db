"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createOrder } from "@/app/actions/orders";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Customer } from "@/db/schema";
import { CustomerCombobox } from "./customer-combobox";

interface LineDraft {
  pn: string;
  sku: string;
  qty: string;
  unitPrice: string;
  contractDueDate: string;
}

const emptyLine = (): LineDraft => ({ pn: "", sku: "", qty: "", unitPrice: "", contractDueDate: "" });

/** MoD orders: 10 digits starting with 444 → the customer is the purchasing-group number. */
export function isModOrderNumber(orderNumber: string): boolean {
  return /^444\d{7}$/.test(orderNumber.trim());
}

export function IntakeForm({ customers }: { customers: Customer[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customerName, setCustomerName] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [orderDate, setOrderDate] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [duplicatePrompt, setDuplicatePrompt] = useState<string | null>(null);

  const isMod = isModOrderNumber(orderNumber);

  function setLine(i: number, key: keyof LineDraft, value: string) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [key]: value } : l)));
  }

  function submit(allowDuplicate: boolean) {
    startTransition(async () => {
      const result = await createOrder({
        customerName,
        customerNote: null,
        orderNumber,
        orderDate: orderDate || null,
        sourceFormat: isMod ? "mod" : "manual",
        sourceFile: null,
        lines: lines
          .filter((l) => l.pn.trim() || l.qty.trim())
          .map((l) => ({
            pn: l.pn || null,
            sku: l.sku || null,
            qty: l.qty || null,
            unitPrice: l.unitPrice || null,
            contractDueDate: l.contractDueDate || null,
            notes: null,
          })),
        allowDuplicate,
      });
      if (result.ok) {
        toast.success(result.message);
        setCustomerName("");
        setOrderNumber("");
        setOrderDate("");
        setLines([emptyLine()]);
        router.refresh();
      } else if (result.duplicate) {
        setDuplicatePrompt(result.error);
      } else {
        toast.error(result.error);
      }
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerName.trim()) return toast.error("יש לבחור לקוח");
    if (!orderNumber.trim()) return toast.error("יש להזין מספר הזמנה");
    if (!lines.some((l) => l.pn.trim() || l.qty.trim())) return toast.error("נדרשת לפחות שורה אחת");
    submit(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>הזנה ידנית</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>לקוח</Label>
              <CustomerCombobox
                customers={customers}
                value={customerName}
                onChange={setCustomerName}
              />
              {isMod && (
                <p className="text-xs text-amber-600">
                  הזמנת משהב&quot;ט — הלקוח הוא מספר קבוצת הרכש (למשל 134), לא &quot;משרד
                  הביטחון&quot;.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="orderNumber">מספר הזמנה</Label>
              <Input
                id="orderNumber"
                dir="ltr"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="0226P02556 / 4441537295"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="orderDate">תאריך הזמנה</Label>
              <Input
                id="orderDate"
                dir="ltr"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
              />
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>P/N</TableHead>
                  <TableHead>מק&quot;ט (SKU)</TableHead>
                  <TableHead className="w-24">כמות</TableHead>
                  <TableHead className="w-32">מחיר ליח&apos; (₪)</TableHead>
                  <TableHead className="w-40">תאריך אספקה חוזי</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Input dir="ltr" value={line.pn} onChange={(e) => setLine(i, "pn", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input dir="ltr" value={line.sku} onChange={(e) => setLine(i, "sku", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input dir="ltr" inputMode="decimal" value={line.qty} onChange={(e) => setLine(i, "qty", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input dir="ltr" inputMode="decimal" value={line.unitPrice} onChange={(e) => setLine(i, "unitPrice", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Input dir="ltr" type="date" value={line.contractDueDate} onChange={(e) => setLine(i, "contractDueDate", e.target.value)} />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground"
                        onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                        disabled={lines.length === 1}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
            >
              <Plus className="size-4" />
              הוסף שורה
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "שומר..." : "הוסף למעקב"}
            </Button>
          </div>
        </form>
      </CardContent>

      <AlertDialog open={!!duplicatePrompt} onOpenChange={(open) => !open && setDuplicatePrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>הזמנה כפולה</AlertDialogTitle>
            <AlertDialogDescription>
              {duplicatePrompt} — להוסיף בכל זאת?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDuplicatePrompt(null);
                submit(true);
              }}
            >
              הוסף בכל זאת
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
