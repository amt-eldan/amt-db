"use client";

import { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { LineEditSheet } from "@/components/lines/line-edit-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { LineRow } from "@/db/queries";
import { hasBol } from "@/lib/bol";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BolTable } from "./bol-table";

export function BolView({ lines }: { lines: LineRow[] }) {
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
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
      if (!q) return true;
      return [
        line.customerName,
        line.orderNumber,
        line.pn,
        line.poNumber,
        line.supplier,
        line.bol,
        line.carrier,
      ].some((v) => v?.toLowerCase().includes(q));
    });
  }, [scoped, search, missingOnly]);

  const stats = useMemo(() => {
    const withBol = scoped.filter(hasBol).length;
    return { total: scoped.length, withBol, missing: scoped.length - withBol };
  }, [scoped]);

  function exportCsv() {
    const headers = [
      "לקוח", "מס' הזמנה", "תאריך הזמנה", "P/N", "הזמנת רכש", "ספק",
      "שטר מטען", "חברת הובלה", "מקור", "תאריך יעד",
    ];
    const escape = (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = filtered.map((line) =>
      [
        line.customerName,
        line.orderNumber,
        formatDate(line.orderDate),
        line.pn,
        line.poNumber,
        line.supplier,
        line.bol,
        line.carrier,
        hasBol(line) ? (line.bolSource === "auto" ? "אוטומטי" : "ידני") : "",
        formatDate(line.contractDueDate),
      ]
        .map(escape)
        .join(","),
    );
    const csv = "﻿" + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "שטרי-מטען.csv";
    a.click();
    URL.revokeObjectURL(url);
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
          <Button variant="outline" className="gap-1" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="size-4" />
            ייצוא CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:gap-4">
        <StatCard label="שורות" value={stats.total} />
        <StatCard label="עם שטר מטען" value={stats.withBol} />
        <StatCard label="חסרים" value={stats.missing} alert={stats.missing > 0} />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="חיפוש לקוח / מס' הזמנה / P/N / הזמנת רכש / ספק / שטר מטען..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
          />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch id="missing" checked={missingOnly} onCheckedChange={setMissingOnly} />
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
