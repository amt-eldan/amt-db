"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Download, Search } from "lucide-react";
import { LineEditSheet } from "@/components/lines/line-edit-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { LineRow } from "@/db/queries";
import { hasBol } from "@/lib/bol";
import { downloadCsv, toCsv, type CsvCell } from "@/lib/csv";
import { formatDate } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, asShipmentStatus } from "@/lib/shipment-status";
import { cn } from "@/lib/utils";
import { BolTable } from "./bol-table";

export function BolView({ lines }: { lines: LineRow[] }) {
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  // The screen opens on what is still en route — the reason to look at it at all.
  // The other two views (everything, missing-only) stay one toggle away.
  const [inAirOnly, setInAirOnly] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<LineRow | null>(null);

  const scoped = useMemo(
    () => lines.filter((line) => line.isOpen !== showArchived),
    [lines, showArchived],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scoped.filter((line) => {
      if (missingOnly && hasBol(line)) return false;
      if (inAirOnly && !isInAir(line)) return false;
      if (!q) return true;
      return [
        line.customerName,
        line.orderNumber,
        line.pn,
        line.poNumber,
        line.supplier,
        line.bol,
        line.carrier,
        // Searchable now that it is on screen: "נתקע במכס" is a thing to look for.
        line.deliveryUpdate,
        line.shipmentStatusText,
      ].some((v) => v?.toLowerCase().includes(q));
    });
  }, [scoped, search, missingOnly, inAirOnly]);

  const stats = useMemo(() => {
    const withBol = scoped.filter(hasBol).length;
    return {
      total: scoped.length,
      withBol,
      missing: scoped.length - withBol,
      inAir: scoped.filter(isInAir).length,
    };
  }, [scoped]);

  /**
   * Every line that holds a bill of lading, open and archived alike, ignoring
   * every filter on screen.
   *
   * Kept separate from exporting the view, because the two are genuinely
   * different questions and only one of them was answerable before: the screen
   * opens on "in the air" only, and the archive toggle shows open *or* closed but
   * never both — so no combination of the controls could produce the whole list.
   * An export named "all" that quietly hands over a subset is worse than no
   * export, because the file looks complete.
   */
  const allWithBol = useMemo(() => lines.filter(hasBol), [lines]);

  function exportRows(rows: LineRow[], filename: string) {
    const headers = [
      "לקוח", "מס' הזמנה", "תאריך הזמנה", "סטטוס שורה", "P/N", "הזמנת רכש", "ספק",
      "שטר מטען", "חברת הובלה", "סטטוס משלוח", "תיאור מהמוביל", "תאריך מסירה",
      "עדכון אספקה", "צפי הגעה", "מקור", "ודאות", "תאריך יעד",
    ];
    const body: CsvCell[][] = rows.map((line) => [
      line.customerName,
      line.orderNumber,
      formatDate(line.orderDate),
      line.isOpen ? "פתוחה" : "בארכיון",
      line.pn,
      line.poNumber,
      line.supplier,
      line.bol,
      line.carrier,
      // The Hebrew label, not the raw enum: a person reads this file.
      hasBol(line) ? statusLabel(line.shipmentStatus) : "",
      line.shipmentStatusText,
      formatDate(line.deliveredAt),
      line.deliveryUpdate,
      formatDate(line.shipmentEta),
      hasBol(line) ? (line.bolSource === "auto" ? "אוטומטי" : "ידני") : "",
      // Only meaningful on an automatic fill, and worth having: a low value is a
      // number the matcher was unsure of, and this file is where an audit starts.
      line.bolSource === "auto" ? line.bolConfidence : "",
      formatDate(line.contractDueDate),
    ]);
    downloadCsv(filename, toCsv(headers, body));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">שטרי מטען</h1>
          <p className="text-xs text-muted-foreground">
            מספרי המשלוח לכל שורה — מולאו אוטומטית על ידי מעקב המשלוחים או ידנית
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Switch id="archived" checked={showArchived} onCheckedChange={setShowArchived} />
            <label htmlFor="archived" className="text-muted-foreground cursor-pointer">
              הצג ארכיון
            </label>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-1" disabled={allWithBol.length === 0}>
                <Download className="size-4" />
                ייצוא CSV
                <ChevronDown className="size-4 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            {/* Each scope carries its row count, so which file is the complete
                one is visible before clicking rather than after opening it. */}
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => exportRows(allWithBol, "שטרי-מטען-הכל.csv")}>
                כל שטרי המטען ({allWithBol.length})
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={filtered.length === 0}
                onSelect={() => exportRows(filtered, "שטרי-מטען-מסונן.csv")}
              >
                מה שמוצג כרגע ({filtered.length})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <StatCard label="באוויר" value={stats.inAir} />
        <StatCard label="עם שטר מטען" value={stats.withBol} />
        <StatCard label="חסרים" value={stats.missing} alert={stats.missing > 0} />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="חיפוש לקוח / מס' הזמנה / P/N / הזמנת רכש / ספק / שטר מטען / סטטוס..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            id="in-air"
            checked={inAirOnly}
            onCheckedChange={(v) => {
              setInAirOnly(v);
              if (v) setMissingOnly(false); // mutually exclusive: a missing BOL is not in the air
            }}
          />
          <label htmlFor="in-air" className="text-muted-foreground cursor-pointer whitespace-nowrap">
            רק באוויר
          </label>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            id="missing"
            checked={missingOnly}
            onCheckedChange={(v) => {
              setMissingOnly(v);
              if (v) setInAirOnly(false);
            }}
          />
          <label htmlFor="missing" className="text-muted-foreground cursor-pointer whitespace-nowrap">
            רק חסרי שטר מטען
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {lines.length === 0
              ? "אין עדיין שורות במערכת."
              : inAirOnly && !search
                ? "אין משלוחים באוויר. שורה נכללת כאן כשיש לה שטר מטען והיא עוד לא נמסרה."
                : "לא נמצאו שורות מתאימות לחיפוש או לסינון."}
          </CardContent>
        </Card>
      ) : (
        <BolTable rows={filtered} onEdit={setEditing} />
      )}

      <LineEditSheet line={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/**
 * In the air: we hold a tracking number and the shipment has not landed.
 *
 * Mirrors getBolWorklist's exclusions — a line a human already marked הגיע needs no
 * tracking. A BOL whose status never got classified (shipment_status null) counts
 * as in the air on purpose: an untracked shipment is the one worth chasing, and
 * hiding it would be the worse error.
 */
function isInAir(line: LineRow): boolean {
  if (!hasBol(line)) return false;
  if (line.shipmentStatus === "delivered") return false;
  if (line.manualStatus === "הגיע") return false;
  return true;
}

/** The Hebrew label for a shipment status; empty for one that was never classified. */
function statusLabel(status: string | null): string {
  const known = asShipmentStatus(status);
  return known ? SHIPMENT_STATUS_LABELS[known] : "";
}

function StatCard({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <Card className="py-3">
      <CardContent className="px-4">
        <p className={cn("text-2xl font-bold", alert && "text-amber-600")}>{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
