import { describe, expect, it } from "vitest";
import { isPastContractDue, lineStatus } from "./status";

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

  it("bol filled → green while the line is still inside its contract date", () => {
    expect(lineStatus({ ...base, bol: "1Z999" }, today)).toBe("green");
    expect(lineStatus({ ...base, bol: "  " }, today)).toBe("neutral");
    expect(lineStatus({ ...base, bol: "1Z999", contractDueDate: "2026-08-01" }, today)).toBe("green");
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

  // The bug this replaced: typing a tracking number onto an overdue line turned
  // it green, hiding a delay that had already happened. A missed contract date
  // stays red no matter what arrives afterwards.
  it("late wins over bol, however the bol got there", () => {
    expect(lineStatus({ ...base, bol: "X", contractDueDate: "2020-01-01" }, today)).toBe("red");
    // The user's case: contract date 28.04.2026, today 03.08.2026, BOL just typed.
    expect(
      lineStatus({ ...base, bol: "1Z999AA10123456784", contractDueDate: "2026-04-28" }, new Date("2026-08-03T09:00:00")),
    ).toBe("red");
    // Also when the tracking agent wrote it, which is the unattended case.
    const auto = { bolSource: "auto", bolConfidence: "0.95" };
    expect(
      lineStatus({ ...base, ...auto, bol: "X", contractDueDate: "2020-01-01" }, today),
    ).toBe("red");
  });

  it("late wins over a 'סופק' note too — the date was still missed", () => {
    expect(
      lineStatus({ ...base, deliveryUpdate: "סופק 50 יח'", contractDueDate: "2020-01-01" }, today),
    ).toBe("red");
  });

  // Only a human may close a late line: "הגיע" is a statement about reality,
  // a bill of lading is only a document.
  it("manual status still outranks the contract date", () => {
    expect(lineStatus({ ...base, manualStatus: "הגיע", bol: "X", contractDueDate: "2020-01-01" }, today)).toBe("green");
    expect(
      lineStatus({ ...base, manualStatus: "סופק חלקי", bol: "X", contractDueDate: "2020-01-01" }, today),
    ).toBe("orange");
  });

  it("isPastContractDue is date-only: due today is not late", () => {
    expect(isPastContractDue("2026-07-19", today)).toBe(false);
    expect(isPastContractDue("2026-07-18", today)).toBe(true);
    expect(isPastContractDue(null, today)).toBe(false);
  });

  // An auto-filled BOL must colour a row exactly like a hand-typed one: the
  // tracking agent's write closes the loop through this same rule.
  it("ignores how the bol was filled", () => {
    const extras = { carrier: "UPS", bolSource: "auto", bolConfidence: "0.95" };
    expect(lineStatus({ ...base, ...extras, bol: "1Z999" }, today)).toBe("green");
    expect(lineStatus({ ...base, ...extras, bol: null }, today)).toBe("neutral");
  });

  it("default neutral", () => {
    expect(lineStatus(base, today)).toBe("neutral");
  });
});
