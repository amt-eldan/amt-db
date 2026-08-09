"use client";

import type { LineRow } from "@/db/queries";
import { formatDate } from "@/lib/format";

/**
 * The date an order was received from the customer, shared by the open-orders
 * list and the monthly ledger.
 *
 * `receivedDate` always holds a date; when the document carried none it is the
 * intake date, and the row says so — "ordered on the 3rd" and "we typed it in on
 * the 3rd" are not the same claim, and only one of them can be argued with a
 * customer.
 */
export function ReceivedDate({
  line,
}: {
  line: Pick<LineRow, "orderDate" | "receivedDate">;
}) {
  return (
    <span className="flex flex-col items-start gap-0.5">
      <bdi dir="ltr">{formatDate(line.receivedDate)}</bdi>
      {line.orderDate === null && (
        <span
          className="text-xs text-muted-foreground"
          title="במסמך לא הופיע תאריך הזמנה — מוצג מועד הקליטה למערכת"
        >
          לפי קליטה
        </span>
      )}
    </span>
  );
}
