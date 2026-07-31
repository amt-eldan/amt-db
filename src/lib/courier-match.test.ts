import { describe, expect, it } from "vitest";
import {
  allocationTotals,
  allocationsFromShipments,
  matchShipmentsToLines,
  normalizeTracking,
  splitAmount,
  type CourierLineOption,
  type CourierShipment,
} from "./courier-match";

function line(over: Partial<CourierLineOption> & { lineId: number }): CourierLineOption {
  return {
    orderNumber: "0226P02556",
    customerName: "משרד ראש הממשלה",
    pn: "CH-USB-2",
    poNumber: null,
    bol: null,
    shippingCost: null,
    orderDate: "2026-07-01",
    isOpen: true,
    ...over,
  };
}

function shipment(over: Partial<CourierShipment> = {}): CourierShipment {
  return { bol: null, reference: null, description: null, amount: null, lineId: null, ...over };
}

describe("normalizeTracking", () => {
  it("ignores case, spaces and dashes", () => {
    expect(normalizeTracking("1Z 999-AA1")).toBe(normalizeTracking("1z999aa1"));
  });

  it("treats missing values as empty (never matches)", () => {
    expect(normalizeTracking(null)).toBe("");
    expect(normalizeTracking("  ")).toBe("");
  });
});

describe("splitAmount", () => {
  it("keeps the parts adding up to the whole", () => {
    expect(splitAmount(10, 3)).toEqual(["3.34", "3.33", "3.33"]);
  });

  it("splits evenly when it divides", () => {
    expect(splitAmount(90, 2)).toEqual(["45.00", "45.00"]);
  });

  it("handles a credit (negative amount) without losing an agora", () => {
    expect(splitAmount(-10, 3)).toEqual(["-3.34", "-3.33", "-3.33"]);
  });
});

describe("matchShipmentsToLines", () => {
  const lines = [
    line({ lineId: 1, bol: "1Z999AA1", poNumber: "PO-8871" }),
    line({ lineId: 2, bol: "1Z999AA2", poNumber: "PO-8872", orderNumber: "4441537295" }),
  ];

  it("matches on the tracking number, however it was typed", () => {
    const [matched] = matchShipmentsToLines([shipment({ bol: "1z 999-aa2", amount: "90" })], lines);
    expect(matched.lineId).toBe(2);
    expect(matched.matchedBy).toBe("bol");
    expect(matched.amount).toBe("90.00");
  });

  it("splits one shipment across every line it covers", () => {
    const covered = [
      line({ lineId: 5, bol: "SAME-BOL" }),
      line({ lineId: 6, bol: "SAME-BOL" }),
      line({ lineId: 7, bol: "SAME-BOL" }),
    ];
    const rows = matchShipmentsToLines([shipment({ bol: "SAME-BOL", amount: "10" })], covered);
    expect(rows.map((r) => r.lineId)).toEqual([5, 6, 7]);
    expect(rows.map((r) => r.amount)).toEqual(["3.34", "3.33", "3.33"]);
    expect(rows.every((r) => r.splitCount === 3)).toBe(true);
  });

  it("falls back to the PO number the courier quoted", () => {
    const [matched] = matchShipmentsToLines(
      [shipment({ reference: "PO-8871", amount: "40" })],
      lines,
    );
    expect(matched.lineId).toBe(1);
    expect(matched.matchedBy).toBe("po");
  });

  it("falls back to the order number when the PO does not match", () => {
    const [matched] = matchShipmentsToLines([shipment({ reference: "4441537295" })], lines);
    expect(matched.lineId).toBe(2);
    expect(matched.matchedBy).toBe("order");
  });

  it("prefers the tracking number over the reference when both match", () => {
    const [matched] = matchShipmentsToLines(
      [shipment({ bol: "1Z999AA2", reference: "PO-8871" })],
      lines,
    );
    expect(matched.lineId).toBe(2);
    expect(matched.matchedBy).toBe("bol");
  });

  it("leaves a shipment it cannot place for a human to place", () => {
    const [matched] = matchShipmentsToLines(
      [shipment({ bol: "UNKNOWN-9", amount: "25" })],
      lines,
    );
    expect(matched.lineId).toBeNull();
    expect(matched.matchedBy).toBeNull();
    expect(matched.amount).toBe("25");
  });

  it("never overrides a line the reviewer already chose", () => {
    const [matched] = matchShipmentsToLines(
      [shipment({ bol: "1Z999AA1", lineId: 2, amount: "12" })],
      lines,
    );
    expect(matched.lineId).toBe(2);
    expect(matched.matchedBy).toBe("manual");
  });

  it("keeps an unpriced shipment unpriced when it splits", () => {
    const covered = [line({ lineId: 5, bol: "B" }), line({ lineId: 6, bol: "B" })];
    const rows = matchShipmentsToLines([shipment({ bol: "B" })], covered);
    expect(rows.map((r) => r.amount)).toEqual([null, null]);
  });
});

describe("allocationsFromShipments", () => {
  it("sums two shipments on the same line into one allocation", () => {
    const rows = allocationsFromShipments([
      shipment({ lineId: 3, amount: "10.10", bol: "A", description: "אווירי" }),
      shipment({ lineId: 3, amount: "20.20", bol: "B", description: "יבשתי" }),
    ]);
    expect(rows).toEqual([
      { lineId: 3, amount: "30.30", bol: "A, B", description: "אווירי · יבשתי" },
    ]);
  });

  it("drops shipments with no line and shipments with no amount", () => {
    const rows = allocationsFromShipments([
      shipment({ lineId: null, amount: "50" }),
      shipment({ lineId: 4, amount: null }),
      shipment({ lineId: 5, amount: "7" }),
    ]);
    expect(rows).toEqual([{ lineId: 5, amount: "7.00", bol: null, description: null }]);
  });

  it("does not repeat the same tracking number or note", () => {
    const rows = allocationsFromShipments([
      shipment({ lineId: 1, amount: "5", bol: "A", description: "משלוח" }),
      shipment({ lineId: 1, amount: "5", bol: "A", description: "משלוח" }),
    ]);
    expect(rows[0].bol).toBe("A");
    expect(rows[0].description).toBe("משלוח");
  });
});

describe("allocationTotals", () => {
  it("reports the gap between the split and the invoice total", () => {
    const totals = allocationTotals(
      [
        shipment({ lineId: 1, amount: "40" }),
        shipment({ lineId: 2, amount: "50" }),
        shipment({ lineId: null, amount: "10" }),
      ],
      "100",
    );
    expect(totals.allocated).toBe(90);
    expect(totals.lines).toBe(2);
    expect(totals.unmatched).toBe(1);
    expect(totals.difference).toBe(-10);
  });

  it("has no gap to report when the invoice has no total", () => {
    expect(allocationTotals([shipment({ lineId: 1, amount: "40" })], null).difference).toBeNull();
  });

  it("adds money in agorot", () => {
    const totals = allocationTotals(
      [shipment({ lineId: 1, amount: "0.1" }), shipment({ lineId: 2, amount: "0.2" })],
      "0.3",
    );
    expect(totals.allocated).toBe(0.3);
    expect(totals.difference).toBe(0);
  });
});
