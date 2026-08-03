"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, ExternalLink, Plus, Search, Split, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteCourierInvoice } from "@/app/actions/courier";
import { EditButton } from "@/components/lines/edit-button";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  CourierAllocationRow,
  CourierInvoiceRow,
  StagedCourierInvoiceRow,
} from "@/db/queries";
import type { CourierLineOption } from "@/lib/courier-match";
import { formatDate, formatILS, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CourierAllocationsSheet } from "./courier-allocations-sheet";
import { CourierInvoiceFormSheet } from "./courier-invoice-form-sheet";
import { StagedCourierList } from "./staged-courier-list";
import { UploadCourierInvoiceButton } from "./upload-courier-invoice-button";

export function CourierView({
  invoices,
  allocations,
  staged,
  lines,
}: {
  invoices: CourierInvoiceRow[];
  allocations: CourierAllocationRow[];
  staged: StagedCourierInvoiceRow[];
  lines: CourierLineOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CourierInvoiceRow | null>(null);
  const [allocating, setAllocating] = useState<CourierInvoiceRow | null>(null);
  const [deleting, setDeleting] = useState<CourierInvoiceRow | null>(null);
  const [, startTransition] = useTransition();

  const byInvoice = useMemo(() => {
    const map = new Map<number, CourierAllocationRow[]>();
    for (const row of allocations) {
      const list = map.get(row.invoiceId);
      if (list) list.push(row);
      else map.set(row.invoiceId, [row]);
    }
    return map;
  }, [allocations]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((inv) => {
      const own = [inv.courier, inv.invoiceNumber, inv.notes].some((v) =>
        v?.toLowerCase().includes(q),
      );
      if (own) return true;
      // Searching a tracking number or an order number should find the invoice
      // that paid for that shipment — that is how these documents get looked up.
      return (byInvoice.get(inv.id) ?? []).some((a) =>
        [a.bol, a.orderNumber, a.pn, a.customerName].some((v) => v?.toLowerCase().includes(q)),
      );
    });
  }, [invoices, search, byInvoice]);

  // Only shekel invoices are summed — a foreign total is never converted here.
  const totals = useMemo(() => {
    let ils = 0;
    let foreign = 0;
    let allocated = 0;
    const linesWithCost = new Set<number>();
    for (const inv of filtered) {
      const n = inv.amount === null ? null : parseFloat(inv.amount);
      if (n !== null && !Number.isNaN(n)) {
        if (inv.currency === "ILS") ils += n;
        else foreign++;
      }
      const total = inv.allocatedTotal === null ? 0 : parseFloat(inv.allocatedTotal);
      if (!Number.isNaN(total)) allocated += total;
      for (const a of byInvoice.get(inv.id) ?? []) linesWithCost.add(a.lineId);
    }
    return { ils, foreign, allocated, linesWithCost: linesWithCost.size };
  }, [filtered, byInvoice]);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(invoice: CourierInvoiceRow) {
    setEditing(invoice);
    setFormOpen(true);
  }

  function confirmDelete() {
    if (!deleting) return;
    const invoice = deleting;
    setDeleting(null);
    startTransition(async () => {
      const result = await deleteCourierInvoice(invoice.id);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">חשבוניות בלדר</h1>
          <p className="text-xs text-muted-foreground">
            חשבוניות השילוח — כל חשבונית נכנסת למסד רק לאחר אישור, ובאישור נרשמת עלות המשלוח על
            השורות כדי שהרווח בסיכום החודשי יהיה נכון
          </p>
        </div>
        <Button className="gap-1" onClick={openNew}>
          <Plus className="size-4" />
          חשבונית חדשה
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
        <StatCard
          label="ממתינות לאישור"
          value={String(staged.length)}
          sub={staged.length > 0 ? "טרם נרשמו במסד" : undefined}
        />
        <StatCard label="חשבוניות מאושרות" value={String(filtered.length)} />
        <StatCard
          label='סה"כ בשקלים'
          value={formatILS(totals.ils)}
          sub={
            totals.foreign === 0
              ? undefined
              : totals.foreign === 1
                ? "חשבונית אחת במטבע זר לא נכללה"
                : `${totals.foreign} חשבוניות במטבע זר לא נכללו`
          }
        />
        <StatCard
          label="עלות משלוח שנרשמה לשורות"
          value={formatILS(totals.allocated)}
          sub={`${totals.linesWithCost} שורות`}
          subTone="muted"
        />
      </div>

      <UploadCourierInvoiceButton />

      <StagedCourierList items={staged} lines={lines} />

      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="חיפוש בלדר / מספר חשבונית / שטר מטען / הזמנה..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ps-9"
        />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {invoices.length === 0
              ? "אין עדיין חשבוניות בלדר מאושרות. אפשר להעלות PDF או להזין חשבונית ידנית."
              : "לא נמצאו חשבוניות מתאימות לחיפוש."}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>בלדר</TableHead>
                  <TableHead>מס&apos; חשבונית</TableHead>
                  <TableHead>תאריך</TableHead>
                  <TableHead>סכום</TableHead>
                  <TableHead>נרשם לשורות</TableHead>
                  <TableHead>מקור</TableHead>
                  <TableHead>מסמך</TableHead>
                  <TableHead className="w-44">פעולות</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.courier}</TableCell>
                    <TableCell dir="ltr" className="text-end">{inv.invoiceNumber}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      {formatDate(inv.invoiceDate)}
                    </TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      <Amount invoice={inv} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Allocated invoice={inv} />
                    </TableCell>
                    <TableCell>
                      <Source invoice={inv} />
                    </TableCell>
                    <TableCell>
                      <FileLink invoice={inv} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <EditButton onClick={() => openEdit(inv)} />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1"
                          onClick={() => setAllocating(inv)}
                        >
                          <Split className="size-3.5" />
                          שיוך
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1 text-destructive"
                          onClick={() => setDeleting(inv)}
                        >
                          <Trash2 className="size-3.5" />
                          מחק
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden flex flex-col gap-2">
            {filtered.map((inv) => (
              <Card key={inv.id} className="py-3">
                <CardContent className="px-3 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{inv.courier}</span>
                    <span className="text-sm whitespace-nowrap" dir="ltr">
                      <Amount invoice={inv} />
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span dir="ltr" className="text-start">{inv.invoiceNumber}</span>
                    <span dir="ltr" className="text-start">{formatDate(inv.invoiceDate)}</span>
                    <span className="col-span-2">
                      <Allocated invoice={inv} />
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <EditButton onClick={() => openEdit(inv)} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1"
                        onClick={() => setAllocating(inv)}
                      >
                        <Split className="size-3.5" />
                        שיוך
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 text-destructive"
                        onClick={() => setDeleting(inv)}
                      >
                        <Trash2 className="size-3.5" />
                        מחק
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <FileLink invoice={inv} />
                      <Source invoice={inv} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <CourierInvoiceFormSheet
        open={formOpen}
        invoice={editing}
        onClose={() => setFormOpen(false)}
      />

      <CourierAllocationsSheet
        invoice={allocating}
        allocations={allocating ? byInvoice.get(allocating.id) ?? [] : []}
        lines={lines}
        onClose={() => setAllocating(null)}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת חשבונית בלדר</AlertDialogTitle>
            <AlertDialogDescription>
              למחוק לצמיתות את חשבונית{" "}
              <bdi dir="ltr" className="font-medium">
                {deleting?.invoiceNumber}
              </bdi>{" "}
              מ-{deleting?.courier}? הקובץ המצורף יימחק, ועלות המשלוח שנרשמה
              {deleting && deleting.allocatedLines > 0 ? ` ל-${deleting.allocatedLines} שורות ` : " "}
              תוסר מהן — הרווח בסיכום החודשי יתעדכן בהתאם. פעולה זו אינה הפיכה.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>ביטול</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              מחק
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** ILS through formatILS; any other currency keeps its own code, unconverted. */
function Amount({ invoice }: { invoice: CourierInvoiceRow }) {
  if (invoice.amount === null) return <span className="text-muted-foreground">—</span>;
  if (invoice.currency === "ILS") return <>{formatILS(invoice.amount)}</>;
  return (
    <>
      {formatNumber(invoice.amount)} {invoice.currency}
    </>
  );
}

/** What reached the order lines — the number that actually moves the profit. */
function Allocated({ invoice }: { invoice: CourierInvoiceRow }) {
  if (invoice.allocatedLines === 0) {
    return (
      <Badge variant="outline" className="text-amber-600 border-amber-300 font-normal">
        לא שויך
      </Badge>
    );
  }
  return (
    <span className="text-sm">
      <bdi dir="ltr">{formatILS(invoice.allocatedTotal)}</bdi>
      <span className="text-xs text-muted-foreground"> · {invoice.allocatedLines} שורות</span>
    </span>
  );
}

function Source({ invoice }: { invoice: CourierInvoiceRow }) {
  if (invoice.source === "extracted") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
        <Bot className="size-3.5 shrink-0" />
        חולץ מ-PDF
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">ידני</span>;
}

function FileLink({ invoice }: { invoice: CourierInvoiceRow }) {
  if (!invoice.hasFile) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={`/api/courier-invoices/${invoice.id}/file`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs underline underline-offset-4 hover:text-foreground"
    >
      <ExternalLink className="size-3.5 shrink-0" />
      <bdi dir="ltr" className="max-w-32 truncate">
        {invoice.fileName ?? "PDF"}
      </bdi>
    </a>
  );
}

function StatCard({
  label,
  value,
  sub,
  subTone = "warning",
}: {
  label: string;
  value: string;
  sub?: string;
  /** Amber by default — a sub-line is usually something to act on, not a caption. */
  subTone?: "warning" | "muted";
}) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p dir="ltr" className="text-xl font-bold text-end">
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && (
          <p
            className={cn(
              "text-xs mt-0.5",
              subTone === "warning" ? "text-amber-600" : "text-muted-foreground",
            )}
          >
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
