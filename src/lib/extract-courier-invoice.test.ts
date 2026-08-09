import { describe, expect, it } from "vitest";
import { normalizeExtractedCourierInvoice } from "./extract-courier-invoice";
import { courierInvoiceDraft } from "./validation";

const today = new Date("2026-07-19T12:00:00");

/** A minimal well-formed model output; individual tests override what they test. */
function raw(over: Record<string, unknown> = {}) {
  return {
    courier: "DHL Express",
    invoiceNumber: "IL-4471902",
    invoiceDate: "2026-07-15",
    subtotalAmount: 300,
    totalAmount: 351,
    currency: "ILS",
    shipments: [
      { trackingNumber: "1Z999AA1", reference: "PO-8871", description: "אווירי לחו\"ל", amount: 180 },
      { trackingNumber: "1Z999AA2", reference: "PO-8872", amount: 120 },
    ],
    warnings: [],
    ...over,
  };
}

const hasWarning = (warnings: string[], needle: string) =>
  warnings.some((w) => w.includes(needle));

describe("normalizeExtractedCourierInvoice", () => {
  it("keeps one shipment per charge, with its tracking number", () => {
    const { invoice } = normalizeExtractedCourierInvoice(raw(), "dhl.pdf", today);
    expect(invoice.shipments).toHaveLength(2);
    expect(invoice.shipments[0]).toMatchObject({
      bol: "1Z999AA1",
      reference: "PO-8871",
      amount: "180",
      lineId: null,
    });
  });

  it("prefers the total including VAT for the invoice header", () => {
    const { invoice } = normalizeExtractedCourierInvoice(raw(), "dhl.pdf", today);
    expect(invoice.amount).toBe("351");
  });

  it("does not complain about VAT when the shipments match the subtotal", () => {
    const { warnings } = normalizeExtractedCourierInvoice(raw(), "dhl.pdf", today);
    expect(hasWarning(warnings, "סכום המשלוחים")).toBe(false);
  });

  it("warns when the shipments add up to neither the subtotal nor the total", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ trackingNumber: "A", amount: 55 }] }),
      "dhl.pdf",
      today,
    );
    expect(hasWarning(warnings, "סכום המשלוחים")).toBe(true);
  });

  it("warns when the document lists no shipments at all", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      raw({ shipments: [] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments).toEqual([]);
    expect(hasWarning(warnings, "לא זוהו משלוחים")).toBe(true);
  });

  it("counts shipments that came back without a charge", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      raw({
        shipments: [
          { trackingNumber: "A" },
          { trackingNumber: "B" },
          { trackingNumber: "C", amount: 300 },
        ],
      }),
      "dhl.pdf",
      today,
    );
    expect(hasWarning(warnings, "ל-2 משלוחים")).toBe(true);
  });

  it("drops table rows that carry nothing", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{}, { trackingNumber: "A", amount: 300 }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments).toHaveLength(1);
  });

  it("keeps a surcharge row that has no tracking number", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ description: "היטל דלק", amount: 300 }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments).toEqual([
      {
        bol: null,
        reference: null,
        customsDeclaration: null,
        shipper: null,
        shipmentDate: null,
        description: "היטל דלק",
        amount: "300",
        charges: [],
        lineId: null,
        matchedBy: null,
      },
    ]);
  });

  it("moves a shipment date into the description, where it is context only", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ trackingNumber: "A", description: "לונדון", date: "2026-07-02", amount: 300 }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].description).toBe("לונדון · 2026-07-02");
  });

  it("cleans numeric strings (thousands separators and currency signs)", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ totalAmount: "₪1,234.50", shipments: [{ trackingNumber: "A", amount: "1,234.50" }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.amount).toBe("1234.5");
    expect(invoice.shipments[0].amount).toBe("1234.5");
  });

  it("says a foreign currency cannot be allocated to lines", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      raw({ currency: "USD" }),
      "dhl.pdf",
      today,
    );
    expect(invoice.currency).toBe("USD");
    expect(hasWarning(warnings, "אינו שקל")).toBe(true);
  });

  it("normalizes every way of writing shekels to ILS", () => {
    for (const currency of ["ILS", "nis", "₪", 'ש"ח']) {
      const { invoice } = normalizeExtractedCourierInvoice(raw({ currency }), "dhl.pdf", today);
      expect(invoice.currency).toBe("ILS");
    }
  });

  it("converts a dotted invoice date", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ invoiceDate: "15.7.2026" }),
      "dhl.pdf",
      today,
    );
    expect(invoice.invoiceDate).toBe("2026-07-15");
  });

  it("drops an impossible date and says so", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      raw({ invoiceDate: "2026-02-31" }),
      "dhl.pdf",
      today,
    );
    expect(invoice.invoiceDate).toBeNull();
    expect(hasWarning(warnings, "לא זוהה כתאריך תקין")).toBe(true);
  });

  it("flags a date outside the plausible range", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      raw({ invoiceDate: "2035-01-01" }),
      "dhl.pdf",
      today,
    );
    expect(hasWarning(warnings, "חורג מהטווח")).toBe(true);
  });

  it("keeps the model's own warnings", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      raw({ warnings: ["מספר המעקב בשורה 3 מטושטש"] }),
      "dhl.pdf",
      today,
    );
    expect(warnings[0]).toBe("מספר המעקב בשורה 3 מטושטש");
  });

  it("names the missing header fields instead of inventing them", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      { warnings: [] },
      "scan.pdf",
      today,
    );
    expect(invoice.courier).toBe("");
    expect(invoice.invoiceNumber).toBe("");
    expect(hasWarning(warnings, "לא זוהה שם הבלדר")).toBe(true);
    expect(hasWarning(warnings, "לא זוהה מספר חשבונית")).toBe(true);
    expect(hasWarning(warnings, "לא זוהה סכום החשבונית")).toBe(true);
    expect(invoice.notes).toBe("מתוך scan.pdf");
  });

  it("survives a tool input that is not an object at all", () => {
    const { invoice } = normalizeExtractedCourierInvoice("nonsense", "scan.pdf", today);
    expect(invoice.shipments).toEqual([]);
    expect(invoice.amount).toBeNull();
  });

  it("produces a draft the staging schema accepts", () => {
    const { invoice } = normalizeExtractedCourierInvoice(raw(), "dhl.pdf", today);
    const parsed = courierInvoiceDraft.safeParse({ ...invoice, fileName: "dhl.pdf" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.shipments).toHaveLength(2);
    expect(parsed.data?.currency).toBe("ILS");
  });

  it("leaves shipments with an empty breakdown when the document itemized none", () => {
    const { invoice } = normalizeExtractedCourierInvoice(raw(), "dhl.pdf", today);
    expect(invoice.shipments.map((s) => s.charges)).toEqual([[], []]);
  });
});

