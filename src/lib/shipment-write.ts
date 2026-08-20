/**
 * Writes shipment status updates onto lines that already hold a bill of lading,
 * and converts a dollar purchase price the moment a delivery date makes a rate
 * available.
 *
 * The twin of writeBolMatches, and separate from it on purpose. That function
 * answers "here is a tracking number for a line that had none", and its central
 * guarantee is that it never overwrites `bol`. This one answers "here is where
 * that shipment has got to", runs twice a day against the same line for as long
 * as the shipment takes, and is *supposed* to replace its previous answer. One
 * function doing both would have to give up the never-overwrite rule.
 *
 * Two rules worth not breaking:
 *
 *  - **It never touches `bol`.** A status report cannot invent, correct or clear a
 *    tracking number.
 *  - **It writes only what actually changed.** A twice-daily run over a shipment
 *    that spends three weeks in transit would otherwise leave forty identical rows
 *    in audit_log and make the real transitions impossible to find.
 *
 * `delivery_update` is filled only while it is empty — the same rule the email
 * path applies — because that field is where a human writes a note, and an
 * unattended run must not talk over them.
 *
 * Callers own authentication. Revalidation happens here, once, and only when
 * something was actually written.
 */

import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { convertBuyPriceToIls } from "./fx-apply";
import { applyLineFields } from "./line-fields";
import { normalizeCarrierStatus } from "./shipment-status";
import type { ShipmentUpdateInput } from "./validation";

export interface ShipmentUpdateResult {
  lineId: number;
  status: "written" | "unchanged" | "skipped";
  /** Which fields actually moved — the useful half of a twice-daily run's report. */
  changed?: string[];
  reason?: string;
}

export interface ShipmentWriteSummary {
  ok: true;
  written: number;
  unchanged: number;
  skipped: number;
  results: ShipmentUpdateResult[];
}

export async function writeShipmentUpdates(
  updates: ShipmentUpdateInput[],
): Promise<ShipmentWriteSummary> {
  const results: ShipmentUpdateResult[] = [];

  // One lookup for the whole batch — a run covers tens of lines and Neon is over
  // the network.
  const ids = [...new Set(updates.map((u) => u.lineId))];
  const byId = new Map<number, OrderLine>();
  if (ids.length > 0) {
    const found = await db.select().from(orderLines).where(inArray(orderLines.id, ids));
    for (const line of found) byId.set(line.id, line);
  }

  for (const update of updates) {
    const line = byId.get(update.lineId);
    if (!line) {
      results.push({ lineId: update.lineId, status: "skipped", reason: "line not found" });
      continue;
    }
    if (!line.isOpen) {
      results.push({ lineId: update.lineId, status: "skipped", reason: "line is closed" });
      continue;
    }
    // A status report is about a shipment, and without a tracking number there is
    // no shipment to report on. This is what keeps the two doors apart: a number
    // arrives through bol_submit_matches, never through here.
    if (!line.bol || line.bol.trim() === "") {
      results.push({
        lineId: update.lineId,
        status: "skipped",
        reason: "line has no bol — use bol_submit_matches first",
      });
      continue;
    }

    const fields = await buildShipmentFields(line, update);
    const changed = changedKeys(line, fields);

    if (changed.length === 0) {
      results.push({ lineId: update.lineId, status: "unchanged" });
      continue;
    }

    await applyLineFields(
      line,
      { ...fields, shipmentStatusAt: new Date() },
      {
        agent: "shipment-status",
        url: update.sourceUrl,
        emailId: update.sourceEmailId,
        quote: update.sourceQuote,
        carrierStatus: update.statusText,
      },
      "agent:shipment-status",
    );

    byId.set(line.id, { ...line, ...fields } as OrderLine);
    results.push({ lineId: update.lineId, status: "written", changed });
  }

  const written = results.filter((r) => r.status === "written").length;
  if (written > 0) {
    revalidatePath("/");
    revalidatePath("/orders");
    revalidatePath("/monthly");
    revalidatePath("/bol");
  }

  return {
    ok: true,
    written,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  };
}

/**
 * What the update means in database terms.
 *
 * `status` is preferred over `statusText` when both arrive: an explicit enum from
 * a carrier page beats guessing at prose. When only prose arrives,
 * normalizeCarrierStatus decides — and returning null there is a real answer, so
 * an unreadable status leaves the column alone rather than clearing it.
 */
async function buildShipmentFields(
  line: OrderLine,
  update: ShipmentUpdateInput,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};

  const status = update.status ?? normalizeCarrierStatus(update.statusText);
  if (status) fields.shipmentStatus = status;
  if (update.carrier && !line.carrier) fields.carrier = update.carrier;
  if (update.etaDate) fields.shipmentEta = update.etaDate;

  // Only ever fill a human's note while it is still empty.
  if (update.statusText && (!line.deliveryUpdate || line.deliveryUpdate.trim() === "")) {
    fields.deliveryUpdate = update.statusText;
  }

  // No date is inferred from a "delivered" status: the run's own clock is not the
  // carrier's handover date, and it is this date that picks the exchange rate.
  // A delivery reported without one simply has no delivered_at until it gets one.
  if (update.deliveredAt) fields.deliveredAt = update.deliveredAt;

  const buyPriceUsd = update.buyPriceUsd ?? line.buyPriceUsd;
  if (update.buyPriceUsd && update.buyPriceUsd !== line.buyPriceUsd) {
    fields.buyPriceUsd = update.buyPriceUsd;
  }

  Object.assign(
    fields,
    await convertBuyPriceToIls(line, buyPriceUsd, update.deliveredAt ?? line.deliveredAt),
  );

  return fields;
}

/** The fields whose value would actually move, compared the way applyLineFields does. */
function changedKeys(line: OrderLine, fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((k) => {
    const before = line[k as keyof OrderLine];
    return String(before ?? "") !== String(fields[k] ?? "");
  });
}
