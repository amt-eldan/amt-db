"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CourierLineOption } from "@/lib/courier-match";
import { formatILS } from "@/lib/format";
import { cn } from "@/lib/utils";

const NO_LINE = "__none__";

/**
 * Which order line a courier charge belongs to. Searchable on everything that
 * appears on a courier invoice — tracking number, PO, order number — so the
 * reviewer can paste what the document says instead of hunting for the row.
 */
export function LinePicker({
  lines,
  value,
  onChange,
}: {
  lines: CourierLineOption[];
  value: number | null;
  onChange: (lineId: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value === null ? null : lines.find((l) => l.lineId === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-full justify-between font-normal px-2"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? (
              <>
                <bdi dir="ltr">{selected.orderNumber}</bdi>
                {selected.pn && (
                  <>
                    {" · "}
                    <bdi dir="ltr">{selected.pn}</bdi>
                  </>
                )}
              </>
            ) : value === null ? (
              "בחר שורה..."
            ) : (
              `שורה ${value} (לא נמצאה)`
            )}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-80 p-0" align="start">
        <Command
          filter={(itemValue, search) => {
            const needle = search.trim().toLowerCase();
            if (!needle) return 1;
            // Tracking numbers get retyped with spaces and dashes; match on the
            // stripped form too so "1z999 aa1" still finds "1Z999AA1".
            const stripped = needle.replace(/[^a-z0-9֐-׿]/g, "");
            const haystack = itemValue.toLowerCase();
            if (haystack.includes(needle)) return 1;
            return stripped && haystack.replace(/[^a-z0-9֐-׿]/g, "").includes(stripped)
              ? 1
              : 0;
          }}
        >
          <CommandInput placeholder="חיפוש לפי הזמנה / P/N / שטר מטען / רכש..." />
          <CommandList>
            <CommandEmpty>לא נמצאה שורה.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={NO_LINE} onSelect={() => { onChange(null); setOpen(false); }}>
                <Check className={cn("size-4", value === null ? "opacity-100" : "opacity-0")} />
                <span className="text-muted-foreground">ללא שיוך</span>
              </CommandItem>
              {lines.map((line) => (
                <CommandItem
                  key={line.lineId}
                  value={[
                    line.orderNumber,
                    line.pn,
                    line.bol,
                    line.poNumber,
                    line.customerName,
                    String(line.lineId),
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onSelect={() => {
                    onChange(line.lineId);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("size-4 shrink-0", value === line.lineId ? "opacity-100" : "opacity-0")}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">
                      <bdi dir="ltr">{line.orderNumber}</bdi>
                      {line.pn && (
                        <>
                          {" · "}
                          <bdi dir="ltr">{line.pn}</bdi>
                        </>
                      )}
                      {!line.isOpen && <span className="text-muted-foreground"> · בארכיון</span>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {line.customerName}
                      {line.bol && (
                        <>
                          {" · "}
                          <bdi dir="ltr">{line.bol}</bdi>
                        </>
                      )}
                      {line.shippingCost && ` · משלוח: ${formatILS(line.shippingCost)}`}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
