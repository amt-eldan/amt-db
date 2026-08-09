import { describe, expect, it } from "vitest";
import { parseNumeric, parseNumericString } from "./numeric";

describe("parseNumeric", () => {
  it("passes finite numbers through", () => {
    expect(parseNumeric(12.5)).toBe(12.5);
    expect(parseNumeric(0)).toBe(0);
    expect(parseNumeric(-3)).toBe(-3);
  });

  it("returns null for empty and missing input", () => {
    expect(parseNumeric(null)).toBeNull();
    expect(parseNumeric(undefined)).toBeNull();
    expect(parseNumeric("")).toBeNull();
    expect(parseNumeric("   ")).toBeNull();
  });

  it("strips currency symbols and thousands separators", () => {
    // The regression this module exists for: "₪1,200" used to become NULL.
    expect(parseNumeric("₪1,200")).toBe(1200);
    expect(parseNumeric("$1,200.50")).toBe(1200.5);
    expect(parseNumeric("1 200")).toBe(1200);
    expect(parseNumeric("12.5")).toBe(12.5);
  });

  it("keeps parseFloat's tolerance for a trailing unit", () => {
    expect(parseNumeric("50 יח'")).toBe(50);
  });

  it("returns null for non-numeric text", () => {
    expect(parseNumeric("abc")).toBeNull();
    expect(parseNumeric("—")).toBeNull();
  });

  it("rejects non-finite values instead of letting them into a sum", () => {
    expect(parseNumeric("1e999")).toBeNull();
    expect(parseNumeric(Infinity)).toBeNull();
    expect(parseNumeric(-Infinity)).toBeNull();
    expect(parseNumeric(NaN)).toBeNull();
  });
});

describe("parseNumericString", () => {
  it("renders the parsed value back as a string for numeric columns", () => {
    expect(parseNumericString("₪1,200")).toBe("1200");
    expect(parseNumericString(12.5)).toBe("12.5");
    expect(parseNumericString(0)).toBe("0");
  });

  it("keeps null as null", () => {
    expect(parseNumericString("")).toBeNull();
    expect(parseNumericString("abc")).toBeNull();
    expect(parseNumericString(null)).toBeNull();
  });
});
