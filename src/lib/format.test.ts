import { describe, expect, it } from "vitest";
import { countLabel, formatMonth, parseDotDate } from "./format";

describe("countLabel", () => {
  it("uses the singular wording for one, because '1 שורות' is not Hebrew", () => {
    expect(countLabel(1, "שורה אחת", "שורות")).toBe("שורה אחת");
  });

  it("prefixes the count for anything else", () => {
    expect(countLabel(4, "שורה אחת", "שורות")).toBe("4 שורות");
    expect(countLabel(0, "שורה אחת", "שורות")).toBe("0 שורות");
  });

  it("groups thousands", () => {
    expect(countLabel(1200, "שורה אחת", "שורות")).toBe("1,200 שורות");
  });
});

describe("formatMonth", () => {
  it("names the month in Hebrew", () => {
    expect(formatMonth("2026-07")).toBe("יולי 2026");
  });
});

describe("parseDotDate", () => {
  it("reads a dotted Israeli date", () => {
    expect(parseDotDate("15.7.2026")).toBe("2026-07-15");
  });

  it("returns null for anything it cannot read", () => {
    expect(parseDotDate("15/7/26")).toBeNull();
    expect(parseDotDate(null)).toBeNull();
  });
});
