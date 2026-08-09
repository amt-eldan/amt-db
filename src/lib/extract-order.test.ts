import { describe, expect, it } from "vitest";
import { normalizeExtractedOrder } from "./extract-order";
import { stagedPayload } from "./validation";

const today = new Date("2026-07-19T12:00:00");

/** A minimal well-formed model output; individual tests override what they test. */
function raw(over: Record<string, unknown> = {}) {
  return {
    customer: "אלביט מערכות",
    orderNumber: "0226P02772",
    orderDate: "2026-07-15",
    lines: [{ pn: "STM32L432KBU6", sku: "345056", qty: 50, unitPrice: 12.5 }],
    warnings: [],
    ...over,
  };
}

const hasWarning = (warnings: string[], needle: string) =>
  warnings.some((w) => w.includes(needle));

describe("normalizeExtractedOrder", () => {
  it("cleans numeric strings (thousands separators and currency signs)", () => {
    const { order } = normalizeExtractedOrder(
      raw({ lines: [{ pn: "X", qty: "1,200", unitPrice: "₪12.50" }] }),
      "po.pdf",
      today,
    );
    expect(order.lines[0].qty).toBe(1200);
    expect(order.lines[0].unitPrice).toBe(12.5);
  });

  it("converts dd.mm.yyyy via parseDotDate", () => {
    const { order } = normalizeExtractedOrder(raw({ orderDate: "15.7.2026" }), "po.pdf", today);
    expect(order.orderDate).toBe("2026-07-15");
  });

  it("drops a two-digit-year date and warns", () => {
    const { order, warnings } = normalizeExtractedOrder(
      raw({ orderDate: "15/7/26" }),
      "po.pdf",
      today,
    );
    expect(order.orderDate).toBeNull();
    expect(hasWarning(warnings, "15/7/26")).toBe(true);
  });

  it("derives sourceFormat from the order number, not from the model", () => {
    const mod = normalizeExtractedOrder(
      raw({ orderNumber: "4441537295", customer: "134", sourceFormat: "standard" }),
      "po.pdf",
      today,
    );
    expect(mod.order.sourceFormat).toBe("mod");

    const std = normalizeExtractedOrder(
      raw({ orderNumber: "0226P02772", sourceFormat: "mod" }),
      "po.pdf",
      today,
    );
    expect(std.order.sourceFormat).toBe("standard");
  });

  it("warns when a 444 order's customer is not a purchasing-group number", () => {
    const bad = normalizeExtractedOrder(
      raw({ orderNumber: "4441537295", customer: "משרד הביטחון" }),
      "po.pdf",
      today,
    );
    expect(hasWarning(bad.warnings, "קבוצת רכש")).toBe(true);

    const good = normalizeExtractedOrder(
      raw({ orderNumber: "4441537295", customer: "134" }),
      "po.pdf",
      today,
    );
    expect(hasWarning(good.warnings, "קבוצת רכש")).toBe(false);
  });

  it("refuses to file our own company as the customer", () => {
    for (const ours of ["AMT", "א.מ.ט", 'Atrium Micro Technologies Ltd.', 'אטריום מיקרו בע"מ']) {
      const { order, warnings } = normalizeExtractedOrder(
        raw({ customer: ours }),
        "po.pdf",
        today,
      );
      expect(order.customer, ours).toBe("");
      expect(hasWarning(warnings, "שם החברה שלנו"), ours).toBe(true);
      expect(hasWarning(warnings, ours), ours).toBe(true);
    }
  });

  it("files a 966 order under customer 2470, whatever the document said", () => {
    const wrong = normalizeExtractedOrder(
      raw({ orderNumber: "9661234", customer: "אלביט מערכות" }),
      "po.pdf",
      today,
    );
    expect(wrong.order.customer).toBe("2470");
    expect(hasWarning(wrong.warnings, "הוחלף")).toBe(true);

    // Nothing to flag when the document agrees, or when it named us / no one.
    const agrees = normalizeExtractedOrder(raw({ orderNumber: "966", customer: "2470" }), "po.pdf", today);
    expect(agrees.order.customer).toBe("2470");
    expect(agrees.warnings).toEqual([]);

    const blank = normalizeExtractedOrder(
      raw({ orderNumber: "9660001", customer: "AMT" }),
      "po.pdf",
      today,
    );
    expect(blank.order.customer).toBe("2470");
    expect(hasWarning(blank.warnings, "שם החברה שלנו")).toBe(false);
    expect(hasWarning(blank.warnings, "לא זוהה שם לקוח")).toBe(false);
  });

  it("keeps a real customer name, and warns only when none was read", () => {
    const named = normalizeExtractedOrder(raw({ customer: "אלביט מערכות" }), "po.pdf", today);
    expect(named.order.customer).toBe("אלביט מערכות");
    expect(hasWarning(named.warnings, "לא זוהה שם לקוח")).toBe(false);

    const missing = normalizeExtractedOrder(raw({ customer: undefined }), "po.pdf", today);
    expect(missing.order.customer).toBe("");
    expect(hasWarning(missing.warnings, "לא זוהה שם לקוח")).toBe(true);
  });

  it("stages an order whose customer was not recognised, lines and all", () => {
    const { order } = normalizeExtractedOrder(raw({ customer: "AMT" }), "po.pdf", today);
    const parsed = stagedPayload.safeParse({ ...order, sourceFile: "po.pdf" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.customer).toBe("");
      expect(parsed.data.lines).toHaveLength(1);
    }
  });

  it("warns on a document-total mismatch over 1 ₪ only", () => {
    // lines sum to 3350.00
    const lines = [{ pn: "A", qty: 100, unitPrice: 33.5 }];

    const off = normalizeExtractedOrder(
      raw({ lines, documentTotal: 3355.8 }),
      "po.pdf",
      today,
    );
    expect(hasWarning(off.warnings, 'סה"כ לא תואם')).toBe(true);
    expect(hasWarning(off.warnings, "3,355.80")).toBe(true);
    expect(hasWarning(off.warnings, "3,350.00")).toBe(true);

    const close = normalizeExtractedOrder(
      raw({ lines, documentTotal: 3350.5 }),
      "po.pdf",
      today,
    );
    expect(hasWarning(close.warnings, 'סה"כ לא תואם')).toBe(false);
  });

  it("warns on foreign currency without converting", () => {
    const { order, warnings } = normalizeExtractedOrder(
      raw({ documentCurrency: "USD" }),
      "po.pdf",
      today,
    );
    expect(order.lines[0].unitPrice).toBe(12.5);
    expect(hasWarning(warnings, "USD")).toBe(true);
  });

  it("warns on a line with no P/N and on a zero/missing qty", () => {
    const { warnings } = normalizeExtractedOrder(
      raw({ lines: [{ sku: "345056", qty: 0, unitPrice: 5 }] }),
      "po.pdf",
      today,
    );
    expect(hasWarning(warnings, "שורה 1")).toBe(true);
    expect(hasWarning(warnings, 'מק"ט יצרן')).toBe(true);
    expect(hasWarning(warnings, "כמות חסרה")).toBe(true);
  });

  it("warns when a date falls outside 2000..today+5y", () => {
    const future = normalizeExtractedOrder(raw({ orderDate: "2035-01-01" }), "po.pdf", today);
    expect(hasWarning(future.warnings, "חורג מהטווח")).toBe(true);

    const old = normalizeExtractedOrder(raw({ orderDate: "1999-12-31" }), "po.pdf", today);
    expect(hasWarning(old.warnings, "חורג מהטווח")).toBe(true);

    const ok = normalizeExtractedOrder(raw({ orderDate: "2026-07-15" }), "po.pdf", today);
    expect(hasWarning(ok.warnings, "חורג מהטווח")).toBe(false);
  });

  it("warns prominently when there is no order date, without inventing one", () => {
    const { order, warnings } = normalizeExtractedOrder(
      raw({ orderDate: undefined }),
      "po.pdf",
      today,
    );
    expect(order.orderDate).toBeNull();
    expect(hasWarning(warnings, "לא זוהה תאריך הזמנה")).toBe(true);
  });

  it("warns about a possible scanner suffix on a PMO number without trimming it", () => {
    const { order, warnings } = normalizeExtractedOrder(
      raw({ orderNumber: "0226P02772001" }),
      "0226P02772001.pdf",
      today,
    );
    expect(order.orderNumber).toBe("0226P02772001");
    expect(hasWarning(warnings, "סיומת סורק")).toBe(true);
  });

  it("turns omitted fields into null", () => {
    const { order } = normalizeExtractedOrder(
      { customer: "לקוח", orderNumber: "123", lines: [{ pn: "A", qty: 1 }], warnings: [] },
      "po.pdf",
      today,
    );
    expect(order.customerNote).toBeNull();
    expect(order.orderDate).toBeNull();
    expect(order.lines[0].sku).toBeNull();
    expect(order.lines[0].unitPrice).toBeNull();
    expect(order.lines[0].contractDueDate).toBeNull();
    expect(order.lines[0].notes).toBeNull();
  });

  it("keeps the model's own warnings", () => {
    const { warnings } = normalizeExtractedOrder(
      raw({ warnings: ["החתימה על העמוד השני מטושטשת"] }),
      "po.pdf",
      today,
    );
    expect(hasWarning(warnings, "מטושטשת")).toBe(true);
  });

  it("tolerates junk input instead of throwing", () => {
    expect(() => normalizeExtractedOrder(null, "po.pdf", today)).not.toThrow();
    const { order } = normalizeExtractedOrder("not an object", "po.pdf", today);
    expect(order.lines).toEqual([]);
    expect(order.customer).toBe("");
  });

  it("produces a payload that passes stagedPayload with sourceFile added", () => {
    const { order } = normalizeExtractedOrder(
      raw({ orderDate: "15.7.2026", lines: [{ pn: "A", qty: "1,200", unitPrice: "₪12.50" }] }),
      "0226P02772.pdf",
      today,
    );
    const parsed = stagedPayload.safeParse({ ...order, sourceFile: "0226P02772.pdf" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.orderDate).toBe("2026-07-15");
      expect(parsed.data.sourceFormat).toBe("standard");
      expect(parsed.data.sourceFile).toBe("0226P02772.pdf");
      // optionalNumeric stores numbers as strings.
      expect(parsed.data.lines[0].qty).toBe("1200");
      expect(parsed.data.lines[0].unitPrice).toBe("12.5");
    }
  });

  it("passes stagedPayload for a MoD order too", () => {
    const { order } = normalizeExtractedOrder(
      raw({ orderNumber: "4441537295", customer: "134" }),
      "4441537295.pdf",
      today,
    );
    const parsed = stagedPayload.safeParse({ ...order, sourceFile: "4441537295.pdf" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sourceFormat).toBe("mod");
  });
});
