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
 * The shekel figure is never computed here. USD goes to `buy_price_usd` and
 * `convertBuyPriceToIls` converts it if the line already has a delivery date to
 * pick a rate by — the same shared helper both other doors use, so a line's buy
 * price cannot mean two things depending on how it arrived. A purchase order
 * priced in shekels has nothing to convert, so it fills `buy_price` directly and
 * records `fx_rate_source = 'document'` to say where the number came from.
 */

import { inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines, type OrderLine } from "@/db/schema";
import { convertBuyPriceToIls } from "./fx-apply";
import { applyLineFields } from "./line-fields";
import { evaluatePoWrite } from "./po-match";
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
    const fields: Record<string, unknown> = { poNumber: input.poNumber };

    // A supplier name a person corrected is not overwritten by a document read.
    if (input.supplier && (!target.supplier || target.supplier.trim() === "")) {
      fields.supplier = input.supplier;
    }

    if (input.currency === "USD") {
      fields.buyPriceUsd = String(match.unitCost);
      // Converts only when the line already carries a delivery date, because the
      // rate is dated by the handover. Until then the dollars sit on the line and
      // the status run converts them the day the carrier confirms delivery.
      Object.assign(
        fields,
        await convertBuyPriceToIls(target, String(match.unitCost), target.deliveredAt),
      );
    } else {
      // Already in shekels: nothing to convert, and no rate to record. The stale
      // rate from any earlier conversion is cleared rather than left sitting next
      // to a number it did not produce.
      fields.buyPrice = String(match.unitCost);
      fields.fxRate = null;
      fields.fxRateDate = null;
      fields.fxRateSource = "document";
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
  }

  return { ok: true, written, skipped: results.length - written, results };
}
