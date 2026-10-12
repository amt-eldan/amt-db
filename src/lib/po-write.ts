/**
 * Writing unit costs read off our purchase order onto the lines they belong to.
 *
 * The third and last door onto `buy_price`, and the only one whose source
 * document actually states it: the tracking agent can pass a dollar price a
 * supplier's email happened to quote, a person can type one, and this reads the
 * order we ourselves issued. Which makes it the most authoritative of the three
 * and still the most careful — it runs only on matches a person reviewed, and it
 * re-decides every one of them here rather than trusting what came back from the
 * browser.
 *
 * The shekel figure is never computed here. A foreign price (dollars, euros,
 * pounds) goes to `buy_price_foreign` + `buy_currency`, and `convertBuyPriceToIls`
 * converts it if the line already has a delivery date to pick a rate by — the
 * same shared helper the other doors use, so a line's buy price cannot mean two
 * things depending on how it arrived. A purchase order priced in shekels has
 * nothing to convert, so it fills `buy_price` directly and records
 * `fx_rate_source = 'document'` to say where the number came from.
 *
 * Separately from all that, the document's own figures — unit price, currency and
 * quantity — are always recorded in `po_unit_cost` / `po_currency` / `po_qty`.
 * The office keeps typing prices and quantities by hand; those three columns are
 * what the typing is compared against (lib/po-compare), so they are never
 * skipped because a person already owns the field they would otherwise fill.
 */

import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { allocatePendingCourierShipments } from "./courier-allocate";
import { convertBuyPriceToIls } from "./fx-apply";
import { applyLineFields } from "./line-fields";
import { staleConversionFields } from "./currency";
import { buyPriceIsHumanOwned, evaluatePoWrite, foreignPriceFromPo } from "./po-match";
import type { PoApplyInput } from "./validation";

export interface PoWriteResult {
  lineId: number;
  status: "written" | "skipped";
  changed?: string[];
  reason?: string;
  warnings?: string[];
}

export interface PoWriteSummary {
  ok: true;
  written: number;
  skipped: number;
  results: PoWriteResult[];
}

export async function writePurchaseOrderCosts(input: PoApplyInput): Promise<PoWriteSummary> {
  const results: PoWriteResult[] = [];

  const ids = [...new Set(input.matches.map((m) => m.lineId))];
  const byId = new Map<number, OrderLine>();
  if (ids.length > 0) {
    const found = await db.select().from(orderLines).where(inArray(orderLines.id, ids));
    for (const line of found) byId.set(line.id, line);
  }

  for (const match of input.matches) {
    const line = byId.get(match.lineId);

    // Re-decided server-side. The browser sent a line id and a number; the rules
    // about which line may receive which cost are not the browser's to apply.
    const verdict = evaluatePoWrite(
      input.poNumber,
      { pn: null, sku: null, qty: match.qty ?? null, unitCost: match.unitCost, notes: null },
      line,
    );
    if (!verdict.write) {
      results.push({ lineId: match.lineId, status: "skipped", reason: verdict.reason });
      continue;
    }

    const target = line!; // evaluatePoWrite only allows a line it found and found open
    const unitCost = String(match.unitCost);
    const fields: Record<string, unknown> = {
      poNumber: input.poNumber,
      // The supplier order as printed, for the comparison — always recorded.
      poUnitCost: unitCost,
      poCurrency: input.currency,
    };
    if (match.qty !== null) fields.poQty = String(match.qty);

    // A supplier name a person corrected is not overwritten by a document read.
    if (input.supplier && (!target.supplier || target.supplier.trim() === "")) {
      fields.supplier = input.supplier;
    }

    // The line's quantity is the customer's and drives the sale value, so the
    // purchase order only fills it when nothing is there yet. A different figure
    // is shown as a gap on the monthly screen, not silently written over.
    if (match.qty !== null && (target.qty === null || target.qty.trim() === "")) {
      fields.qty = String(match.qty);
    }

    if (input.currency === "ILS") {
      // Already in shekels: nothing to convert, and no rate to record. The stale
      // rate from any earlier conversion is cleared rather than left sitting next
      // to a number it did not produce — unless a person typed the shekel figure,
      // in which case it stays theirs and the document's price sits beside it.
      if (!buyPriceIsHumanOwned(target) || target.fxRateSource === "document") {
        fields.buyPrice = unitCost;
        fields.fxRate = null;
        fields.fxRateDate = null;
        fields.fxRateSource = "document";
      }
    } else {
      // The foreign price is the document's to set when there is none yet, or it is
      // an earlier upload's. Otherwise a person (or the tracking agent) set one that
      // is not this order's: it stays, and po_unit_cost above is what the monthly
      // comparison holds it against, so a disagreement shows instead of being
      // written over.
      const documentSetsForeign = foreignPriceFromPo(target);
      if (documentSetsForeign) {
        // A shekel figure converted from a different amount or currency is cleared
        // with its rate, so the conversion below starts from this price.
        Object.assign(
          fields,
          { buyPriceForeign: unitCost, buyCurrency: input.currency },
          staleConversionFields(target, unitCost, input.currency),
        );
      }
      // A shekel figure an earlier *shekel* reading of a purchase order wrote is
      // superseded by this foreign one — it is the same kind of source, newer — so
      // it goes too, and the line is converted from its foreign price.
      if (target.fxRateSource === "document") {
        Object.assign(fields, { buyPrice: null, fxRate: null, fxRateDate: null, fxRateSource: null });
      }
      // Converts only when the line already carries a delivery date, because the
      // rate is dated by the handover. Until then the foreign price sits on the
      // line and is converted the day the carrier confirms delivery.
      if (documentSetsForeign || target.fxRateSource === "document") {
        Object.assign(
          fields,
          await convertBuyPriceToIls(
            { ...target, ...fields } as OrderLine,
            documentSetsForeign ? unitCost : target.buyPriceForeign,
            documentSetsForeign ? input.currency : target.buyCurrency,
            target.deliveredAt,
          ),
        );
      }
    }

    const changed = Object.keys(fields).filter(
      (k) => String(target[k as keyof OrderLine] ?? "") !== String(fields[k] ?? ""),
    );
    if (changed.length === 0) {
      results.push({ lineId: match.lineId, status: "skipped", reason: "אין שינוי" });
      continue;
    }

    await applyLineFields(target, fields, {
      source: "purchase_order",
      poNumber: input.poNumber,
      supplier: input.supplier,
      currency: input.currency,
      unitCost: match.unitCost,
      file: input.sourceFile,
    });

    byId.set(target.id, { ...target, ...fields } as OrderLine);
    results.push({
      lineId: match.lineId,
      status: "written",
      changed,
      warnings: verdict.warnings.length ? verdict.warnings : undefined,
    });
  }

  const written = results.filter((r) => r.status === "written").length;
  if (written > 0) {
    revalidatePath("/");
    revalidatePath("/orders");
    revalidatePath("/monthly");
    revalidatePath("/bol");
    // A courier invoice that quoted this PO as its reference can place its
    // shipment now that the lines carry the number.
    await allocatePendingCourierShipments();
  }

  return { ok: true, written, skipped: results.length - written, results };
}