/**
 * The charge breakdown, taken from the DHL import-tax invoice this was built for
 * (DHL9663605): every shipment on it is summed from customs items, a clearance
 * service and its VAT, and a total on its own explains none of that.
 */
describe("normalizeExtractedCourierInvoice — charge breakdown", () => {
  const dhlCharges = [
    { label: 'מע"מ מהצהרת יבוא', amount: 378, kind: "tax" },
    { label: "אגרת מחשב למכס", amount: 21, kind: "fee" },
    { label: "אגרת ביטחון למכס", amount: 49, kind: "fee" },
    { label: "שירות שחרור ממכס", amount: 71, kind: "service" },
    { label: 'מע"מ', amount: 12.78, kind: "vat" },
  ];

  /** One shipment from that invoice, breakdown and all. */
  function dhl(over: Record<string, unknown> = {}) {
    return raw({
      totalAmount: 531.78,
      subtotalAmount: 519,
      vatAmount: 12.78,
      shipments: [
        {
          trackingNumber: "6921530475",
          reference: "465953602",
          description: "ATIC (HK)TECHNOLOGY CO,LTD",
          date: "2026-06-29",
          amount: 531.78,
          charges: dhlCharges,
        },
      ],
      ...over,
    });
  }

  it("keeps every component of a shipment's cost, with its kind", () => {
    const { invoice } = normalizeExtractedCourierInvoice(dhl(), "dhl.pdf", today);
    expect(invoice.shipments[0].charges).toEqual([
      { label: 'מע"מ מהצהרת יבוא', amount: "378", kind: "tax" },
      { label: "אגרת מחשב למכס", amount: "21", kind: "fee" },
      { label: "אגרת ביטחון למכס", amount: "49", kind: "fee" },
      { label: "שירות שחרור ממכס", amount: "71", kind: "service" },
      { label: 'מע"מ', amount: "12.78", kind: "vat" },
    ]);
  });

  it("says nothing when the breakdown adds up to the shipment's total", () => {
    const { warnings } = normalizeExtractedCourierInvoice(dhl(), "dhl.pdf", today);
    expect(hasWarning(warnings, "פירוט החיובים")).toBe(false);
    expect(hasWarning(warnings, "חושבה מסכום")).toBe(false);
  });

  it("names the shipment whose breakdown does not add up to its total", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      dhl({
        shipments: [
          { trackingNumber: "6921530475", amount: 531.78, charges: dhlCharges.slice(0, 4) },
        ],
      }),
      "dhl.pdf",
      today,
    );
    expect(hasWarning(warnings, "פירוט החיובים אינו מסתכם")).toBe(true);
    expect(hasWarning(warnings, "6921530475")).toBe(true);
  });

  it("takes the shipment's cost from the breakdown when no total was printed", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      dhl({ shipments: [{ trackingNumber: "6921530475", charges: dhlCharges }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].amount).toBe("531.78");
    expect(hasWarning(warnings, "חושבה מסכום פירוט החיובים")).toBe(true);
    // The cost is known, so it must not also be reported as missing.
    expect(hasWarning(warnings, "לא זוהה סכום")).toBe(false);
  });

  it("cross-checks the itemized VAT against the VAT the header prints", () => {
    const { warnings } = normalizeExtractedCourierInvoice(
      dhl({ vatAmount: 118.98 }),
      "dhl.pdf",
      today,
    );
    expect(hasWarning(warnings, 'סך המע"מ בפירוט המשלוחים')).toBe(true);
  });

  it("drops a component with no description, which explains nothing", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      dhl({
        shipments: [
          { trackingNumber: "A", amount: 100, charges: [{ amount: 100 }, { label: "אגרה", amount: 100 }] },
        ],
      }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].charges).toEqual([
      { label: "אגרה", amount: "100", kind: "other" },
    ]);
  });

  it("falls back to 'other' for a kind it does not recognise", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      dhl({
        shipments: [
          { trackingNumber: "A", amount: 10, charges: [{ label: "משהו", amount: 10, kind: "surcharge" }] },
        ],
      }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].charges[0].kind).toBe("other");
  });

  it("keeps a component whose amount could not be read", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      dhl({
        shipments: [
          { trackingNumber: "A", amount: 10, charges: [{ label: "אגרה מטושטשת", kind: "fee" }] },
        ],
      }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].charges).toEqual([
      { label: "אגרה מטושטשת", amount: null, kind: "fee" },
    ]);
  });

  it("keeps a row that has nothing but a breakdown", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      dhl({ shipments: [{ charges: [{ label: "היטל דלק", amount: 42, kind: "service" }] }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments).toHaveLength(1);
    expect(invoice.shipments[0].amount).toBe("42");
  });

  it("survives a charges field that is not an array", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      dhl({ shipments: [{ trackingNumber: "A", amount: 10, charges: "אגרה 21" }] }),
      "dhl.pdf",
      today,
    );
    expect(invoice.shipments[0].charges).toEqual([]);
  });

  it("produces a draft with its breakdown intact through the staging schema", () => {
    const { invoice } = normalizeExtractedCourierInvoice(dhl(), "dhl.pdf", today);
    const parsed = courierInvoiceDraft.safeParse({ ...invoice, fileName: "dhl.pdf" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.shipments[0].charges).toHaveLength(5);
    expect(parsed.data?.shipments[0].charges[4]).toEqual({
      label: 'מע"מ',
      amount: "12.78",
      kind: "vat",
    });
  });

  it("accepts a draft written before shipments had a breakdown", () => {
    const parsed = courierInvoiceDraft.safeParse({
      courier: "DHL Express",
      invoiceNumber: "DHL9663605",
      shipments: [{ bol: "6921530475", amount: "531.78", lineId: null }],
      warnings: [],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.shipments[0].charges).toEqual([]);
  });
});

