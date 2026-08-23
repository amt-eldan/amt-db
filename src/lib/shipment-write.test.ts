import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderLine } from "@/db/schema";
import { shipmentUpdateInput } from "./validation";

// Same harness as bol-write.test.ts: `inArray` is stubbed to a plain { ids } so
// the fake database can see which ids were asked for without pulling in drizzle's
// expression machinery.
const { rows, applyLineFields, revalidatePath, representativeRateOn } = vi.hoisted(() => ({
  rows: new Map<number, unknown>(),
  applyLineFields: vi.fn(),
  revalidatePath: vi.fn(),
  representativeRateOn: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ inArray: (_column: unknown, ids: number[]) => ({ ids }) }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./line-fields", () => ({ applyLineFields }));
vi.mock("./fx-fetch", () => ({ representativeRateOn }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: ({ ids }: { ids: number[] }) =>
          Promise.resolve(ids.filter((id) => rows.has(id)).map((id) => rows.get(id))),
      }),
    }),
  },
}));

const { writeShipmentUpdates } = await import("./shipment-write");

/** An open line that already holds a tracking number — the normal target. */
function line(over: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 42,
    bol: "1Z999AA10123456784",
    isOpen: true,
    carrier: null,
    shipmentStatus: null,
    shipmentStatusAt: null,
    shipmentEta: null,
    deliveredAt: null,
    deliveryUpdate: null,
    buyPrice: null,
    buyPriceUsd: null,
    fxRate: null,
    fxRateDate: null,
    fxRateSource: null,
    ...over,
  } as OrderLine;
}

const update = (over: Record<string, unknown> = {}) =>
  shipmentUpdateInput.parse({ lineId: 42, status: "in_transit", ...over });

const writtenFields = (call = 0) => applyLineFields.mock.calls[call][1] as Record<string, unknown>;
const provenance = (call = 0) => applyLineFields.mock.calls[call][2] as Record<string, unknown>;

beforeEach(() => {
  rows.clear();
  applyLineFields.mockClear();
  revalidatePath.mockClear();
  representativeRateOn.mockReset();
});

