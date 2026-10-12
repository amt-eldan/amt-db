import { describe, expect, it } from "vitest";
import { comparePurchaseOrder, poPriceLabel, type PoCompareLine } from "./po-compare";

function line(over: Partial<PoCompareLine> = {}): PoCompareLine {
  return {
    qty: "100",
    buyPrice: null,
    buyPriceForeign: "2.5",
    buyCurrency: "USD",
    fxRate: null,
    fxRateSource: null,
    poUnitCost: "2.5",
    poCurrency: "USD",
    poQty: "100",
    ...over,
  };
}

describe("comparePurchaseOrder", () => {
  it("has nothing to say about a line no purchase order was read for", () => {
    const cmp = comparePurchaseOrder(
      line({ poUnitCost: null, poCurrency: null, poQty: null }),
    );
    expect(cmp.qty.check).toBe("none");
    expect(cmp.price.check).toBe("none");
    expect(cmp.mismatch).toBe(false);
  });

  it("agrees when the entry is what the order said", () => {
    const cmp = comparePurchaseOrder(line());
    expect(cmp.qty.check).toBe("match");
    expect(cmp.price.check).toBe("match");
    expect(cmp.mismatch).toBe(false);
  });

  it("flags a typed quantity that differs from the order", () => {
    const cmp = comparePurchaseOrder(line({ qty: "10" }));
    expect(cmp.qty).toMatchObject({ check: "mismatch", po: 100, entered: 10 });
    expect(cmp.mismatch).toBe(true);
  });

  it("flags a foreign price that differs from the order", () => {
    const cmp = comparePurchaseOrder(line({ buyPriceForeign: "2.75" }));
    expect(cmp.price).toMatchObject({ check: "mismatch", po: 2.5, entered: 2.75 });
  });

  // A document printed to four decimals and a person typing two must not disagree.
  it("absorbs rounding", () => {
    expect(
      comparePurchaseOrder(line({ poUnitCost: "0.01234", buyPriceForeign: "0.0123" })).price
        .check,
    ).toBe("match");
  });

  it("treats a price recorded in another currency as a disagreement", () => {
    const cmp = comparePurchaseOrder(line({ poCurrency: "EUR", buyCurrency: "USD" }));
    expect(cmp.price).toMatchObject({ check: "mismatch", enteredCurrency: "USD" });
  });

  it("compares a shekel order against the shekel buy price", () => {
    const base = { poCurrency: "ILS", poUnitCost: "40", buyPriceForeign: null, buyCurrency: null };
    expect(comparePurchaseOrder(line({ ...base, buyPrice: "40" })).price.check).toBe("match");
    expect(comparePurchaseOrder(line({ ...base, buyPrice: "44" })).price.check).toBe("mismatch");
    expect(comparePurchaseOrder(line({ ...base, buyPrice: null })).price.check).toBe("missing");
  });

  // The shekel price someone typed is what profit is computed from, so it is the
  // entry that matters — compared through the rate the line carries.
  it("compares a hand-typed shekel price through the line's own rate", () => {
    const typed = { fxRateSource: "manual", fxRate: "4", poCurrency: "USD", buyCurrency: "USD" };
    expect(comparePurchaseOrder(line({ ...typed, buyPrice: "10" })).price).toMatchObject({
      check: "match",
      entered: 2.5,
      via: "ils-at-rate",
    });
    expect(comparePurchaseOrder(line({ ...typed, buyPrice: "12" })).price.check).toBe("mismatch");
  });

  it("says when a typed shekel price cannot be compared for lack of a rate", () => {
    const cmp = comparePurchaseOrder(
      line({ fxRateSource: "manual", fxRate: null, buyPrice: "10" }),
    );
    expect(cmp.price.check).toBe("incomparable");
    expect(cmp.mismatch).toBe(false);
  });

  it("reports an order figure nothing was entered against as missing, not as a gap", () => {
    const cmp = comparePurchaseOrder(line({ qty: null, buyPriceForeign: null, buyCurrency: null }));
    expect(cmp.qty.check).toBe("missing");
    expect(cmp.price.check).toBe("missing");
    expect(cmp.mismatch).toBe(false);
  });
});

describe("poPriceLabel", () => {
  it("prints the order's currency symbol", () => {
    expect(poPriceLabel(12.5, "EUR")).toBe("€12.5");
    expect(poPriceLabel(3, "GBP")).toBe("£3");
    expect(poPriceLabel(null, "USD")).toBe("—");
  });
});

describe("comparePurchaseOrder — a shekel price on a line with no rate of its own", () => {
  const typedBeforeDelivery = {
    buyPrice: "307.8", // a decimal in the wrong place: $10 is about ₪30.78
    fxRateSource: "manual",
    fxRate: null,
    buyPriceForeign: null,
    buyCurrency: null,
    poUnitCost: "10",
    poCurrency: "USD",
  };

  it("compares it through the latest published rate", () => {
    const cmp = comparePurchaseOrder(line(typedBeforeDelivery), { USD: 3.078 });
    expect(cmp.price).toMatchObject({ check: "mismatch", via: "ils-at-reference" });
    expect(cmp.mismatch).toBe(true);
  });

  it("does not judge a closed line by today's rate", () => {
    const cmp = comparePurchaseOrder(line({ ...typedBeforeDelivery, isOpen: false }), { USD: 3.078 });
    expect(cmp.price.check).toBe("incomparable");
    expect(cmp.mismatch).toBe(false);
  });

  it("allows for the rate having moved since the price was set", () => {
    expect(
      comparePurchaseOrder(line({ ...typedBeforeDelivery, buyPrice: "31.5" }), { USD: 3.078 }).price
        .check,
    ).toBe("match");
  });

  // Typed before fx_rate_source existed: a person's price all the same.
  it("treats a shekel price with no recorded source as typed by a person", () => {
    const cmp = comparePurchaseOrder(
      line({ ...typedBeforeDelivery, fxRateSource: null, buyPriceForeign: "10", buyCurrency: "USD" }),
      { USD: 3.078 },
    );
    expect(cmp.price).toMatchObject({ check: "mismatch", via: "ils-at-reference" });
  });

  it("prefers the line's own rate when it has one in the order's currency", () => {
    const cmp = comparePurchaseOrder(
      line({ ...typedBeforeDelivery, buyPrice: "30", fxRate: "3", buyCurrency: "USD" }),
      { USD: 3.5 },
    );
    expect(cmp.price).toMatchObject({ check: "match", via: "ils-at-rate" });
  });
});
