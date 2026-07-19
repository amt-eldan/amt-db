"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Check, Pencil, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteLine, setLineOpen, setManualStatus } from "@/app/actions/orders";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { OpenLineRow } from "@/db/queries";
import { formatDate, formatILS, formatNumber } from "@/lib/format";
import { lineStatus, type LineStatus } from "@/lib/status";
import { lineValue } from "@/lib/profit";
import { cn } from "@/lib/utils";
import { LineEditSheet } from "./line-edit-sheet";
import { ROW_TINTS, StatusDot, StatusLegend } from "./status-dot";

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "כל הסטטוסים" },
  { value: "red", label: "מאחר" },
  { value: "orange", label: "סופק חלקי" },
  { value: "green", label: "הגיע / סופק" },
  { value: "neutral", label: "במסלול" },
];

export function OpenOrdersView({ lines }: { lines: OpenLineRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<OpenLineRow | null>(null);
  const [deleting, setDeleting] = useState<OpenLineRow | null>(null);
  // Optimistic manual-status overrides, applied immediately on "✓ הגיע".
  const [overrides, setOverrides] = useState<Record<number, string | null>>({});
  const [, startTransition] = useTransition();

  const withStatus = useMemo(() => {
    return lines.map((line) => {
      const manualStatus =
        line.lineId in overrides ? overrides[line.lineId] : line.manualStatus;
      return { ...line, manualStatus, status: lineStatus({ ...line, manualStatus }) };
    });
  }, [lines, overrides]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return withStatus.filter((line) => {
      if (!showArchived && !line.isOpen) return false;
      if (showArchived && line.isOpen) return false;
      if (statusFilter !== "all" && line.status !== statusFilter) return false;
      if (!q) return true;
      return [line.customerName, line.orderNumber, line.pn, line.poNumber, line.supplier]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [withStatus, search, statusFilter, showArchived]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const line of filtered) {
      const list = map.get(line.customerName) ?? [];
      list.push(line);
      map.set(line.customerName, list);
    }
    // Query already sorts: customer asc, created_at desc within group.
    return Array.from(map.entries());
  }, [filtered]);

  const openLines = withStatus.filter((l) => l.isOpen);
  const stats = {
    open: openLines.length,
    customers: new Set(openLines.map((l) => l.customerName)).size,
    late: openLines.filter((l) => l.status === "red").length,
  };

  function quickArrived(line: OpenLineRow) {
    setOverrides((prev) => ({ ...prev, [line.lineId]: "הגיע" }));
    startTransition(async () => {
      const result = await setManualStatus(line.lineId, "הגיע");
      if (!result.ok) {
        setOverrides((prev) => ({ ...prev, [line.lineId]: line.manualStatus }));
        toast.error(result.error);
        return;
      }
      const previous = result.previous ?? null;
      toast.success(`סומן "הגיע": ${line.pn ?? line.orderNumber}`, {
        action: {
          label: "ביטול",
          onClick: () => {
            setOverrides((prev) => ({ ...prev, [line.lineId]: previous }));
            startTransition(async () => {
              await setManualStatus(line.lineId, previous);
              router.refresh();
            });
          },
        },
      });
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleting) return;
    const line = deleting;
    setDeleting(null);
    startTransition(async () => {
      const result = await deleteLine(line.lineId);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  function toggleClosed(line: OpenLineRow) {
    startTransition(async () => {
      const result = await setLineOpen(line.lineId, !line.isOpen);
      if (result.ok) toast.success(result.message);
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">
          {showArchived ? "שורות בארכיון" : "הזמנות פתוחות"}
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <Switch id="archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <label htmlFor="archived" className="text-muted-foreground cursor-pointer">
            הצג ארכיון
          </label>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <StatCard label="שורות פתוחות" value={stats.open} />
        <StatCard label="לקוחות" value={stats.customers} />
        <StatCard label="מאחרות" value={stats.late} alert={stats.late > 0} />
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="חיפוש לקוח / מס' הזמנה / P/N / ספק..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <StatusLegend />

      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {lines.length === 0
              ? "אין עדיין הזמנות במערכת. אפשר לקלוט הזמנה חדשה במסך הקליטה."
              : "לא נמצאו שורות מתאימות לחיפוש או לסינון."}
          </CardContent>
        </Card>
      ) : (
        groups.map(([customer, customerLines]) => (
          <section key={customer} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-lg font-semibold">{customer}</h2>
              {customerLines[0].customerNote && (
                <span className="text-xs text-muted-foreground">
                  {customerLines[0].customerNote}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                ({customerLines.length} שורות)
              </span>
            </div>

            {/* Desktop table */}
            <div className="hidden md:block rounded-lg border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>מס' הזמנה</TableHead>
                    <TableHead>P/N</TableHead>
                    <TableHead>כמות</TableHead>
                    <TableHead>שווי</TableHead>
                    <TableHead>הזמנת רכש</TableHead>
                    <TableHead>ספק</TableHead>
                    <TableHead>שטר מטען</TableHead>
                    <TableHead>תאריך יעד</TableHead>
                    <TableHead className="w-40">פעולות</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customerLines.map((line) => (
                    <TableRow key={line.lineId} className={cn(ROW_TINTS[line.status as LineStatus])}>
                      <TableCell>
                        <StatusDot status={line.status as LineStatus} />
                      </TableCell>
                      <TableCell dir="ltr" className="text-end font-medium">
                        {line.orderNumber}
                      </TableCell>
                      <TableCell dir="ltr" className="text-end">
                        {line.pn ?? "—"}
                        {line.sku && (
                          <span className="block text-xs text-muted-foreground">{line.sku}</span>
                        )}
                      </TableCell>
                      <TableCell dir="ltr" className="text-end">{formatNumber(line.qty)}</TableCell>
                      <TableCell dir="ltr" className="text-end whitespace-nowrap">
                        {formatILS(lineValue(line))}
                      </TableCell>
                      <TableCell dir="ltr" className="text-end">{line.poNumber ?? "—"}</TableCell>
                      <TableCell>{line.supplier ?? "—"}</TableCell>
                      <TableCell>
                        {line.bol ? (
                          <Badge variant="secondary" dir="ltr" className="max-w-32 truncate">
                            {line.bol}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell dir="ltr" className="text-end whitespace-nowrap">
                        {formatDate(line.contractDueDate)}
                      </TableCell>
                      <TableCell>
                        <LineActions
                          line={line}
                          onArrived={() => quickArrived(line)}
                          onEdit={() => setEditing(line)}
                          onToggleClosed={() => toggleClosed(line)}
                          onDelete={() => setDeleting(line)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden flex flex-col gap-2">
              {customerLines.map((line) => (
                <Card key={line.lineId} className={cn("py-3", ROW_TINTS[line.status as LineStatus])}>
                  <CardContent className="px-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusDot status={line.status as LineStatus} />
                        <span className="font-medium truncate" dir="ltr">
                          {line.pn ?? line.orderNumber}
                        </span>
                      </div>
                      <span className="text-sm whitespace-nowrap" dir="ltr">
                        {formatILS(lineValue(line))}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>הזמנה: <bdi dir="ltr">{line.orderNumber}</bdi></span>
                      <span>כמות: <bdi dir="ltr">{formatNumber(line.qty)}</bdi></span>
                      <span>ספק: {line.supplier ?? "—"}</span>
                      <span>יעד: <bdi dir="ltr">{formatDate(line.contractDueDate)}</bdi></span>
                      {line.poNumber && <span>רכש: <bdi dir="ltr">{line.poNumber}</bdi></span>}
                      {line.bol && (
                        <span className="col-span-2">
                          שטר מטען: <bdi dir="ltr">{line.bol}</bdi>
                        </span>
                      )}
                    </div>
                    <LineActions
                      line={line}
                      onArrived={() => quickArrived(line)}
                      onEdit={() => setEditing(line)}
                      onToggleClosed={() => toggleClosed(line)}
                      onDelete={() => setDeleting(line)}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))
      )}

      <LineEditSheet line={editing} onClose={() => setEditing(null)} />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>מחיקת שורה</AlertDialogTitle>
            <AlertDialogDescription>
              למחוק לצמיתות את השורה{" "}
              <bdi dir="ltr" className="font-medium">
                {deleting?.pn ?? deleting?.orderNumber}
              </bdi>{" "}
              של {deleting?.customerName}? פעולה זו אינה הפיכה.
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

function StatCard({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p className={cn("text-2xl font-bold", alert && "text-red-600")}>{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function LineActions({
  line,
  onArrived,
  onEdit,
  onToggleClosed,
  onDelete,
}: {
  line: OpenLineRow & { manualStatus: string | null };
  onArrived: () => void;
  onEdit: () => void;
  onToggleClosed: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {line.manualStatus !== "הגיע" && line.isOpen && (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-green-700" onClick={onArrived}>
          <Check className="size-3.5" />
          הגיע
        </Button>
      )}
      <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={onEdit}>
        <Pencil className="size-3.5" />
        ערוך
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-muted-foreground"
        onClick={onToggleClosed}
        title={line.isOpen ? "סגור שורה (העבר לארכיון)" : "פתח מחדש"}
      >
        {line.isOpen ? <Archive className="size-3.5" /> : <ArchiveRestore className="size-3.5" />}
        {line.isOpen ? "סגור" : "פתח"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-destructive"
        onClick={onDelete}
      >
        <Trash2 className="size-3.5" />
        מחק
      </Button>
    </div>
  );
}