describe("writeShipmentUpdates", () => {
  it("writes the normalized status and stamps when it was observed", async () => {
    rows.set(42, line());
    const summary = await writeShipmentUpdates([update({ status: "delivered", deliveredAt: "2026-08-12" })]);

    expect(summary.written).toBe(1);
    expect(writtenFields()).toMatchObject({
      shipmentStatus: "delivered",
      deliveredAt: "2026-08-12",
    });
    expect(writtenFields().shipmentStatusAt).toBeInstanceOf(Date);
    expect(applyLineFields.mock.calls[0][3]).toBe("agent:shipment-status");
  });

  it("classifies carrier prose when no explicit status is given", async () => {
    rows.set(42, line());
    await writeShipmentUpdates([
      shipmentUpdateInput.parse({ lineId: 42, statusText: "Delivered - signed for by R. LEVI" }),
    ]);
    expect(writtenFields()).toMatchObject({ shipmentStatus: "delivered" });
  });

  it("prefers an explicit status over the prose", async () => {
    rows.set(42, line());
    // "Out for delivery" contains "deliver" but is not an arrival; the explicit
    // in_transit must win either way.
    await writeShipmentUpdates([update({ status: "in_transit", statusText: "Delivered soon" })]);
    expect(writtenFields()).toMatchObject({ shipmentStatus: "in_transit" });
  });

  it("leaves the column alone when the prose says nothing it can read", async () => {
    rows.set(42, line({ shipmentStatus: "in_transit" }));
    await writeShipmentUpdates([
      shipmentUpdateInput.parse({ lineId: 42, statusText: "?", etaDate: "2026-09-01" }),
    ]);
    expect(writtenFields()).not.toHaveProperty("shipmentStatus");
    expect(writtenFields()).toMatchObject({ shipmentEta: "2026-09-01" });
  });

  // A twice-daily run over a shipment that spends three weeks in transit would
  // otherwise leave forty identical audit rows and bury the real transitions.
  it("writes nothing when nothing changed", async () => {
    rows.set(42, line({ shipmentStatus: "in_transit", deliveryUpdate: "In transit" }));
    const summary = await writeShipmentUpdates([
      update({ status: "in_transit", statusText: "In transit" }),
    ]);
    expect(summary).toMatchObject({ written: 0, unchanged: 1 });
    expect(applyLineFields).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports which fields actually moved", async () => {
    rows.set(42, line({ shipmentStatus: "in_transit" }));
    const summary = await writeShipmentUpdates([update({ status: "delivered", deliveredAt: "2026-08-12" })]);
    expect(summary.results[0].changed).toEqual(
      expect.arrayContaining(["shipmentStatus", "deliveredAt"]),
    );
  });

  it("never overwrites a delivery note a human wrote", async () => {
    rows.set(42, line({ deliveryUpdate: "דיברתי עם הספק, מגיע ברביעי" }));
    await writeShipmentUpdates([update({ statusText: "In transit" })]);
    expect(writtenFields()).not.toHaveProperty("deliveryUpdate");
  });

  it("fills the delivery note while it is still empty", async () => {
    rows.set(42, line());
    await writeShipmentUpdates([update({ statusText: "In transit — Cologne" })]);
    expect(writtenFields()).toMatchObject({ deliveryUpdate: "In transit — Cologne" });
  });

  it("backfills the carrier only when we do not know it", async () => {
    rows.set(42, line({ carrier: "UPS" }));
    await writeShipmentUpdates([update({ carrier: "FedEx" })]);
    expect(writtenFields()).not.toHaveProperty("carrier");

    applyLineFields.mockClear();
    rows.set(43, line({ id: 43, carrier: null }));
    await writeShipmentUpdates([shipmentUpdateInput.parse({ lineId: 43, carrier: "FedEx" })]);
    expect(writtenFields()).toMatchObject({ carrier: "FedEx" });
  });

  // A status report is about a shipment, and a line with no tracking number has
  // none. This is what keeps the two write paths apart.
  it("refuses a line with no bill of lading", async () => {
    rows.set(42, line({ bol: "   " }));
    const summary = await writeShipmentUpdates([update()]);
    expect(summary).toMatchObject({ written: 0, skipped: 1 });
    expect(summary.results[0].reason).toContain("bol");
    expect(applyLineFields).not.toHaveBeenCalled();
  });

  it("skips a missing or closed line", async () => {
    rows.set(43, line({ id: 43, isOpen: false }));
    const summary = await writeShipmentUpdates([
      update(),
      shipmentUpdateInput.parse({ lineId: 43, status: "delivered" }),
    ]);
    expect(summary.skipped).toBe(2);
    expect(summary.results.map((r) => r.reason)).toEqual(["line not found", "line is closed"]);
  });

  it("never touches the tracking number itself", async () => {
    rows.set(42, line());
    await writeShipmentUpdates([update({ status: "delivered", deliveredAt: "2026-08-12" })]);
    expect(writtenFields()).not.toHaveProperty("bol");
  });

  it("records where the status was read, for the audit trail", async () => {
    rows.set(42, line());
    await writeShipmentUpdates([
      update({ statusText: "Delivered", sourceUrl: "https://ups.com/track?x=1" }),
    ]);
    expect(provenance()).toMatchObject({
      agent: "shipment-status",
      url: "https://ups.com/track?x=1",
      carrierStatus: "Delivered",
    });
  });
});

