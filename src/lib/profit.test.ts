import { describe, expect, it } from "vitest";
import { lineProfit, lineValue } from "./profit";

// Numeric columns come back from Drizzle as strings, which is how these are fed
// in production — so the fixtures use strings too.
const line = {
  qty: "10",
  unitPrice: "25",
  buyPrice: "20",
  shippingCost: null,
};

describe("lineValue", () => {
  it("multiplies quantity by unit price", () => {
    expect(lineValue({ qty: "10", unitPrice: "25" })).toBe(250);
    expect(lineValue({ qty: 3, unitPrice: 12.5 })).toBe(37.5);
  });

  it("is null when either side is missing", () => {
    expect(lineValue({ qty: null, unitPrice: "25" })).toBeNull();
    expect(lineValue({ qty: "10", unitPrice: null })).toBeNull();
    expect(lineValue({ qty: "", unitPrice: "" })).toBeNull();
  });

  it("reads a value entered with a currency symbol or separators", () => {
    expect(lineValue({ qty: "2", unitPrice: "₪1,200" })).toBe(2400);
  });
});

describe("lineProfit", () => {
  it("is margin times quantity", () => {
    expect(lineProfit(line)).toBe(50); // (25 - 20) * 10
  });

  it("subtracts shipping once, not per unit", () => {
    expect(lineProfit({ ...line, shippingCost: "30" })).toBe(20);
  });

  it("goes negative when shipping eats the margin", () => {
    expect(lineProfit({ ...line, shippingCost: "80" })).toBe(-30);
  });

  it("goes negative when the buy price is above the sale price", () => {
    expect(lineProfit({ ...line, buyPrice: "27" })).toBe(-20);
  });

  it("is null without a buy price, so the line shows 'ממתין' instead of a fake profit", () => {
    expect(lineProfit({ ...line, buyPrice: null })).toBeNull();
    expect(lineProfit({ ...line, buyPrice: "" })).toBeNull();
  });

  it("is null when quantity or sale price is missing", () => {
    expect(lineProfit({ ...line, qty: null })).toBeNull();
    expect(lineProfit({ ...line, unitPrice: null })).toBeNull();
  });

  it("treats missing shipping as zero rather than as unknown", () => {
    expect(lineProfit({ ...line, shippingCost: null })).toBe(50);
    expect(lineProfit({ ...line, shippingCost: "" })).toBe(50);
  });

  it("keeps a non-finite input out of the total", () => {
    // "1e999" parses to Infinity; letting it through would poison the month's sum.
    expect(lineProfit({ ...line, buyPrice: "1e999" })).toBeNull();
    expect(lineProfit({ ...line, shippingCost: "1e999" })).toBe(50);
  });
});
