/**
 * Seed sample data (idempotent-ish: skips if customers already exist).
 * Run: npm run db:seed
 */
import "dotenv/config";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "../src/db/schema";

if (typeof WebSocket === "undefined") {
  neonConfig.webSocketConstructor = ws;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  const existing = await db.select().from(schema.customers).limit(1);
  if (existing.length > 0) {
    console.log("Customers already exist — skipping seed.");
    await pool.end();
    return;
  }

  const [pmo, ness, group134] = await db
    .insert(schema.customers)
    .values([
      { name: "משרד ראש הממשלה" },
      { name: "Ness-Tech" },
      { name: "134", note: 'קבוצת רכש משהב"ט - חטיבת מודיעין' },
    ])
    .returning();

  const [order1] = await db
    .insert(schema.orders)
    .values({
      orderNumber: "0226P02556",
      customerId: pmo.id,
      orderDate: "2026-07-12",
      sourceFormat: "standard",
    })
    .returning();
  await db.insert(schema.orderLines).values([
    {
      orderId: order1.id,
      lineNo: 1,
      pn: "EVK-M101",
      qty: "4",
      unitPrice: "743.8",
      contractDueDate: "2026-07-23",
    },
  ]);

  const [order2] = await db
    .insert(schema.orders)
    .values({
      orderNumber: "4441537295",
      customerId: group134.id,
      orderDate: "2026-06-15",
      sourceFormat: "mod",
    })
    .returning();
  await db.insert(schema.orderLines).values([
    {
      orderId: order2.id,
      lineNo: 1,
      pn: "CH-USB-2-1.0AB",
      sku: "10-813580624",
      qty: "50",
      unitPrice: "12.5",
      contractDueDate: "2026-08-01",
      supplier: "AXTON",
      buyPrice: "7.2",
    },
    {
      orderId: order2.id,
      lineNo: 2,
      pn: "BM12B-GHS-TBT",
      sku: "10-813580625",
      qty: "250",
      unitPrice: "2.2",
      contractDueDate: "2026-06-30",
    },
  ]);

  const [order3] = await db
    .insert(schema.orders)
    .values({
      orderNumber: "5975",
      customerId: ness.id,
      orderDate: "2026-07-01",
      sourceFormat: "manual",
    })
    .returning();
  await db.insert(schema.orderLines).values([
    {
      orderId: order3.id,
      lineNo: 1,
      pn: "MAX77751CEFG",
      qty: "500",
      unitPrice: "9.3",
      contractDueDate: "2026-07-25",
      supplier: "DigiKey",
      buyPrice: "5.1",
      shippingCost: "120",
      bol: "1Z6A11220430546949",
    },
  ]);

  console.log("Seeded 3 customers, 3 orders, 4 lines.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
