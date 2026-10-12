import { describe, expect, it } from "vitest";
import { agentBuyPrice, normalizeCurrency, staleConversionFields } from "./currency";

describe("normalizeCurrency", () => {
  it("reads the four currencies in their paper spellings", () => {
    expect(["$", "USD", "דולר"].map(normalizeCurrency)).toEqual(["USD", "USD", "USD"]);
    expect(["€", "Euro", "יורו"].map(normalizeCurrency)).toEqual(["EUR", "EUR", "EUR"]);
    expect(["£", "GBP", 'ליש"ט'].map(normalizeCurrency)).toEqual(["GBP", "GBP", "GBP"]);
    expect(["₪", "NIS", 'ש"ח'].map(normalizeCurrency)).toEqual(["ILS", "ILS", "ILS"]);
    expect(normalizeCurrency("CHF")).toBeNull();
  });
});

describe("agentBuyPrice", () => {
  const line = (over: Record<string, string | null> = {}) => ({
    poUnitCost: null,
    buyPriceForeign: null,
    buyCurrency: null,
    ...over,
  });

  it("records a dollar price on a line that has none", () => {
    expect(agentBuyPrice(line(), "9.1").fields).toEqual({
      buyPriceForeign: "9.1",
      buyCurrency: "USD",
    });
  });

  it("leaves a price our purchase order set", () => {
    expect(agentBuyPrice(line({ poUnitCost: "8", buyPriceForeign: "8", buyCurrency: "EUR" }), "9.1"))
      .toEqual({ fields: {}, amount: "8", currency: "EUR" });
  });

  // A dollar figure from a shipping mail is not a correction of a euro price.
  it("leaves a price someone typed in euros or pounds", () => {
    expect(agentBuyPrice(line({ buyPriceForeign: "8.2", buyCurrency: "GBP" }), "9.1").fields).toEqual(
      {},
    );
  });
});

describe("staleConversionFields", () => {
  const converted = {
    buyPriceForeign: "10",
    buyCurrency: "USD",
    buyPrice: "30.78",
    fxRateSource: "boi",
  };

  it("keeps the conversion when nothing about the price moved", () => {
    expect(staleConversionFields(converted, "10", "USD")).toEqual({});
    expect(staleConversionFields({ ...converted, buyCurrency: null }, "10", "USD")).toEqual({});
  });

  // Switching the currency to euros must not leave ₪30.78 — a dollar conversion —
  // standing as the euro price's shekel figure.
  it("clears the app's own conversion when the currency or amount changes", () => {
    const reset = { buyPrice: null, fxRate: null, fxRateDate: null, fxRateSource: null };
    expect(staleConversionFields(converted, "10", "EUR")).toEqual(reset);
    expect(staleConversionFields(converted, "12", "USD")).toEqual(reset);
    expect(
      staleConversionFields({ ...converted, fxRateSource: "document", buyPriceForeign: null }, "12.5", "USD"),
    ).toEqual(reset);
  });

  it("keeps a shekel price a person typed, dropping only a rate of another currency", () => {
    const typed = { ...converted, fxRateSource: "manual", buyPrice: "40" };
    expect(staleConversionFields(typed, "11.62", "EUR")).toEqual({ fxRate: null, fxRateDate: null });
    expect(staleConversionFields(typed, "11", "USD")).toEqual({});
  });
});
