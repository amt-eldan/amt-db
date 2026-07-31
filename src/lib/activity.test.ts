import { describe, expect, it } from "vitest";
import { activityHref, describeActivity } from "./activity";

describe("describeActivity", () => {
  it("turns a logged write into a Hebrew sentence", () => {
    expect(describeActivity("courier_invoice", "approve")).toBe("חשבונית בלדר אושרה");
    expect(describeActivity("supplier_invoice", "delete")).toBe("חשבונית ספק נמחקה");
  });

  it("falls back to the raw words rather than showing nothing", () => {
    expect(describeActivity("widget", "frobnicate")).toBe("widget frobnicate");
  });
});

describe("activityHref", () => {
  it("points at the page the entity lives on", () => {
    expect(activityHref("staged_order")).toBe("/intake");
    expect(activityHref("order_line")).toBe("/orders");
  });

  it("has no link for an entity it does not know", () => {
    expect(activityHref("widget")).toBeNull();
  });
});
