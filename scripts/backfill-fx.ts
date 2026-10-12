/**
 * Convert — and re-check — the foreign buy prices of lines that have a delivery date.
 *
 *   npm run fx:backfill            # report only, writes nothing
 *   npm run fx:backfill -- --apply # actually write
 *
 * Two jobs:
 *
 *  1. **Unconverted lines** — a foreign price and a delivery date but no shekel
 *     figure yet. Going forward the app converts these itself (the status run and
 *     the pending-conversion sweep in src/lib/fx-apply.ts); this is for history.
 *
 *  2. **Lines converted at the wrong rate.** Until the fix in src/lib/fx-fetch.ts,
 *     a rate lookup answered from the cache with "the newest cached rate on or
 *     before the date" — and the cache only knew the days somebody had asked about.
 *     Once anything was cached, later deliveries were converted at that older rate
 *     and the Bank of Israel was never asked again. Every automatic conversion
 *     (fx_rate_source = 'boi') is re-looked-up here, and one whose rate or rate
 *     date differs from the right one is reported, and fixed with --apply.
 *
 * Dry by default, and never touches a shekel price a person owns: a line whose
 * fx_rate_source is anything other than 'boi' was decided by a human (or priced
 * in shekels by its purchase order), and this script is not the place to overrule
 * that.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { and, isNotNull, sql } from "drizzle-orm";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { orderLines } from "../src/db/schema";
import { convertToIls } from "../src/lib/fx";
import { representativeRateOn } from "../src/lib/fx-fetch";
import { convertBuyPriceToIls } from "../src/lib/fx-apply";

if (typeof WebSocket === "undefined") {
  neonConfig.webSocketConstructor = ws;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    console.error("fx:backfill — DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  try {
    const candidates = await db
      .select()
      .from(orderLines)
      .where(and(isNotNull(orderLines.buyPriceForeign), isNotNull(orderLines.deliveredAt)))
      .orderBy(orderLines.deliveredAt);

    console.log(
      `fx:backfill — ${candidates.length} lines have a foreign price and a delivery date.`,
    );

    let converted = 0;
    let corrected = 0;
    let skipped = 0;
    for (const line of candidates) {
      const currency = line.buyCurrency ?? "USD";
      let fields: Record<string, unknown> = {};

      if (line.buyPrice === null) {
        fields = await convertBuyPriceToIls(
          line,
          line.buyPriceForeign,
          line.buyCurrency,
          line.deliveredAt,
        );
        if (Object.keys(fields).length > 0) converted++;
      } else if (line.fxRateSource === "boi") {
        const right = await representativeRateOn(line.deliveredAt!, currency);
        const wrongRate =
          right !== null &&
          (right.rateDate !== line.fxRateDate || Number(right.rate) !== Number(line.fxRate));
        if (wrongRate) {
          fields = {
            buyPrice: String(convertToIls(Number(line.buyPriceForeign), Number(right!.rate))),
            fxRate: right!.rate,
            fxRateDate: right!.rateDate,
            fxRateSource: right!.source,
          };
          corrected++;
          console.log(
            `  line ${line.id}: was ${line.fxRate} (${line.fxRateDate}) → should be ` +
              `${right!.rate} (${right!.rateDate}) for delivery ${line.deliveredAt}`,
          );
        }
      }

      if (Object.keys(fields).length === 0) {
        skipped++;
        continue;
      }
      console.log(
        `  line ${line.id}: ${line.buyPriceForeign} ${currency} × ${fields.fxRate} ` +
          `(${fields.fxRateDate}) = ₪${fields.buyPrice}`,
      );
      if (apply) {
        await db
          .update(orderLines)
          .set({ ...fields, updatedAt: new Date() })
          .where(sql`${orderLines.id} = ${line.id}`);
      }
    }

    console.log(
      apply
        ? `fx:backfill — converted ${converted}, corrected ${corrected}, left ${skipped} alone.`
        : `fx:backfill — would convert ${converted}, would correct ${corrected}, would leave ${skipped} alone. ` +
            "Re-run with --apply to write.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
