import { describe, expect, it } from "vitest";
import { isSettled, normalizeCarrierStatus } from "./shipment-status";

describe("normalizeCarrierStatus", () => {
  it("returns null for nothing to classify", () => {
    expect(normalizeCarrierStatus(null)).toBeNull();
    expect(normalizeCarrierStatus(undefined)).toBeNull();
    expect(normalizeCarrierStatus("")).toBeNull();
  });

  it("returns null rather than guessing on unrecognised wording", () => {
    expect(normalizeCarrierStatus("Label created")).toBeNull();
    expect(normalizeCarrierStatus("Information received")).toBeNull();
    expect(normalizeCarrierStatus("משהו אחר לגמרי")).toBeNull();
  });

  it("classifies a handover as delivered", () => {
    expect(normalizeCarrierStatus("Delivered")).toBe("delivered");
    expect(normalizeCarrierStatus("DELIVERED - signed for by A. Cohen")).toBe("delivered");
    expect(normalizeCarrierStatus("נמסר")).toBe("delivered");
  });

  it("classifies movement as in transit", () => {
    expect(normalizeCarrierStatus("In transit")).toBe("in_transit");
    expect(normalizeCarrierStatus("Shipped")).toBe("in_transit");
    expect(normalizeCarrierStatus("Departed FedEx hub")).toBe("in_transit");
    expect(normalizeCarrierStatus("נשלח")).toBe("in_transit");
  });

  // The three orderings that a naive substring check gets wrong.
  it("treats out-for-delivery as still in the air, not delivered", () => {
    expect(normalizeCarrierStatus("Out for delivery")).toBe("in_transit");
    expect(normalizeCarrierStatus("Out for delivery - with courier")).toBe("in_transit");
  });

  it("treats a customs hold as an exception even though it says delivery", () => {
    expect(normalizeCarrierStatus("Held at customs")).toBe("exception");
    expect(normalizeCarrierStatus("Delivery delayed - customs clearance")).toBe("exception");
    expect(normalizeCarrierStatus("מעוכב במכס")).toBe("exception");
  });

  it("treats a failed or returned delivery as an exception", () => {
    expect(normalizeCarrierStatus("Delivery failed")).toBe("exception");
    expect(normalizeCarrierStatus("Returned to sender")).toBe("exception");
  });

  it("is case insensitive", () => {
    expect(normalizeCarrierStatus("in TRANSIT")).toBe("in_transit");
    expect(normalizeCarrierStatus("HELD AT CUSTOMS")).toBe("exception");
  });
});

describe("isSettled", () => {
  it("is true only once the shipment has been handed over", () => {
    expect(isSettled("delivered")).toBe(true);
    expect(isSettled("in_transit")).toBe(false);
    expect(isSettled("exception")).toBe(false);
    expect(isSettled(null)).toBe(false);
  });
});
