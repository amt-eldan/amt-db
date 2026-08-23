/**
 * Convert the dollar buy prices of lines that already have a delivery date.
 *
 *   npm run fx:backfill            # report only, writes nothing
 *   npm run fx:backfill -- --apply # actually convert
 *
 * For history. Going forward the twice-daily run converts a line the moment its
 * delivery date arrives (see src/lib/shipment-write.ts); this exists for the rows
 * that were already delivered when the columns were added, and for re-running
 * after a `buy_price_usd` is filled in by hand.
 *
 * Dry by default, and never touches a shekel price a person owns: a line whose
 * fx_rate_source is anything other than 'boi' was decided by a human, and this
 * script is not the place to overrule that. Rates come from the same cache the
 * app uses, so a backfill over one month costs a handful of requests.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { and, isNotNull, sql } from "drizzle-orm";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { orderLines } from "../src/db/schema";
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
      .where(and(isNotNull(orderLines.buyPriceUsd), isNotNull(orderLines.deliveredAt)))
      .orderBy(orderLines.deliveredAt);

    console.log(`fx:backfill — ${candidates.length} lines have a dollar price and a delivery date.`);

    let converted = 0;
    let skipped = 0;
    for (const line of candidates) {
      const fields = await convertBuyPriceToIls(line, line.buyPriceUsd, line.deliveredAt);
      if (Object.keys(fields).length === 0) {
        skipped++;
        continue;
      }
      console.log(
        `  line ${line.id}: $${line.buyPriceUsd} × ${fields.fxRate} ` +
          `(${fields.fxRateDate}) = ₪${fields.buyPrice}`,
      );
      if (apply) {
        await db
          .update(orderLines)
          .set({ ...fields, updatedAt: new Date() })
          .where(sql`${orderLines.id} = ${line.id}`);
      }
      converted++;
    }

    console.log(
      apply
        ? `fx:backfill — converted ${converted}, left ${skipped} alone.`
        : `fx:backfill — would convert ${converted}, would leave ${skipped} alone. ` +
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
