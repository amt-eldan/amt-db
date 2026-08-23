import { hasBol } from "./bol";
import { asShipmentStatus, isSettled } from "./shipment-status";

export type LineStatus = "green" | "blue" | "orange" | "red" | "neutral";

export interface StatusInput {
  manualStatus: string | null;
  bol: string | null;
  /** Normalized carrier status — see SHIPMENT_STATUSES. This is what makes a row green. */
  shipmentStatus: string | null;
  deliveryUpdate: string | null;
  notes: string | null;
  contractDueDate: string | null; // ISO yyyy-mm-dd
  /** Carrier's actual delivery date, when it reported one. */
  deliveredAt?: string | null; // ISO yyyy-mm-dd
}

export const MANUAL_STATUSES = ["הגיע", "סופק חלקי", "מאחר"] as const;

/**
 * True when the contract delivery date has already passed. Dates only — a line
 * due today is not late until tomorrow.
 */
export function isPastContractDue(
  contractDueDate: string | null,
  today: Date = new Date(),
): boolean {
  if (!contractDueDate) return false;
  const due = new Date(contractDueDate + "T00:00:00");
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return due < startOfToday;
}

/**
 * Row status color, by priority:
 * 1. manual override: הגיע=green, סופק חלקי=orange, מאחר=red
 * 2. the carrier says it was delivered → green
 * 3. the carrier reports a problem (customs, hold, refusal) → orange
 * 4. contract due date already passed → red (late)
 * 5. BOL filled → blue (shipped, not handed over yet)
 * 6. delivery_update/notes contain "סופק" but not "לא סופק" → orange (partial)
 * 7. otherwise neutral (on track)
 *
 * **Green means the goods arrived, and only the carrier can say that.** A bill of
 * lading is a document saying a box left a warehouse; it used to turn a row green
 * and that was the bug — a shipment sitting in a plane looked exactly like one
 * signed for. So a tracking number now buys blue ("במשלוח"), and green waits for
 * `shipment_status = 'delivered'` — written from what FedEx/DHL/UPS actually report.
 *
 * **Delivery outranks the due date**, deliberately reversing an earlier rule that
 * kept a late line red forever: once the goods are physically here, a red row is
 * telling a worse lie than a green one. The delay is not forgotten — the row
 * carries a "נמסר באיחור" badge (see wasDeliveredLate) — but the color reports
 * where the goods are, not how the contract went.
 *
 * A carrier exception is checked **before** the date because a shipment stuck in
 * customs is a problem someone can still act on, while red ("מאחר") describes a
 * date that is already gone.
 *
 * Only a manual status outranks all of it, because that is a person stating what
 * happened rather than the system inferring it from a document.
 */
export function lineStatus(line: StatusInput, today: Date = new Date()): LineStatus {
  switch (line.manualStatus) {
    case "הגיע":
      return "green";
    case "סופק חלקי":
      return "orange";
    case "מאחר":
      return "red";
  }

  const shipment = asShipmentStatus(line.shipmentStatus);

  if (isSettled(shipment)) return "green";

  if (shipment === "exception") return "orange";

  if (isPastContractDue(line.contractDueDate, today)) return "red";

  if (hasBol(line)) return "blue";

  const freeText = `${line.deliveryUpdate ?? ""} ${line.notes ?? ""}`;
  if (freeText.includes("סופק") && !freeText.includes("לא סופק")) return "orange";

  return "neutral";
}

/**
 * A shipment the carrier delivered after the contract date. Green rows lose the
 * red that used to mark this, so the fact gets its own badge instead of vanishing.
 *
 * Falls back to `shipment_status_at` (when we observed the status) if the carrier
 * gave us no delivery date — later than the real handover, so it can only be
 * conservative about a same-day delivery, never invent a delay.
 */
export function wasDeliveredLate(line: {
  shipmentStatus: string | null;
  contractDueDate: string | null;
  deliveredAt?: string | null;
  shipmentStatusAt?: Date | string | null;
}): boolean {
  if (!isSettled(asShipmentStatus(line.shipmentStatus))) return false;
  if (!line.contractDueDate) return false;

  const observed =
    line.deliveredAt ??
    (line.shipmentStatusAt ? new Date(line.shipmentStatusAt).toISOString().slice(0, 10) : null);
  if (!observed) return false;

  return observed > line.contractDueDate;
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  green: "נמסר",
  blue: "במשלוח",
  orange: "סופק חלקי / תקלה",
  red: "מאחר",
  neutral: "במסלול",
};