describe("the dollar conversion", () => {
  it("converts at the rate for the delivery date and records that rate", async () => {
    rows.set(42, line());
    representativeRateOn.mockResolvedValue({ rate: "3.721", rateDate: "2026-08-12", source: "boi" });

    await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-12", buyPriceUsd: 41.5 }),
    ]);

    expect(representativeRateOn).toHaveBeenCalledWith("2026-08-12", "USD");
    expect(writtenFields()).toMatchObject({
      buyPriceUsd: "41.5",
      buyPrice: "154.42", // 41.50 × 3.721, to agorot
      fxRate: "3.721",
      fxRateDate: "2026-08-12",
      fxRateSource: "boi",
    });
  });

  // The rate is dated by the delivery, so a delivery on a closed day converts at
  // the last published rate — and the row says which day that was.
  it("stores the rate's own date, not the delivery date", async () => {
    rows.set(42, line());
    representativeRateOn.mockResolvedValue({ rate: "3.7", rateDate: "2026-08-13", source: "boi" });
    await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-15", buyPriceUsd: 10 }),
    ]);
    expect(writtenFields()).toMatchObject({
      deliveredAt: "2026-08-15",
      fxRate: "3.7",
      fxRateDate: "2026-08-13",
    });
  });

  it("uses a delivery date recorded on an earlier run", async () => {
    rows.set(42, line({ deliveredAt: "2026-08-12", shipmentStatus: "delivered" }));
    representativeRateOn.mockResolvedValue({ rate: "3.721", rateDate: "2026-08-12", source: "boi" });
    await writeShipmentUpdates([shipmentUpdateInput.parse({ lineId: 42, buyPriceUsd: 20 })]);
    expect(writtenFields()).toMatchObject({ buyPrice: "74.42", fxRate: "3.721" });
  });

  // A missing rate must read as "ממתין", never as a plausible profit.
  it("leaves the price alone when no rate can be had", async () => {
    rows.set(42, line());
    representativeRateOn.mockResolvedValue(null);
    await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-12", buyPriceUsd: 41.5 }),
    ]);
    const fields = writtenFields();
    expect(fields).toMatchObject({ buyPriceUsd: "41.5" });
    expect(fields).not.toHaveProperty("buyPrice");
    expect(fields).not.toHaveProperty("fxRate");
  });

  it("needs both halves: dollars and a delivery date", async () => {
    rows.set(42, line());
    await writeShipmentUpdates([update({ status: "in_transit", buyPriceUsd: 41.5 })]);
    expect(representativeRateOn).not.toHaveBeenCalled();
    expect(writtenFields()).not.toHaveProperty("buyPrice");
  });

  it("never overwrites a buy price a human entered", async () => {
    rows.set(42, line({ buyPrice: "150", fxRateSource: null }));
    representativeRateOn.mockResolvedValue({ rate: "3.721", rateDate: "2026-08-12", source: "boi" });
    await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-12", buyPriceUsd: 41.5 }),
    ]);
    expect(representativeRateOn).not.toHaveBeenCalled();
    expect(writtenFields()).not.toHaveProperty("buyPrice");
  });

  it("does re-convert a price it converted itself", async () => {
    rows.set(42, line({ buyPrice: "150", fxRateSource: "boi", fxRate: "3.6", fxRateDate: "2026-08-01" }));
    representativeRateOn.mockResolvedValue({ rate: "3.721", rateDate: "2026-08-12", source: "boi" });
    await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-12", buyPriceUsd: 41.5 }),
    ]);
    expect(writtenFields()).toMatchObject({ buyPrice: "154.42", fxRate: "3.721" });
  });

  it("does not re-fetch a rate for a conversion already done", async () => {
    rows.set(
      42,
      line({
        buyPrice: "154.42",
        buyPriceUsd: "41.5",
        fxRate: "3.721",
        fxRateDate: "2026-08-12",
        fxRateSource: "boi",
        shipmentStatus: "delivered",
        deliveredAt: "2026-08-12",
      }),
    );
    const summary = await writeShipmentUpdates([
      update({ status: "delivered", deliveredAt: "2026-08-12", buyPriceUsd: 41.5 }),
    ]);
    expect(representativeRateOn).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ written: 0, unchanged: 1 });
  });
});
