import { describe, expect, it } from "vitest";
import {
  buyPriceIsHumanOwned,
  evaluatePoWrite,
  resolvePoLine,
  type PoCandidateLine,
  type PoLine,
} from "./po-match";

function candidate(over: Partial<PoCandidateLine> & { lineId: number }): PoCandidateLine {
  return {
    orderNumber: "5975",
    customerName: "Ness-Tech",
    pn: "STM32L432KBU6",
    sku: null,
    qty: "50",
    poNumber: null,
    supplier: null,
    buyPrice: null,
    buyPriceUsd: null,
    fxRateSource: null,
    isOpen: true,
    ...over,
  };
}

function poLine(over: Partial<PoLine> = {}): PoLine {
  return { pn: "STM32L432KBU6", sku: null, qty: 50, unitCost: 3.4, notes: null, ...over };
}

describe("resolvePoLine", () => {
  it("matches the one open line with that part number", () => {
    const r = resolvePoLine(poLine(), [candidate({ lineId: 42 })]);
    expect(r).toEqual({ lineId: 42, matchedBy: "pn" });
  });

  it("matches through retyping — separators and case do not identify a part", () => {
    const r = resolvePoLine(poLine({ pn: "stm32l432-kbu6" }), [candidate({ lineId: 42 })]);
    expect(r.lineId).toBe(42);
  });

  it("matches our catalog number when the supplier quotes that instead", () => {
    const r = resolvePoLine(poLine({ pn: null, sku: "345056" }), [
      candidate({ lineId: 42, pn: "STM32L432KBU6", sku: "345056" }),
    ]);
    expect(r).toMatchObject({ lineId: 42, matchedBy: "sku" });
  });

  it("says so when nothing matches", () => {
    const r = resolvePoLine(poLine({ pn: "OTHER-PART" }), [candidate({ lineId: 42 })]);
    expect(r.lineId).toBeNull();
    expect(r.lineId === null && r.reason).toContain("אין שורה שמתאימה");
  });

  it("refuses a line with no identifier at all", () => {
    const r = resolvePoLine(poLine({ pn: null, sku: null }), [candidate({ lineId: 42 })]);
    expect(r.lineId).toBeNull();
    expect(r.lineId === null && r.reason).toContain("אין לפי מה להתאים");
  });

  // A closed line's cost sits in a month that has already been reported.
  it("will not touch a closed line", () => {
    const r = resolvePoLine(poLine(), [candidate({ lineId: 42, isOpen: false })]);
    expect(r.lineId).toBeNull();
    expect(r.lineId === null && r.reason).toContain("סגורות");
  });

  it("prefers the line not already tied to a purchase order", () => {
    const r = resolvePoLine(poLine(), [
      candidate({ lineId: 1, poNumber: "PO-1000" }),
      candidate({ lineId: 2 }),
    ]);
    expect(r.lineId).toBe(2);
  });

  // Our PO orders what the customer ordered, so quantity discriminates here.
  it("breaks a tie on quantity", () => {
    const r = resolvePoLine(poLine({ qty: 50 }), [
      candidate({ lineId: 1, qty: "10" }),
      candidate({ lineId: 2, qty: "50" }),
    ]);
    expect(r).toMatchObject({ lineId: 2, tieBrokenBy: "qty" });
  });

  // The whole point of the doctrine: a P/N repeats, and picking one would put
  // one customer's cost on another customer's line.
  it("reports an ambiguous set instead of choosing", () => {
    const r = resolvePoLine(poLine({ qty: 50 }), [
      candidate({ lineId: 1, qty: "50" }),
      candidate({ lineId: 2, qty: "50" }),
    ]);
    expect(r.lineId).toBeNull();
    expect(r.lineId === null && r.reason).toContain("שורות 1, 2");
  });

  it("does not let quantity create a match it could not otherwise make", () => {
    const r = resolvePoLine(poLine({ qty: 999 }), [
      candidate({ lineId: 1, qty: "50" }),
      candidate({ lineId: 2, qty: "50" }),
    ]);
    expect(r.lineId).toBeNull();
  });
});

describe("evaluatePoWrite", () => {
  it("allows a clean write", () => {
    const v = evaluatePoWrite("PO-8871", poLine(), candidate({ lineId: 42 }));
    expect(v).toEqual({ write: true, warnings: [] });
  });

  it("allows a repeat of the same purchase order", () => {
    const v = evaluatePoWrite("PO-8871", poLine(), candidate({ lineId: 42, poNumber: "PO 8871" }));
    expect(v.write).toBe(true);
  });

  // A different PO on the line means the match itself is suspect.
  it("refuses a line already tied to a different purchase order", () => {
    const v = evaluatePoWrite("PO-8871", poLine(), candidate({ lineId: 42, poNumber: "PO-1000" }));
    expect(v.write).toBe(false);
    expect(!v.write && v.reason).toContain("PO-1000");
  });

  it("refuses a missing or nonsensical cost", () => {
    expect(evaluatePoWrite("PO-1", poLine({ unitCost: null }), candidate({ lineId: 1 })).write).toBe(false);
    expect(evaluatePoWrite("PO-1", poLine({ unitCost: 0 }), candidate({ lineId: 1 })).write).toBe(false);
    expect(evaluatePoWrite("PO-1", poLine({ unitCost: -5 }), candidate({ lineId: 1 })).write).toBe(false);
  });

  it("refuses a closed line and a line that is not there", () => {
    expect(evaluatePoWrite("PO-1", poLine(), candidate({ lineId: 1, isOpen: false })).write).toBe(false);
    expect(evaluatePoWrite("PO-1", poLine(), undefined).write).toBe(false);
  });

  it("writes the dollars but says a hand-entered shekel price stays", () => {
    const v = evaluatePoWrite(
      "PO-8871",
      poLine(),
      candidate({ lineId: 42, buyPrice: "120", fxRateSource: null }),
    );
    expect(v.write).toBe(true);
    expect(v.write && v.warnings[0]).toContain("הוזן ידנית");
  });

  it("says nothing about a shekel price the system converted itself", () => {
    const v = evaluatePoWrite(
      "PO-8871",
      poLine(),
      candidate({ lineId: 42, buyPrice: "120", fxRateSource: "boi" }),
    );
    expect(v).toEqual({ write: true, warnings: [] });
  });

  it("flags a quantity that disagrees with the line", () => {
    const v = evaluatePoWrite("PO-8871", poLine({ qty: 10 }), candidate({ lineId: 42, qty: "50" }));
    expect(v.write && v.warnings[0]).toContain("שונה מהכמות");
  });
});

describe("buyPriceIsHumanOwned", () => {
  it("is true for a price with no automatic conversion behind it", () => {
    expect(buyPriceIsHumanOwned({ buyPrice: "120", fxRateSource: null })).toBe(true);
    expect(buyPriceIsHumanOwned({ buyPrice: "120", fxRateSource: "manual" })).toBe(true);
  });

  it("is false for a converted price and for no price at all", () => {
    expect(buyPriceIsHumanOwned({ buyPrice: "120", fxRateSource: "boi" })).toBe(false);
    expect(buyPriceIsHumanOwned({ buyPrice: null, fxRateSource: null })).toBe(false);
    expect(buyPriceIsHumanOwned({ buyPrice: "", fxRateSource: null })).toBe(false);
  });
});
