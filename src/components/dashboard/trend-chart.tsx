"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MonthPoint } from "@/lib/dashboard";
import { formatILS } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Sales and profit per month, six months back. Two bars per month rather than two
 * y-axes: both measures are shekels, so they belong on one scale and can be
 * compared by eye — which is the entire question ("how much of what we sold did we
 * keep?").
 *
 * Bar heights are percentages of the largest value on screen, so the shape is
 * honest even though there is no numeric axis; the exact figures are one hover
 * away and the month totals live in the monthly summary.
 */
export function TrendChart({ points }: { points: MonthPoint[] }) {
  // Profit can be negative; the scale has to cover the tallest thing drawn.
  const max = Math.max(...points.map((p) => Math.max(p.sale, Math.abs(p.profit))), 1);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <Legend color="var(--chart-sales)" label="מכירות" />
            <Legend color="var(--chart-profit)" label="רווח" />
          </div>
          <span dir="ltr">עד {formatILS(max)}</span>
        </div>

        <div className="flex items-end gap-1 border-b h-44">
          {points.map((point) => (
            <Tooltip key={point.ym}>
              <TooltipTrigger asChild>
                <div
                  className="group flex flex-1 items-end justify-center gap-0.5 h-full rounded-t-sm hover:bg-muted/60 px-1 cursor-default"
                  aria-label={`${point.label}: מכירות ${formatILS(point.sale)}, רווח ${formatILS(point.profit)}`}
                >
                  <Bar value={point.sale} max={max} color="var(--chart-sales)" />
                  <Bar
                    value={Math.abs(point.profit)}
                    max={max}
                    color={point.profit < 0 ? "var(--destructive)" : "var(--chart-profit)"}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                <p className="font-medium">{point.label}</p>
                <p dir="rtl">
                  מכירות: <bdi dir="ltr">{formatILS(point.sale)}</bdi>
                </p>
                <p dir="rtl">
                  רווח: <bdi dir="ltr">{formatILS(point.profit)}</bdi>
                </p>
                <p dir="rtl" className="opacity-80">
                  {point.lines} שורות
                  {point.open > 0 && ` · ${point.open} עוד פתוחות`}
                  {point.pending > 0 && ` · ${point.pending} בלי מחיר קנייה`}
                </p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex gap-1 text-xs text-muted-foreground">
          {points.map((point) => (
            <span key={point.ym} className="flex-1 text-center">
              {point.label}
            </span>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

/** A bar keeps a visible stub at zero, so an empty month reads as empty, not missing. */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const height = value <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return (
    <div
      className={cn("w-3 rounded-t-sm", height === 0 && "border-b-2 border-dashed border-border")}
      style={{ height: `${height}%`, backgroundColor: height === 0 ? undefined : color }}
    />
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
