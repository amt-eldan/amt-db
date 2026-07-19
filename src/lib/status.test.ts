import { describe, expect, it } from "vitest";
import { lineStatus } from "./status";

const base = {
  manualStatus: null,
  bol: null,
  deliveryUpdate: null,
  notes: null,
  contractDueDate: null,
};
const today = new Date("2026-07-19T12:00:00");

describe("lineStatus", () => {
  it("manual override wins over everything", () => {
    expect(lineStatus({ ...base, manualStatus: "הגיע", contractDueDate: "2020-01-01" }, today)).toBe("green");
    expect(lineStatus({ ...base, manualStatus: "סופק חלקי", bol: "XYZ" }, today)).toBe("orange");
    expect(lineStatus({ ...base, manualStatus: "מאחר", bol: "XYZ" }, today)).toBe("red");
  });

  it("bol filled → green", () => {
    expect(lineStatus({ ...base, bol: "1Z999" }, today)).toBe("green");
    expect(lineStatus({ ...base, bol: "  " }, today)).toBe("neutral");
  });

  it("'סופק' without 'לא סופק' → orange", () => {
    expect(lineStatus({ ...base, deliveryUpdate: "סופק 50 יח'" }, today)).toBe("orange");
    expect(lineStatus({ ...base, notes: "סופק חלקית" }, today)).toBe("orange");
    expect(lineStatus({ ...base, deliveryUpdate: "לא סופק עדיין" }, today)).toBe("neutral");
  });

  it("past due date → red", () => {
    expect(lineStatus({ ...base, contractDueDate: "2026-07-18" }, today)).toBe("red");
    expect(lineStatus({ ...base, contractDueDate: "2026-07-19" }, today)).toBe("neutral");
    expect(lineStatus({ ...base, contractDueDate: "2026-08-01" }, today)).toBe("neutral");
  });

  it("bol wins over late", () => {
    expect(lineStatus({ ...base, bol: "X", contractDueDate: "2020-01-01" }, today)).toBe("green");
  });

  it("default neutral", () => {
    expect(lineStatus(base, today)).toBe("neutral");
  });
});
