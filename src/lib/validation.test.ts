import { describe, expect, it } from "vitest";
import { bolMatchInput, customerFromOrderNumber } from "./validation";

describe("customerFromOrderNumber", () => {
  it("maps a 966 order onto customer 2470", () => {
    expect(customerFromOrderNumber("966")).toBe("2470");
    expect(customerFromOrderNumber("9661234")).toBe("2470");
    expect(customerFromOrderNumber("  966-0042  ")).toBe("2470");
  });

  it("says nothing about every other number", () => {
    for (const n of ["0226P02772", "4441537295", "96", "1966", "", "   ", "9-66"]) {
      expect(customerFromOrderNumber(n), n).toBeNull();
    }
  });
});

const valid = { lineId: 7, bol: "1Z999AA10123456784" };

describe("bolMatchInput", () => {
  it("accepts a minimal match and trims the bol", () => {
    const parsed = bolMatchInput.parse({ ...valid, bol: "  1Z999  " });
    expect(parsed).toMatchObject({ lineId: 7, bol: "1Z999", carrier: null, confidence: null });
  });

  it("rejects a missing or blank bol", () => {
    expect(bolMatchInput.safeParse({ ...valid, bol: "" }).success).toBe(false);
    expect(bolMatchInput.safeParse({ ...valid, bol: "   " }).success).toBe(false);
    expect(bolMatchInput.safeParse({ lineId: 7 }).success).toBe(false);
  });

  it("rejects a non-positive or non-integer lineId", () => {
    expect(bolMatchInput.safeParse({ ...valid, lineId: 0 }).success).toBe(false);
    expect(bolMatchInput.safeParse({ ...valid, lineId: -3 }).success).toBe(false);
    expect(bolMatchInput.safeParse({ ...valid, lineId: 1.5 }).success).toBe(false);
  });

  it("carries confidence as a clamped string (numeric-as-string convention)", () => {
    expect(bolMatchInput.parse({ ...valid, confidence: 0.95 }).confidence).toBe("0.95");
    expect(bolMatchInput.parse({ ...valid, confidence: "0.4" }).confidence).toBe("0.4");
    expect(bolMatchInput.parse({ ...valid, confidence: 1.7 }).confidence).toBe("1");
    expect(bolMatchInput.parse({ ...valid, confidence: -2 }).confidence).toBe("0");
    expect(bolMatchInput.parse({ ...valid, confidence: "not a number" }).confidence).toBeNull();
  });

  it("normalises empty optional provenance fields to null", () => {
    const parsed = bolMatchInput.parse({
      ...valid,
      carrier: "",
      sourceEmailId: "",
      sourceQuote: "  ",
      statusText: "Delivered",
    });
    expect(parsed.carrier).toBeNull();
    expect(parsed.sourceEmailId).toBeNull();
    expect(parsed.sourceQuote).toBeNull();
    expect(parsed.statusText).toBe("Delivered");
  });
});
