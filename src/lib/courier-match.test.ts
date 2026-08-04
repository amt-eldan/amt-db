import { describe, expect, it } from "vitest";
import {
  acceptGuess,
  allocationTotals,
  allocationsFromShipments,
  chargeTolerance,
  chargeTotals,
  isLowConfidence,
  matchShipmentsToLines,
  normalizeSupplier,
  normalizeTracking,
  shipmentTotal,
  splitAmount,
  suppliersMatch,
  SUPPLIER_WINDOW_DAYS,
  type CourierCharge,
  type CourierChargeKind,
  type CourierLineOption,
  type CourierShipment,
} from "./courier-match";

function line(over: Partial<CourierLineOption> & { lineId: number }): CourierLineOption {
  return {
    orderNumber: "0226P02556",
    customerName: "משרד ראש הממשלה",
    pn: "CH-USB-2",
    poNumber: null,
    supplier: null,
    bol: null,
    shippingCost: null,
    orderDate: "2026-07-01",
    isOpen: true,
    ...over,
  };
}

/** The yyyy-mm-dd that is `days` before `iso` — for asserting the window edge. */
function daysAgo(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function shipment(over: Partial<CourierShipment> = {}): CourierShipment {
  return {
    bol: null,
    reference: null,
    customsDeclaration: null,
    shipper: null,
    shipmentDate: null,
    description: null,
    amount: null,
    charges: [],
    lineId: null,
    matchedBy: null,
    ...over,
  };
}

function charge(label: string, amount: number | null, kind: CourierChargeKind): CourierCharge {
  return { label, amount: amount === null ? null : String(amount), kind };
}

/**
 * The breakdown of one shipment on the DHL import-tax invoice that prompted this:
 * three customs items, a clearance service and its VAT, adding up to 531.78.
 */
const DHL_CHARGES: CourierCharge[] = [
  charge('מע"מ מהצהרת יבוא', 378, "tax"),
  charge("אגרת מחשב למכס", 21, "fee"),
  charge("אגרת ביטחון למכס", 49, "fee"),
  charge("שירות שחרור ממכס", 71, "service"),
  charge('מע"מ', 12.78, "vat"),
];

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

  it("splits the breakdown with the total, so each part still explains itself", () => {
    const covered = [line({ lineId: 5, bol: "SAME-BOL" }), line({ lineId: 6, bol: "SAME-BOL" })];
    const rows = matchShipmentsToLines(
      [shipment({ bol: "SAME-BOL", amount: "531.78", charges: DHL_CHARGES })],
      covered,
    );
    expect(rows.map((r) => r.amount)).toEqual(["265.89", "265.89"]);
    // Each part carries half of every component, not a copy of the whole bill.
    expect(rows[0].charges.map((c) => c.amount)).toEqual([
      "189.00",
      "10.50",
      "24.50",
      "35.50",
      "6.39",
    ]);
    for (const row of rows) {
      expect(chargeTotals(row, chargeTolerance(row.charges)).difference).toBe(0);
    }
  });

  it("splits a shipment whose total was only ever a breakdown", () => {
    const covered = [line({ lineId: 5, bol: "SAME-BOL" }), line({ lineId: 6, bol: "SAME-BOL" })];
    const rows = matchShipmentsToLines(
      [shipment({ bol: "SAME-BOL", charges: [charge("שירות", 10, "service")] })],
      covered,
    );
    expect(rows.map((r) => r.amount)).toEqual(["5.00", "5.00"]);
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

  it("reports the VAT the breakdowns account for, across the invoice", () => {
    const totals = allocationTotals(
      [
        shipment({ lineId: 1, amount: "531.78", charges: DHL_CHARGES }),
        shipment({
          lineId: 2,
          amount: "361.08",
          charges: [
            charge("תהליך שחרור פורמלי מהמכס", 306, "service"),
            charge('מע"מ', 55.08, "vat"),
          ],
        }),
      ],
      "892.86",
    );
    expect(totals.vat).toBe(67.86);
    expect(totals.unreconciled).toBe(0);
    expect(totals.difference).toBe(0);
  });

  it("counts the shipments whose breakdown does not add up to their total", () => {
    const totals = allocationTotals(
      [
        shipment({ lineId: 1, amount: "531.78", charges: DHL_CHARGES }),
        shipment({ lineId: 2, amount: "100", charges: [charge("שירות", 90, "service")] }),
      ],
      null,
    );
    expect(totals.unreconciled).toBe(1);
  });
});

describe("chargeTotals", () => {
  it("adds the itemized charges up and names the VAT among them", () => {
    const totals = chargeTotals(shipment({ amount: "531.78", charges: DHL_CHARGES }));
    expect(totals.sum).toBe(531.78);
    expect(totals.vat).toBe(12.78);
    expect(totals.difference).toBe(0);
    expect(totals.missing).toBe(0);
  });

  it("reports the gap when the breakdown misses the shipment's own total", () => {
    const totals = chargeTotals(
      shipment({ amount: "531.78", charges: DHL_CHARGES.slice(0, 4) }),
    );
    expect(totals.difference).toBe(-12.78);
  });

  it("counts components whose amount could not be read", () => {
    const totals = chargeTotals(
      shipment({ amount: "100", charges: [charge("שירות", 100, "service"), charge("אגרה", null, "fee")] }),
    );
    expect(totals.sum).toBe(100);
    expect(totals.missing).toBe(1);
  });

  it("has nothing to compare when the shipment has no breakdown", () => {
    const totals = chargeTotals(shipment({ amount: "100" }));
    expect(totals.sum).toBeNull();
    expect(totals.difference).toBeNull();
    expect(totals.vat).toBe(0);
  });

  it("forgives the agora-level slack a split leaves behind", () => {
    // Each component is rounded on its own, so a part of a split shipment can miss
    // its own total by an agora per component without anything being wrong.
    const covered = [1, 2, 3].map((lineId) => line({ lineId, bol: "SAME-BOL" }));
    const rows = matchShipmentsToLines(
      [
        shipment({
          bol: "SAME-BOL",
          amount: "0.10",
          charges: [charge("שירות", 0.05, "service"), charge('מע"מ', 0.05, "vat")],
        }),
      ],
      covered,
    );
    const gaps = rows.map((r) => chargeTotals(r).difference);
    expect(gaps).toEqual([0, 0.01, -0.01]);
    for (const row of rows) {
      expect(chargeTotals(row, chargeTolerance(row.charges)).difference).toBe(0);
    }
  });
});

describe("shipmentTotal", () => {
  it("prefers the total the courier printed", () => {
    expect(shipmentTotal(shipment({ amount: "500", charges: DHL_CHARGES }))).toBe(500);
  });

  it("falls back to what the itemized charges add up to", () => {
    expect(shipmentTotal(shipment({ charges: DHL_CHARGES }))).toBe(531.78);
  });

  it("stays null when neither the total nor a breakdown is known", () => {
    expect(shipmentTotal(shipment())).toBeNull();
  });

  it("allocates a shipment that has only a breakdown", () => {
    const rows = allocationsFromShipments([shipment({ lineId: 3, charges: DHL_CHARGES })]);
    expect(rows).toEqual([{ lineId: 3, amount: "531.78", bol: null, description: null }]);
  });
});

describe("normalizeSupplier", () => {
  it("strips legal forms, punctuation and case so one supplier reads as one name", () => {
    expect(normalizeSupplier("ATIC (HK)TECHNOLOGY CO,LTD")).toEqual(["ATIC", "HK", "TECHNOLOGY"]);
    expect(normalizeSupplier("Taoglas Limited")).toEqual(["TAOGLAS"]);
    expect(normalizeSupplier("  texas   instruments  ")).toEqual(["TEXAS", "INSTRUMENTS"]);
  });

  it("has nothing to say about an empty name", () => {
    expect(normalizeSupplier(null)).toEqual([]);
    expect(normalizeSupplier("  ")).toEqual([]);
    expect(normalizeSupplier("Ltd.")).toEqual([]); // a legal form alone is not a name
  });
});

describe("suppliersMatch", () => {
  // The three senders printed on the DHL import-tax invoice, against how the same
  // suppliers are typed into order_lines.
  it("matches the same supplier written two ways", () => {
    expect(suppliersMatch("ATIC (HK)TECHNOLOGY CO,LTD", "ATIC Technology")).toBe(true);
    expect(suppliersMatch("TEXAS INSTRUMENTS SOUTHEAST ASIA PL", "Texas Instruments")).toBe(true);
    expect(suppliersMatch("TAOGLAS LIMITED IRELAND", "Taoglas")).toBe(true);
  });

  it("refuses two different suppliers that share a word", () => {
    expect(suppliersMatch("ATIC (HK)TECHNOLOGY CO,LTD", "AVNET Technology")).toBe(false);
    expect(suppliersMatch("Texas Instruments", "Texas Electronics")).toBe(false);
  });

  it("refuses a match carried only by a country or a filler word", () => {
    // Shared token is ASIA — locates, does not identify.
    expect(suppliersMatch("ASIA ELECTRONICS LTD", "ASIA")).toBe(false);
    expect(suppliersMatch("GLOBAL PARTS LTD", "GLOBAL")).toBe(false);
  });

  it("refuses when one name is only a fragment of a word in the other", () => {
    // Containment is by whole token: `TAO` is not `TAOGLAS`.
    expect(suppliersMatch("TAO", "TAOGLAS")).toBe(false);
  });

  it("refuses a match on a short shared token", () => {
    expect(suppliersMatch("ABC Systems", "ABC")).toBe(false); // 3 chars is not distinctive
  });

  it("never matches a missing name", () => {
    expect(suppliersMatch(null, "Taoglas")).toBe(false);
    expect(suppliersMatch("Taoglas", null)).toBe(false);
  });
});

describe("matchShipmentsToLines — the supplier key", () => {
  const dhl = { shipper: "TAOGLAS LIMITED IRELAND", shipmentDate: "2026-08-01", amount: "531.78" };
  /** One open, uncosted Taoglas line ordered inside the window. */
  const taoglas = line({ lineId: 7, supplier: "Taoglas", orderDate: "2026-07-01" });

  it("places a shipment that has no asmachta at all, by supplier and date", () => {
    const [matched] = matchShipmentsToLines([shipment(dhl)], [taoglas]);
    expect(matched.lineId).toBe(7);
    expect(matched.matchedBy).toBe("supplier");
  });

  it("marks the guess low-confidence so the rest of the system can quarantine it", () => {
    const [matched] = matchShipmentsToLines([shipment(dhl)], [taoglas]);
    expect(isLowConfidence(matched.matchedBy)).toBe(true);
  });

  it("refuses to choose between two lines that both fit", () => {
    const [matched] = matchShipmentsToLines(
      [shipment(dhl)],
      [taoglas, line({ lineId: 8, supplier: "Taoglas", orderDate: "2026-07-02" })],
    );
    expect(matched.lineId).toBeNull();
    expect(matched.matchedBy).toBeNull();
  });

  it("ignores a closed line — that money is settled", () => {
    const [matched] = matchShipmentsToLines([shipment(dhl)], [{ ...taoglas, isOpen: false }]);
    expect(matched.lineId).toBeNull();
  });

  it("ignores a line that already carries a shipping cost", () => {
    const [matched] = matchShipmentsToLines([shipment(dhl)], [{ ...taoglas, shippingCost: "120" }]);
    expect(matched.lineId).toBeNull();
  });

  it("ignores an order too old to be this shipment", () => {
    const old = { ...taoglas, orderDate: "2025-01-01" };
    expect(matchShipmentsToLines([shipment(dhl)], [old])[0].lineId).toBeNull();
  });

  it("ignores an order placed after the shipment — that is not its shipment", () => {
    const later = { ...taoglas, orderDate: "2026-09-01" };
    expect(matchShipmentsToLines([shipment(dhl)], [later])[0].lineId).toBeNull();
  });

  it("matches at the far edge of the window and not one day past it", () => {
    const edge = { ...taoglas, orderDate: "2026-08-01" };
    const inWindow = daysAgo("2026-08-01", SUPPLIER_WINDOW_DAYS);
    const outWindow = daysAgo("2026-08-01", SUPPLIER_WINDOW_DAYS + 1);
    expect(
      matchShipmentsToLines([shipment(dhl)], [{ ...edge, orderDate: inWindow }])[0].lineId,
    ).toBe(7);
    expect(
      matchShipmentsToLines([shipment(dhl)], [{ ...edge, orderDate: outWindow }])[0].lineId,
    ).toBeNull();
  });

  it("needs both a sender and a date before it will guess at all", () => {
    expect(matchShipmentsToLines([shipment({ ...dhl, shipper: null })], [taoglas])[0].lineId)
      .toBeNull();
    expect(matchShipmentsToLines([shipment({ ...dhl, shipmentDate: null })], [taoglas])[0].lineId)
      .toBeNull();
  });

  it("never uses the customs declaration as a key, even against a matching order number", () => {
    // The trap: a declaration number that happens to equal a real order number.
    const collide = line({ lineId: 9, orderNumber: "465953602", supplier: "Someone Else" });
    const [matched] = matchShipmentsToLines(
      [shipment({ customsDeclaration: "465953602", amount: "531.78" })],
      [collide],
    );
    expect(matched.lineId).toBeNull();
  });

  it("prefers a tracking number over a supplier guess", () => {
    const byBol = line({ lineId: 3, bol: "1Z999AA9", supplier: "Taoglas", orderDate: "2026-07-01" });
    const [matched] = matchShipmentsToLines([shipment({ ...dhl, bol: "1Z999AA9" })], [byBol]);
    expect(matched.matchedBy).toBe("bol");
  });

  it("does not split a guess across several lines the way a tracking number splits", () => {
    // Two lines, same supplier, both in window: ambiguous, so nothing is placed —
    // rather than one cost divided between them on a coincidence.
    const rows = matchShipmentsToLines(
      [shipment(dhl)],
      [taoglas, line({ lineId: 8, supplier: "Taoglas Ltd", orderDate: "2026-07-10" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].lineId).toBeNull();
  });

  it("keeps a guess a guess when the matcher runs again over the staged row", () => {
    const staged = shipment({ ...dhl, lineId: 7, matchedBy: "supplier" });
    const [again] = matchShipmentsToLines([staged], [taoglas]);
    expect(again.matchedBy).toBe("supplier");
  });

  it("still treats a human's own choice as a human's choice on re-run", () => {
    const chosen = shipment({ ...dhl, lineId: 7, matchedBy: "manual" });
    expect(matchShipmentsToLines([chosen], [taoglas])[0].matchedBy).toBe("manual");
  });
});

describe("a guess cannot become money until it is accepted", () => {
  const guess = shipment({ lineId: 7, amount: "531.78", matchedBy: "supplier" });

  it("is left out of the allocations", () => {
    expect(allocationsFromShipments([guess])).toEqual([]);
  });

  it("allocates once accepted", () => {
    expect(allocationsFromShipments([acceptGuess(guess)])).toEqual([
      { lineId: 7, amount: "531.78", bol: null, description: null },
    ]);
  });

  it("leaves a key match alone — acceptGuess only touches guesses", () => {
    const byBol = shipment({ lineId: 7, amount: "531.78", matchedBy: "bol" });
    expect(acceptGuess(byBol)).toBe(byBol);
  });

  it("is counted and excluded from the total, so the card can explain the gap", () => {
    const totals = allocationTotals([guess], "531.78");
    expect(totals.pendingGuesses).toBe(1);
    expect(totals.allocated).toBe(0);
    expect(totals.lines).toBe(0);
    expect(totals.difference).toBe(-531.78);
  });

  it("stops being pending, and starts counting, once accepted", () => {
    const totals = allocationTotals([acceptGuess(guess)], "531.78");
    expect(totals.pendingGuesses).toBe(0);
    expect(totals.allocated).toBe(531.78);
    expect(totals.difference).toBe(0);
  });
});
