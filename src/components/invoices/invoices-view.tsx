"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bot, ExternalLink, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteSupplierInvoice } from "@/app/actions/invoices";
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
import type { SupplierInvoiceRow } from "@/db/queries";
import { formatDate, formatILS, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { InvoiceFormSheet, type OrderOption } from "./invoice-form-sheet";
import { UploadInvoiceButton } from "./upload-invoice-button";

export function InvoicesView({
  invoices,
  orders,
}: {
  invoices: SupplierInvoiceRow[];
  orders: OrderOption[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SupplierInvoiceRow | null>(null);
  const [deleting, setDeleting] = useState<SupplierInvoiceRow | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((inv) =>
      [
        inv.supplier,
        inv.invoiceNumber,
        inv.poNumber,
        inv.orderNumber,
        inv.customerName,
        inv.notes,
      ].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [invoices, search]);

  // Only shekel invoices are summed — a foreign-currency total is never
  // converted here, exactly like the extraction refuses to convert.
  const totals = useMemo(() => {
    let ils = 0;
    let foreign = 0;
    for (const inv of filtered) {
      const n = inv.amount === null ? null : parseFloat(inv.amount);
      if (n === null || Number.isNaN(n)) continue;
      if (inv.currency === "ILS") ils += n;
      else foreign++;
    }
    return { ils, foreign };
  }, [filtered]);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(invoice: SupplierInvoiceRow) {
    setEditing(invoice);
    setFormOpen(true);
  }

  function confirmDelete() {
    if (!deleting) return;
    const invoice = deleting;
    setDeleting(null);
    startTransition(async () => {
      const result = await deleteSupplierInvoice(invoice.id);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">חשבוניות ספק</h1>
          <p className="text-xs text-muted-foreground">
            החשבוניות שהתקבלו מהספקים — המסמכים שמהם מגיע מחיר הקנייה
          </p>
        </div>
        <Button className="gap-1" onClick={openNew}>
          <Plus className="size-4" />
          חשבונית חדשה
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 md:gap-4">
        <StatCard label="חשבוניות" value={String(filtered.length)} />
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
      </div>

      <UploadInvoiceButton />

      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="חיפוש ספק / מספר חשבונית / הזמנת רכש / הזמנה..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ps-9"
        />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {invoices.length === 0
              ? "אין עדיין חשבוניות ספק. אפשר להעלות PDF או להזין חשבונית ידנית."
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
                  <TableHead>ספק</TableHead>
                  <TableHead>מס&apos; חשבונית</TableHead>
                  <TableHead>תאריך</TableHead>
                  <TableHead>סכום</TableHead>
                  <TableHead>הזמנת רכש</TableHead>
                  <TableHead>הזמנה</TableHead>
                  <TableHead>מקור</TableHead>
                  <TableHead>מסמך</TableHead>
                  <TableHead className="w-32">פעולות</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{inv.supplier}</TableCell>
                    <TableCell dir="ltr" className="text-end">{inv.invoiceNumber}</TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      {formatDate(inv.invoiceDate)}
                    </TableCell>
                    <TableCell dir="ltr" className="text-end whitespace-nowrap">
                      <Amount invoice={inv} />
                    </TableCell>
                    <TableCell dir="ltr" className="text-end">{inv.poNumber ?? "—"}</TableCell>
                    <TableCell dir="ltr" className="text-end">
                      {inv.orderNumber ?? "—"}
                      {inv.customerName && (
                        <span className="block text-xs text-muted-foreground" dir="rtl">
                          {inv.customerName}
                        </span>
                      )}
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
                    <span className="font-medium truncate">{inv.supplier}</span>
                    <span className="text-sm whitespace-nowrap" dir="ltr">
                      <Amount invoice={inv} />
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span dir="ltr" className="text-start">{inv.invoiceNumber}</span>
                    <span dir="ltr" className="text-start">{formatDate(inv.invoiceDate)}</span>
                    {inv.poNumber && (
                      <span>רכש: <bdi dir="ltr">{inv.poNumber}</bdi></span>
                    )}
                    {inv.orderNumber && (
                      <span>הזמנה: <bdi dir="ltr">{inv.orderNumber}</bdi></span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <EditButton onClick={() => openEdit(inv)} />
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

      <InvoiceFormSheet
        open={formOpen}
        invoice={editing}
        orders={orders}
        onClose={() => setFormOpen(false)}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת חשבונית</AlertDialogTitle>
            <AlertDialogDescription>
              למחוק לצמיתות את חשבונית{" "}
              <bdi dir="ltr" className="font-medium">
                {deleting?.invoiceNumber}
              </bdi>{" "}
              מהספק {deleting?.supplier}? הקובץ המצורף יימחק גם הוא. פעולה זו אינה הפיכה.
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
function Amount({ invoice }: { invoice: SupplierInvoiceRow }) {
  if (invoice.amount === null) return <span className="text-muted-foreground">—</span>;
  if (invoice.currency === "ILS") return <>{formatILS(invoice.amount)}</>;
  return (
    <>
      {formatNumber(invoice.amount)} {invoice.currency}
    </>
  );
}

function Source({ invoice }: { invoice: SupplierInvoiceRow }) {
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

function FileLink({ invoice }: { invoice: SupplierInvoiceRow }) {
  if (!invoice.hasFile) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={`/api/invoices/${invoice.id}/file`}
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

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p dir="ltr" className={cn("text-xl font-bold text-end")}>
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {sub && <p className="text-xs text-amber-600 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
