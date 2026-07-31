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
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  // Non-zero on purpose: a failed migration must fail the deploy rather than
  // ship code whose tables do not exist.
  console.error("db:migrate — failed:", error);
  process.exit(1);
});
