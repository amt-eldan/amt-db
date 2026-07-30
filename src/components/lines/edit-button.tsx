"use client";

import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Row-level "ערוך" button, shared by the monthly ledger and the BOL page. */
export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="h-7 w-fit gap-1" onClick={onClick}>
      <Pencil className="size-3.5" />
      ערוך
    </Button>
  );
}
