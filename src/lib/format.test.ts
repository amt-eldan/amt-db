import { describe, expect, it } from "vitest";
import {
  countLabel,
  formatDate,
  formatILS,
  formatMonth,
  formatNumber,
  formatTimestamp,
  monthRange,
  parseDotDate,
} from "./format";

describe("monthRange", () => {
  it("spans the month as a half-open range", () => {
    expect(monthRange(2026, 7)).toEqual({ from: "2026-07-01", to: "2026-08-01" });
  });

  it("zero-pads single-digit months on both ends", () => {
    expect(monthRange(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-02-01" });
    expect(monthRange(2026, 9)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
  });

  it("rolls the year over for December", () => {
    expect(monthRange(2026, 12)).toEqual({ from: "2026-12-01", to: "2027-01-01" });
  });

  it("covers every month with no gaps or overlaps", () => {
    for (let m = 1; m < 12; m++) {
      expect(monthRange(2026, m).to).toBe(monthRange(2026, m + 1).from);
    }
    expect(monthRange(2026, 12).to).toBe(monthRange(2027, 1).from);
  });
});

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

describe("formatDate / parseDotDate", () => {
  it("round-trips between ISO and dd.mm.yyyy", () => {
    expect(formatDate("2026-07-15")).toBe("15.07.2026");
    expect(parseDotDate("15.07.2026")).toBe("2026-07-15");
    expect(parseDotDate("5.7.2026")).toBe("2026-07-05");
    expect(parseDotDate("5/7/2026")).toBe("2026-07-05");
  });

  it("returns a dash for nothing and rejects unparseable input", () => {
    expect(formatDate(null)).toBe("—");
    expect(parseDotDate("")).toBeNull();
    expect(parseDotDate("15.7.26")).toBeNull();
    expect(parseDotDate("15/7/26")).toBeNull();
    expect(parseDotDate(null)).toBeNull();
  });
});

describe("formatILS / formatNumber", () => {
  it("renders a dash rather than a number for missing values", () => {
    expect(formatILS(null)).toBe("—");
    expect(formatILS("")).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
  });

  it("renders a dash rather than '∞' for a non-finite value", () => {
    expect(formatILS("1e999")).toBe("—");
    expect(formatNumber(Infinity)).toBe("—");
  });

  it("formats finite values", () => {
    expect(formatILS(0)).toContain("0");
    expect(formatNumber("1500")).toContain("1");
  });
});

describe("formatTimestamp", () => {
  it("renders a dash for nothing and for an unparseable date", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
    expect(formatTimestamp("not a date")).toBe("—");
    expect(formatTimestamp(new Date("nonsense"))).toBe("—");
  });

  it("renders a real timestamp with both date and time", () => {
    const out = formatTimestamp(new Date("2026-07-15T09:30:00Z"));
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{2}:\d{2}/);
  });
});

describe("formatMonth", () => {
  it("names the month in Hebrew", () => {
    expect(formatMonth("2026-07")).toBe("יולי 2026");
    expect(formatMonth("2026-01")).toBe("ינואר 2026");
    expect(formatMonth("2026-12")).toBe("דצמבר 2026");
  });
});
