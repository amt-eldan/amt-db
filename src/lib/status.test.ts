import { describe, expect, it } from "vitest";
import { isPastContractDue, lineStatus, wasDeliveredLate } from "./status";

const base = {
  manualStatus: null,
  bol: null,
  shipmentStatus: null,
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
    // Even against the carrier: a person saying "מאחר" outranks a delivery scan.
    expect(
      lineStatus({ ...base, manualStatus: "מאחר", bol: "X", shipmentStatus: "delivered" }, today),
    ).toBe("red");
  });

  // The bug this replaced: a tracking number turned a row green, so a box still
  // sitting in a plane looked exactly like one that had been signed for.
  it("bol filled → blue: it shipped, it did not arrive", () => {
    expect(lineStatus({ ...base, bol: "1Z999" }, today)).toBe("blue");
    expect(lineStatus({ ...base, bol: "  " }, today)).toBe("neutral");
    expect(lineStatus({ ...base, bol: "1Z999", contractDueDate: "2026-08-01" }, today)).toBe("blue");
    // in_transit is not arrival either — that is the whole point of the split.
    expect(lineStatus({ ...base, bol: "1Z999", shipmentStatus: "in_transit" }, today)).toBe("blue");
  });

  it("only the carrier's 'delivered' makes a row green", () => {
    expect(lineStatus({ ...base, bol: "1Z999", shipmentStatus: "delivered" }, today)).toBe("green");
    // A status we cannot classify must not be read as arrival.
    expect(lineStatus({ ...base, bol: "1Z999", shipmentStatus: "צריך בדיקה" }, today)).toBe("blue");
  });

  it("a carrier exception → orange, and it outranks the due date", () => {
    expect(lineStatus({ ...base, bol: "X", shipmentStatus: "exception" }, today)).toBe("orange");
    // Stuck in customs is something a person can still act on; red describes a
    // date that is already gone.
    expect(
      lineStatus({ ...base, bol: "X", shipmentStatus: "exception", contractDueDate: "2020-01-01" }, today),
    ).toBe("orange");
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

  // A tracking number still does not clear a missed date: a box on its way is
  // blue at best, and an overdue line stays red until it actually lands.
  it("late wins over a mere bol, however the bol got there", () => {
    expect(lineStatus({ ...base, bol: "X", contractDueDate: "2020-01-01" }, today)).toBe("red");
    expect(
      lineStatus({ ...base, bol: "1Z999AA10123456784", contractDueDate: "2026-04-28" }, new Date("2026-08-03T09:00:00")),
    ).toBe("red");
    const auto = { bolSource: "auto", bolConfidence: "0.95" };
    expect(lineStatus({ ...base, ...auto, bol: "X", contractDueDate: "2020-01-01" }, today)).toBe("red");
  });

  // Reversal of an earlier rule, decided deliberately: once the goods are
  // physically here, red is telling a worse lie than green. The delay is kept
  // as a badge (wasDeliveredLate), not as the row colour.
  it("a confirmed delivery outranks a missed contract date", () => {
    expect(
      lineStatus({ ...base, bol: "X", shipmentStatus: "delivered", contractDueDate: "2020-01-01" }, today),
    ).toBe("green");
  });

  it("late wins over a 'סופק' note too — the date was still missed", () => {
    expect(
      lineStatus({ ...base, deliveryUpdate: "סופק 50 יח'", contractDueDate: "2020-01-01" }, today),
    ).toBe("red");
  });

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
    expect(lineStatus({ ...base, ...extras, bol: "1Z999" }, today)).toBe("blue");
    expect(lineStatus({ ...base, ...extras, bol: null }, today)).toBe("neutral");
  });

  it("default neutral", () => {
    expect(lineStatus(base, today)).toBe("neutral");
  });
});

describe("wasDeliveredLate", () => {
  it("true only when a delivered shipment landed after the contract date", () => {
    expect(
      wasDeliveredLate({ shipmentStatus: "delivered", contractDueDate: "2026-07-01", deliveredAt: "2026-07-10" }),
    ).toBe(true);
    expect(
      wasDeliveredLate({ shipmentStatus: "delivered", contractDueDate: "2026-07-10", deliveredAt: "2026-07-10" }),
    ).toBe(false);
    expect(
      wasDeliveredLate({ shipmentStatus: "delivered", contractDueDate: "2026-07-20", deliveredAt: "2026-07-10" }),
    ).toBe(false);
  });

  it("needs a delivery, a due date and a date to compare", () => {
    expect(
      wasDeliveredLate({ shipmentStatus: "in_transit", contractDueDate: "2026-07-01", deliveredAt: "2026-07-10" }),
    ).toBe(false);
    expect(
      wasDeliveredLate({ shipmentStatus: "delivered", contractDueDate: null, deliveredAt: "2026-07-10" }),
    ).toBe(false);
    expect(wasDeliveredLate({ shipmentStatus: "delivered", contractDueDate: "2026-07-01" })).toBe(false);
  });

  // No carrier delivery date: fall back to when we observed the status. That is
  // later than the real handover, so it can only be conservative — never invent
  // a delay that did not happen.
  it("falls back to shipment_status_at", () => {
    expect(
      wasDeliveredLate({
        shipmentStatus: "delivered",
        contractDueDate: "2026-07-01",
        shipmentStatusAt: new Date("2026-07-15T08:00:00Z"),
      }),
    ).toBe(true);
    expect(
      wasDeliveredLate({
        shipmentStatus: "delivered",
        contractDueDate: "2026-07-30",
        shipmentStatusAt: new Date("2026-07-15T08:00:00Z"),
      }),
    ).toBe(false);
  });
});
