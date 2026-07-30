import { describe, expect, it } from "vitest";
import { normalizeExtractedInvoice } from "./extract-invoice";
import { supplierInvoiceInput } from "./validation";

const today = new Date("2026-07-19T12:00:00");

/** A minimal well-formed model output; individual tests override what they test. */
function raw(over: Record<string, unknown> = {}) {
  return {
    supplier: "AXTON",
    invoiceNumber: "INV-88213",
    invoiceDate: "2026-07-15",
    subtotalAmount: 3000,
    totalAmount: 3510,
    currency: "ILS",
    warnings: [],
    ...over,
  };
}

const hasWarning = (warnings: string[], needle: string) =>
  warnings.some((w) => w.includes(needle));

describe("normalizeExtractedInvoice", () => {
  it("prefers the total including VAT over the subtotal", () => {
    const { invoice } = normalizeExtractedInvoice(raw(), "inv.pdf", today);
    expect(invoice.amount).toBe("3510");
  });

  it("falls back to the subtotal and warns when no total is present", () => {
    const { invoice, warnings } = normalizeExtractedInvoice(
      raw({ totalAmount: undefined }),
      "inv.pdf",
      today,
    );
    expect(invoice.amount).toBe("3000");
    expect(hasWarning(warnings, 'לפני מע"מ')).toBe(true);
  });

  it("cleans numeric strings (thousands separators and currency signs)", () => {
    const { invoice } = normalizeExtractedInvoice(
      raw({ totalAmount: "₪12,345.60" }),
      "inv.pdf",
      today,
    );
    expect(invoice.amount).toBe("12345.6");
  });

  it("converts dd.mm.yyyy via parseDotDate", () => {
    const { invoice } = normalizeExtractedInvoice(
      raw({ invoiceDate: "15.7.2026" }),
      "inv.pdf",
      today,
    );
    expect(invoice.invoiceDate).toBe("2026-07-15");
  });

  it("drops an unparseable date and warns", () => {
    const { invoice, warnings } = normalizeExtractedInvoice(
      raw({ invoiceDate: "15/7/26" }),
      "inv.pdf",
      today,
    );
    expect(invoice.invoiceDate).toBeNull();
    expect(hasWarning(warnings, "15/7/26")).toBe(true);
  });

  it("rejects an impossible calendar date", () => {
    const { invoice } = normalizeExtractedInvoice(
      raw({ invoiceDate: "2026-02-31" }),
      "inv.pdf",
      today,
    );
    expect(invoice.invoiceDate).toBeNull();
  });

  it("warns when the invoice date is outside the expected range", () => {
    const { warnings } = normalizeExtractedInvoice(
      raw({ invoiceDate: "2035-01-02" }),
      "inv.pdf",
      today,
    );
    expect(hasWarning(warnings, "2035-01-02")).toBe(true);
  });

  it("normalizes a shekel currency to ILS and never converts a foreign one", () => {
    expect(normalizeExtractedInvoice(raw({ currency: 'ש"ח' }), "inv.pdf", today).invoice.currency)
      .toBe("ILS");

    const usd = normalizeExtractedInvoice(raw({ currency: "USD" }), "inv.pdf", today);
    expect(usd.invoice.currency).toBe("USD");
    expect(usd.invoice.amount).toBe("3510");
    expect(hasWarning(usd.warnings, "USD")).toBe(true);
  });

  it("keeps the model's own warnings", () => {
    const { warnings } = normalizeExtractedInvoice(
      raw({ warnings: ["מספר החשבונית מטושטש"] }),
      "inv.pdf",
      today,
    );
    expect(hasWarning(warnings, "מטושטש")).toBe(true);
  });

  it("warns instead of inventing values for a document that is not an invoice", () => {
    const { invoice, warnings } = normalizeExtractedInvoice(
      { warnings: ["המסמך הוא תעודת משלוח ולא חשבונית"] },
      "delivery.pdf",
      today,
    );
    expect(invoice.supplier).toBe("");
    expect(invoice.invoiceNumber).toBe("");
    expect(invoice.amount).toBeNull();
    expect(hasWarning(warnings, "תעודת משלוח")).toBe(true);
    expect(hasWarning(warnings, "לא זוהה שם הספק")).toBe(true);
  });

  it("falls back to the file name when the model gives no summary", () => {
    const { invoice } = normalizeExtractedInvoice(raw(), "AXTON-88213.pdf", today);
    expect(invoice.notes).toBe("מתוך AXTON-88213.pdf");
  });

  it("produces output the invoice form's schema accepts", () => {
    const { invoice } = normalizeExtractedInvoice(raw(), "inv.pdf", today);
    const parsed = supplierInvoiceInput.safeParse({ ...invoice, orderId: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.currency).toBe("ILS");
  });
});
