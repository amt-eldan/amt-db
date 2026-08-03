/**
 * Normalized shipment status, derived from the free-text status the external
 * tracking agent reads out of a carrier email.
 *
 * The raw carrier wording keeps living in order_lines.delivery_update (it is what
 * a human reads, and lineStatus() already keys off it). This normalized value
 * exists for one reason the free text cannot serve: **filtering**. The bills-of-
 * lading screen has to ask "which shipments are still in the air", and that
 * question cannot be answered by substring-matching Hebrew and English carrier
 * prose in SQL.
 */
export const SHIPMENT_STATUSES = ["in_transit", "delivered", "exception"] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  in_transit: "באוויר",
  delivered: "נמסר",
  exception: "תקלה",
};

/** Shown for a shipment we hold a BOL for but could not classify. */
export const SHIPMENT_STATUS_UNKNOWN_LABEL = "לא ידוע";

/**
 * Carrier phrasing → one of SHIPMENT_STATUSES, or null when the text carries no
 * clear signal.
 *
 * Returning null is deliberate and not a failure: an unclassified shipment still
 * shows on the tracking screen (with the raw text), because a BOL we cannot read a
 * status for is exactly the shipment a human should look at. Guessing "delivered"
 * from ambiguous wording would instead hide it.
 *
 * Order matters. "Out for delivery" contains "deliver" but is still in the air, and
 * a customs hold often reads "Delivery delayed" — so exceptions are matched first
 * and the out-for-delivery phrasing before plain "delivered".
 */
export function normalizeCarrierStatus(text: string | null | undefined): ShipmentStatus | null {
  if (!text) return null;
  const t = text.toLowerCase();

  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // 1. Something went wrong — outranks everything, including a "delivery" mention.
  if (
    has(
      "exception",
      "held",
      "hold at",
      "on hold",
      "customs",
      "delay",
      "delayed",
      "failed",
      "refused",
      "returned to sender",
      "damaged",
      "lost",
      "עיכוב",
      "מעוכב",
      "מכס",
      "תקלה",
    )
  ) {
    return "exception";
  }

  // 2. Last mile — reads like "delivery" but has not been handed over yet.
  if (has("out for delivery", "with courier", "arriving today", "יצא לחלוקה")) {
    return "in_transit";
  }

  // 3. Handed over.
  if (has("delivered", "signed for", "picked up by recipient", "נמסר", "סופק", "הגיע")) {
    return "delivered";
  }

  // 4. Moving.
  if (
    has(
      "in transit",
      "in-transit",
      "transit",
      "shipped",
      "departed",
      "in flight",
      "en route",
      "on the way",
      "processed at",
      "arrived at facility",
      "accepted",
      "picked up",
      "נשלח",
      "בדרך",
      "באוויר",
    )
  ) {
    return "in_transit";
  }

  return null;
}

/** True for a status that means the shipment is no longer being tracked. */
export function isSettled(status: ShipmentStatus | null): boolean {
  return status === "delivered";
}
