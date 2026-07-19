import { cn } from "@/lib/utils";
import type { LineStatus } from "@/lib/status";

const DOT_COLORS: Record<LineStatus, string> = {
  green: "bg-green-500",
  orange: "bg-orange-400",
  red: "bg-red-500",
  neutral: "bg-muted-foreground/30",
};

export const ROW_TINTS: Record<LineStatus, string> = {
  green: "bg-green-500/8",
  orange: "bg-orange-400/10",
  red: "bg-red-500/8",
  neutral: "",
};

export function StatusDot({ status, className }: { status: LineStatus; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2.5 rounded-full shrink-0", DOT_COLORS[status], className)}
    />
  );
}

export function StatusLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <StatusDot status="green" /> הגיע / סופק
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot status="orange" /> סופק חלקי
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot status="red" /> מאחר
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot status="neutral" /> במסלול
      </span>
    </div>
  );
}
