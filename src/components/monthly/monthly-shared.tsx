"use client";

import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LineRow } from "@/db/queries";

/** A monthly ledger line with its sale value and profit precomputed. */
export type MonthlyComputedRow = LineRow & {
  sale: number | null;
  profit: number | null;
};

/** Whitespace counts as no BOL, same as the open-orders list treats it. */
export function hasBol(row: Pick<LineRow, "bol">): boolean {
  return !!row.bol?.trim();
}

export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="h-7 w-fit gap-1" onClick={onClick}>
      <Pencil className="size-3.5" />
      ערוך
    </Button>
  );
}
