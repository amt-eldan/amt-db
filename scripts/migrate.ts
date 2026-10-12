/**
 * Apply pending migrations from ./drizzle. Runs in two places:
 *
 *   npm run db:migrate   — by hand, against .env.local
 *   npm run build        — on every deploy, before `next build`
 *
 * The second one is the point. A schema change reaches production the moment its
 * code does, and code that queries a table the database does not have takes the
 * whole page down — /invoices did exactly that after supplier_invoices shipped
 * without its migration being run. Nobody remembers a manual step; the build
 * does.
 *
 * Uses drizzle-orm's migrator, the same one `drizzle-kit migrate` calls
 * internally, so it reads and writes the same drizzle.__drizzle_migrations
 * bookkeeping: migrations already applied by hand are not applied twice.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import ws from "ws";
import { isAlreadyExists } from "../src/lib/pg-error";

if (typeof WebSocket === "undefined") {
  neonConfig.webSocketConstructor = ws;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    // A build with no database configured (fresh clone, preview environment
    // without env vars) must not fail here: there is nothing to migrate, and
    // failing would hide the real problem behind a migration error.
    console.warn("db:migrate — DATABASE_URL is not set, skipping migrations.");
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
    console.log("db:migrate — schema is up to date.");
    await releaseLegacyDollarPrices(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Moves any dollar price still sitting in the retired `buy_price_usd` column into
 * `buy_price_foreign` + `buy_currency`, and empties the old column.
 *
 * Not a migration, on purpose. A migration runs once, at the first build that
 * sees it — and a preview build sharing the database can be that build, hours
 * before production. Meanwhile the deployment still serving keeps writing dollar
 * prices to the old column only, and the new code reads only the new ones. This
 * runs at every build instead, right before that build's code goes live, so the
 * production build carries over whatever the old deployment wrote up to then.
 *
 * Emptying the old column is what makes running it every time safe: the new code
 * never writes `buy_price_usd` (and clears it whenever it sets a foreign price —
 * see applyLineFields), so after the switch this finds nothing, and a value here
 * is always newer than anything the new code wrote. Two exceptions keep the newer
 * figure where it is: a line whose price our purchase-order upload set
 * (`po_unit_cost`), and a line already priced in another currency. Every line it
 * actually changes gets an audit_log row.
 */
async function releaseLegacyDollarPrices(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`
    WITH candidates AS (
      SELECT id, buy_price_usd AS usd, buy_price_foreign AS old_foreign, buy_currency AS old_currency,
        (po_unit_cost IS NULL AND (buy_price_foreign IS NULL OR coalesce(buy_currency, 'USD') = 'USD')) AS takes_it
      FROM order_lines
      WHERE buy_price_usd IS NOT NULL
    ),
    moved AS (
      UPDATE order_lines l
      SET buy_price_foreign = CASE WHEN c.takes_it THEN c.usd ELSE l.buy_price_foreign END,
          buy_currency = CASE WHEN c.takes_it THEN 'USD' ELSE l.buy_currency END,
          buy_price_usd = NULL,
          updated_at = now()
      FROM candidates c
      WHERE l.id = c.id
      RETURNING l.id, c.old_foreign, c.old_currency, l.buy_price_foreign AS new_foreign, l.buy_currency AS new_currency
    ),
    audited AS (
      INSERT INTO audit_log (entity, entity_id, action, actor, diff)
      SELECT 'order_line', id, 'update', 'agent:release',
        jsonb_build_object(
          'buyPriceForeign', jsonb_build_object('from', old_foreign, 'to', new_foreign),
          'buyCurrency', jsonb_build_object('from', old_currency, 'to', new_currency),
          'source', jsonb_build_object('script', 'db:migrate', 'reason', 'dollar price written by the previous deployment'))
      FROM moved
      WHERE old_foreign IS DISTINCT FROM new_foreign OR old_currency IS DISTINCT FROM new_currency
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM moved)::int AS cleared, (SELECT count(*) FROM audited)::int AS changed
  `);
  const { cleared, changed } = rows[0] ?? { cleared: 0, changed: 0 };
  if (cleared > 0) {
    console.log(
      `db:migrate — carried over legacy dollar prices: ${changed} line(s) updated, ${cleared} legacy value(s) cleared.`,
    );
  }
}

main().catch((error) => {
  // Non-zero on purpose: a failed migration must fail the deploy rather than
  // ship code whose tables do not exist.
  console.error("db:migrate — failed:", error);
  if (isAlreadyExists(error)) {
    console.error(
      "\nThe database already contains something a migration creates, which means its schema " +
        "was changed without the change being recorded in drizzle.__drizzle_migrations (a " +
        "`drizzle-kit push`, or a statement run by hand). The migrations in ./drizzle are " +
        "written to survive exactly that — every CREATE is IF NOT EXISTS and every ADD " +
        "CONSTRAINT is guarded — so a migration that still fails this way is creating something " +
        "a different hand created differently, and needs a look before it is re-run.",
    );
  }
  process.exit(1);
});
