import { describe, expect, it } from "vitest";
import {
  normalizeExtractedPurchaseOrder,
  normalizePoCurrency,
} from "./extract-purchase-order";

const today = new Date("2026-07-19T12:00:00");

function raw(over: Record<string, unknown> = {}) {
  return {
    poNumber: "PO-8871",
    supplier: "DigiKey",
    orderDate: "2026-07-15",
    documentCurrency: "USD",
    lines: [{ pn: "STM32L432KBU6", qty: 50, unitCost: 3.4 }],
    warnings: [],
    ...over,
  };
}

const hasWarning = (warnings: string[], needle: string) =>
  warnings.some((w) => w.includes(needle));

describe("normalizePoCurrency", () => {
  it("reads the dollar spellings that turn up on paper", () => {
    for (const v of ["USD", "usd", "$", "US$", "דולר"]) {
      expect(normalizePoCurrency(v)).toBe("USD");
    }
  });

  it("reads the shekel spellings", () => {
    for (const v of ["ILS", "NIS", "₪", 'ש"ח', "שקל"]) {
      expect(normalizePoCurrency(v)).toBe("ILS");
    }
  });

  // Guessing a currency turns a cost into a different number entirely.
  it("is null for anything else, including nothing", () => {
    expect(normalizePoCurrency("EUR")).toBeNull();
    expect(normalizePoCurrency("")).toBeNull();
    expect(normalizePoCurrency(null)).toBeNull();
  });
});

describe("normalizeExtractedPurchaseOrder", () => {
  it("reads the purchase order and its lines", () => {
    const { order, warnings, documentKind } = normalizeExtractedPurchaseOrder(raw(), today);
    expect(documentKind).toBe("our_purchase_order");
    expect(order).toMatchObject({
      poNumber: "PO-8871",
      supplier: "DigiKey",
      orderDate: "2026-07-15",
      currency: "USD",
    });
    expect(order.lines[0]).toMatchObject({ pn: "STM32L432KBU6", qty: 50, unitCost: 3.4 });
    expect(warnings).toEqual([]);
  });

  it("cleans currency signs and thousands separators off a cost", () => {
    const { order } = normalizeExtractedPurchaseOrder(
      raw({ lines: [{ pn: "X", qty: "1,200", unitCost: "$3.40" }] }),
      today,
    );
    expect(order.lines[0]).toMatchObject({ qty: 1200, unitCost: 3.4 });
  });

  // The mirror of the customer-order extractor's refusal, and for the same
  // reason: the price on a customer's order is what they pay us.
  it("drops every line of a customer order, whatever the model returned", () => {
    const { order, warnings, documentKind } = normalizeExtractedPurchaseOrder(
      raw({ documentKind: "customer_order", lines: [{ pn: "X", qty: 1, unitCost: 99 }] }),
      today,
    );
    expect(documentKind).toBe("customer_order");
    expect(order.lines).toEqual([]);
    expect(hasWarning(warnings, "הזמנה של לקוח")).toBe(true);
  });

  it("treats a missing kind as the expected purchase order", () => {
    const { documentKind, order } = normalizeExtractedPurchaseOrder(
      raw({ documentKind: undefined }),
      today,
    );
    expect(documentKind).toBe("our_purchase_order");
    expect(order.lines).toHaveLength(1);
  });

  // In this document we are the buyer, so our own name in the supplier field
  // means the document was read the wrong way round.
  it("refuses our own name as the supplier", () => {
    const { order, warnings } = normalizeExtractedPurchaseOrder(
      raw({ supplier: "Atrium Micro Technologies" }),
      today,
    );
    expect(order.supplier).toBe("");
    expect(hasWarning(warnings, "הוא שם החברה שלנו")).toBe(true);
  });

  it("warns about a currency it cannot read, and stores none", () => {
    const { order, warnings } = normalizeExtractedPurchaseOrder(
      raw({ documentCurrency: "EUR" }),
      today,
    );
    expect(order.currency).toBeNull();
    expect(hasWarning(warnings, "אינו דולר ואינו שקל")).toBe(true);
  });

  it("warns when no currency was found at all", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(
      raw({ documentCurrency: undefined }),
      today,
    );
    expect(hasWarning(warnings, "לא זוהה מטבע")).toBe(true);
  });

  it("warns about a missing purchase-order number and a missing supplier", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(
      raw({ poNumber: undefined, supplier: undefined }),
      today,
    );
    expect(hasWarning(warnings, "לא זוהה מספר הזמנת רכש")).toBe(true);
    expect(hasWarning(warnings, "לא זוהה שם ספק")).toBe(true);
  });

  it("warns about a line with no identifier and about a missing cost", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(
      raw({ lines: [{ qty: 1 }] }),
      today,
    );
    expect(hasWarning(warnings, 'אין מק"ט יצרן ואין מספר קטלוגי')).toBe(true);
    expect(hasWarning(warnings, "לא נקרא מחיר ליחידה")).toBe(true);
  });

  // A half-read multi-page document produces a perfectly valid payload, so the
  // document's own declared count is the only check available.
  it("warns when the document declares more lines than came back", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(raw({ documentLineCount: 12 }), today);
    expect(hasWarning(warnings, "מצהיר על 12")).toBe(true);
  });

  it("warns when the total does not match the sum of the lines", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(raw({ documentTotal: 999 }), today);
    expect(hasWarning(warnings, 'סה"כ לא תואם')).toBe(true);
  });

  it("accepts a total that matches", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(raw({ documentTotal: 170 }), today);
    expect(hasWarning(warnings, 'סה"כ לא תואם')).toBe(false);
  });

  it("warns about an out-of-range order date", () => {
    const { warnings } = normalizeExtractedPurchaseOrder(raw({ orderDate: "1998-01-01" }), today);
    expect(hasWarning(warnings, "חורג מהטווח")).toBe(true);
  });
});
