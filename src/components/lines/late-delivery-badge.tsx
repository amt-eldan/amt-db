import { Badge } from "@/components/ui/badge";
import { wasDeliveredLate } from "@/lib/status";

/**
 * "נמסר באיחור" — the delay a green row no longer shows.
 *
 * A carrier-confirmed delivery now outranks a missed contract date, so a shipment
 * that arrived three weeks late is green like any other. That is the right colour
 * (the goods are here) and it loses a real fact, so the fact gets a badge. Shown
 * wherever a delivered line is shown: orders, bills of lading, monthly ledger.
 */
export function LateDeliveryBadge({
  line,
}: {
  line: {
    shipmentStatus: string | null;
    contractDueDate: string | null;
    deliveredAt?: string | null;
    shipmentStatusAt?: Date | string | null;
  };
}) {
  if (!wasDeliveredLate(line)) return null;
  return (
    <Badge
      variant="outline"
      className="whitespace-nowrap border-red-500/40 text-red-700 dark:text-red-400"
      title="המשלוח נמסר אחרי תאריך האספקה החוזי"
    >
      נמסר באיחור
    </Badge>
  );
}