describe("the DHL import-tax invoice: a document with no asmachta of ours", () => {
  /**
   * What that invoice actually gives us: an AWB, a customs declaration number, a
   * sender, an import date — and nothing that identifies our order. The fields
   * below exist so the declaration stops being crammed into `reference`, and so
   * the sender and date can carry a supplier match instead.
   */
  const dhlRow = {
    trackingNumber: "6921530475",
    customsDeclaration: "465953602",
    shipper: "TAOGLAS LIMITED IRELAND",
    date: "2026-07-14",
    amount: 531.78,
  };

  it("keeps the customs declaration in its own field, out of the asmachta", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [dhlRow] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0]).toMatchObject({
      bol: "6921530475",
      customsDeclaration: "465953602",
      reference: null,
    });
  });

  it("keeps the sender and the date as fields the matcher can use", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [dhlRow] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0].shipper).toBe("TAOGLAS LIMITED IRELAND");
    expect(invoice.shipments[0].shipmentDate).toBe("2026-07-14");
  });

  it("still shows the date in the description, where it always was", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ ...dhlRow, description: "מיסי יבוא" }] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0].description).toBe("מיסי יבוא · 2026-07-14");
  });

  it("strips the declaration back out of the asmachta if the model puts it there anyway", () => {
    // The prompt forbids this; the normalizer is the net under the prompt, because a
    // declaration sitting in `reference` can match a real order number by coincidence.
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ ...dhlRow, reference: "465953602" }] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0].reference).toBeNull();
    expect(invoice.shipments[0].customsDeclaration).toBe("465953602");
    expect(hasWarning(warnings, "הרשימון")).toBe(true);
  });

  it("ignores punctuation when deciding the asmachta is really the declaration", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ ...dhlRow, reference: "465-953-602" }] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0].reference).toBeNull();
  });

  it("keeps a real asmachta that merely sits beside a declaration", () => {
    const { invoice, warnings } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ ...dhlRow, reference: "PO-8871" }] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments[0].reference).toBe("PO-8871");
    expect(hasWarning(warnings, "הרשימון")).toBe(false);
  });

  it("keeps a row whose only content is a sender and a declaration", () => {
    // Without the new fields this row read as empty and was dropped as an artifact.
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [{ customsDeclaration: "465953602", shipper: "TAOGLAS" }] }),
      "DHL9663605.pdf",
      today,
    );
    expect(invoice.shipments).toHaveLength(1);
  });

  it("survives the draft schema, so it reaches the staged row", () => {
    const { invoice } = normalizeExtractedCourierInvoice(
      raw({ shipments: [dhlRow] }),
      "DHL9663605.pdf",
      today,
    );
    const parsed = courierInvoiceDraft.safeParse({ ...invoice, fileName: "DHL9663605.pdf" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shipments[0].customsDeclaration).toBe("465953602");
    expect(parsed.success && parsed.data.shipments[0].shipper).toBe("TAOGLAS LIMITED IRELAND");
    expect(parsed.success && parsed.data.shipments[0].shipmentDate).toBe("2026-07-14");
  });

  it("reads a payload staged before these fields existed", () => {
    // Old rows have neither the new fields nor matchedBy; they must parse as null,
    // and null is not low-confidence — those were all key matches.
    const parsed = courierInvoiceDraft.safeParse({
      courier: "DHL",
      invoiceNumber: "IL-1",
      shipments: [{ bol: "1Z999AA1", amount: "180", lineId: 4 }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shipments[0].matchedBy).toBeNull();
    expect(parsed.success && parsed.data.shipments[0].customsDeclaration).toBeNull();
  });
});
