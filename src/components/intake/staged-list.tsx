"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileText, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { approveStaged, rejectStaged } from "@/app/actions/staged";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import type { StagedPayload } from "@/lib/validation";

interface StagedItem {
  id: number;
  createdAt: Date;
  payload: StagedPayload;
}

const FORMAT_LABELS: Record<string, string> = {
  standard: "רגיל",
  mod: 'משהב"ט',
  manual: "ידני",
};

export function StagedList({ items }: { items: StagedItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        אין הזמנות סרוקות שממתינות לאישור.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">
        ממתינות לאישור <Badge variant="secondary">{items.length}</Badge>
      </h2>
      {items.map((item) => (
        <StagedCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function StagedCard({ item }: { item: StagedItem }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [payload, setPayload] = useState<StagedPayload>(item.payload);
  const [rejecting, setRejecting] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState<string | null>(null);

  function setHeader<K extends keyof StagedPayload>(key: K, value: StagedPayload[K]) {
    setPayload((prev) => ({ ...prev, [key]: value }));
  }

  function setLine(i: number, key: string, value: string) {
    setPayload((prev) => ({
      ...prev,
      lines: prev.lines.map((l, idx) => (idx === i ? { ...l, [key]: value || null } : l)),
    }));
  }

  function approve(allowDuplicate: boolean) {
    startTransition(async () => {
      const result = await approveStaged(item.id, payload, allowDuplicate);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else if (result.duplicate) {
        setDuplicatePrompt(result.error);
      } else {
        toast.error(result.error);
      }
    });
  }

  function reject() {
    setRejecting(false);
    startTransition(async () => {
      const result = await rejectStaged(item.id);
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
          <bdi dir="ltr">{payload.orderNumber}</bdi>
          <span className="text-muted-foreground font-normal">·</span>
          <span>{payload.customer}</span>
          <Badge variant="outline">{FORMAT_LABELS[payload.sourceFormat] ?? payload.sourceFormat}</Badge>
          {payload.sourceFile && (
            <Badge variant="secondary" dir="ltr" className="max-w-48 truncate">
              {payload.sourceFile}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">לקוח</Label>
            <Input value={payload.customer} onChange={(e) => setHeader("customer", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">מספר הזמנה</Label>
            <Input dir="ltr" value={payload.orderNumber} onChange={(e) => setHeader("orderNumber", e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">תאריך הזמנה</Label>
            <Input
              dir="ltr"
              type="date"
              value={payload.orderDate ?? ""}
              onChange={(e) => setHeader("orderDate", e.target.value || null)}
            />
          </div>
        </div>

        <div className="rounded-lg border bg-background overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>P/N</TableHead>
                <TableHead>מק&quot;ט</TableHead>
                <TableHead className="w-20">כמות</TableHead>
                <TableHead className="w-28">מחיר ליח&apos;</TableHead>
                <TableHead className="w-36">אספקה חוזית</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.lines.map((line, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Input dir="ltr" className="h-8" value={line.pn ?? ""} onChange={(e) => setLine(i, "pn", e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input dir="ltr" className="h-8" value={line.sku ?? ""} onChange={(e) => setLine(i, "sku", e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input dir="ltr" className="h-8" inputMode="decimal" value={line.qty ?? ""} onChange={(e) => setLine(i, "qty", e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input dir="ltr" className="h-8" inputMode="decimal" value={line.unitPrice ?? ""} onChange={(e) => setLine(i, "unitPrice", e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Input dir="ltr" className="h-8" type="date" value={line.contractDueDate ?? ""} onChange={(e) => setLine(i, "contractDueDate", e.target.value)} />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground"
                      onClick={() =>
                        setPayload((prev) => ({
                          ...prev,
                          lines: prev.lines.filter((_, idx) => idx !== i),
                        }))
                      }
                      disabled={payload.lines.length === 1}
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
          <span className="text-xs text-muted-foreground">
            נקלט: {formatDate(item.createdAt.toISOString().slice(0, 10))}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" className="gap-1 text-destructive" disabled={pending} onClick={() => setRejecting(true)}>
              <X className="size-4" />
              דחה
            </Button>
            <Button className="gap-1" disabled={pending} onClick={() => approve(false)}>
              <Check className="size-4" />
              {pending ? "שומר..." : "אשר והוסף למעקב"}
            </Button>
          </div>
        </div>
      </CardContent>

      <AlertDialog open={rejecting} onOpenChange={setRejecting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>דחיית הזמנה סרוקה</AlertDialogTitle>
            <AlertDialogDescription>
              לדחות ולמחוק את הזמנה <bdi dir="ltr">{payload.orderNumber}</bdi> של{" "}
              {payload.customer}? הפעולה אינה הפיכה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction onClick={reject} className="bg-destructive text-white hover:bg-destructive/90">
              דחה ומחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicatePrompt} onOpenChange={(open) => !open && setDuplicatePrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>הזמנה כפולה</AlertDialogTitle>
            <AlertDialogDescription>{duplicatePrompt} — לאשר בכל זאת?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDuplicatePrompt(null);
                approve(true);
              }}
            >
              אשר בכל זאת
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
