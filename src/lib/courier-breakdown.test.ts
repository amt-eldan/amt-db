import { describe, expect, it } from "vitest";
import { buildBolBreakdown, type BreakdownInvoice } from "./courier-breakdown";
import type { CourierShipment } from "./courier-match";

function shipment(over: Partial<CourierShipment> = {}): CourierShipment {
  return {
    bol: "9860064911",
    reference: null,
    customsDeclaration: null,
    shipper: null,
    shipmentDate: "2026-09-01",
    description: null,
    amount: "100.00",
    charges: [],
    lineId: null,
    matchedBy: null,
    ...over,
  };
}

function invoice(over: Partial<BreakdownInvoice> = {}): BreakdownInvoice {
  return {
    id: 1,
    courier: "DHL",
    invoiceNumber: "INV-1",
    invoiceDate: "2026-09-05",
    amount: null,
    currency: "ILS",
    shipments: [],
    ...over,
  };
}

const lines = new Map([
  [10, { lineId: 10, orderNumber: "5975", customerName: "Ness-Tech" }],
  [11, { lineId: 11, orderNumber: "5976", customerName: "Elbit" }],
]);

describe("buildBolBreakdown", () => {
  it("puts each waybill on its own row, with a column per charge item", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          amount: "300.00",
          shipments: [
            shipment({
              bol: "111",
              amount: "100.00",
              charges: [
                { label: "Freight", amount: "80.00", kind: "service" },
                { label: 'מע"מ', amount: "20.00", kind: "vat" },
              ],
            }),
            shipment({
              bol: "222",
              amount: "200.00",
              charges: [{ label: "freight ", amount: "200.00", kind: "service" }],
            }),
          ],
        }),
      ],
      [],
      lines,
    );
    expect(result.columns).toEqual([
      { key: "freight", label: "Freight" },
      { key: 'מע"מ', label: 'מע"מ' },
    ]);
    expect(result.rows.map((r) => [r.bol, r.charges])).toEqual([
      ["111", { freight: 80, 'מע"מ': 20 }],
      ["222", { freight: 200 }],
    ]);
    expect(result.totals).toMatchObject({ amount: 300, charges: { freight: 280, 'מע"מ': 20 } });
  });

  // One waybill over several lines is stored split; here it is one shipment again.
  it("joins a waybill that was split across lines back into one row", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          shipments: [
            shipment({ bol: "98 6006 4911", amount: "150.00", lineId: 10, matchedBy: "bol" }),
            shipment({ bol: "9860064911", amount: "150.00", lineId: 11, matchedBy: "bol" }),
          ],
        }),
      ],
      [],
      lines,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amount: 300, share: 1 });
    expect(result.rows[0].lines.map((l) => l.orderNumber)).toEqual(["5975", "5976"]);
  });

  // The invoice bills 330 for shipments adding up to 300: the 30 that belongs to no
  // one waybill is spread by share instead of being left out of every row.
  it("spreads the invoice total over the waybills by their share", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          amount: "330.00",
          shipments: [
            shipment({ bol: "A", amount: "100.00" }),
            shipment({ bol: "B", amount: "200.00" }),
          ],
        }),
      ],
      [],
      lines,
    );
    expect(result.rows.map((r) => [r.share, r.relative])).toEqual([
      [1 / 3, 110],
      [2 / 3, 220],
    ]);
    expect(result.totals.relative).toBe(330);
  });

  it("keeps every agora when the split does not divide evenly", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          amount: "100.00",
          shipments: [
            shipment({ bol: "A", amount: "1" }),
            shipment({ bol: "B", amount: "1" }),
            shipment({ bol: "C", amount: "1" }),
          ],
        }),
      ],
      [],
      lines,
    );
    const relatives = result.rows.map((r) => r.relative!);
    expect(relatives.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
    expect(relatives.sort()).toEqual([33.33, 33.33, 33.34]);
  });

  it("falls back to the allocations for an invoice approved before shipments were kept", () => {
    const result = buildBolBreakdown(
      [invoice({ amount: "50.00" })],
      [
        {
          invoiceId: 1,
          lineId: 10,
          amount: "50.00",
          bol: "777",
          orderNumber: "5975",
          customerName: "Ness-Tech",
        },
      ],
      lines,
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ bol: "777", amount: 50, relative: 50, lines: [lines.get(10)] }),
    ]);
  });

  it("counts a foreign-currency invoice without adding it to the shekel totals", () => {
    const result = buildBolBreakdown(
      [invoice({ currency: "USD", shipments: [shipment({ amount: "40" })] })],
      [],
      lines,
    );
    expect(result.foreignRows).toBe(1);
    expect(result.totals.amount).toBe(0);
  });
});

describe("buildBolBreakdown — amounts the courier did not print as a total", () => {
  // A shipment printed only as its charges costs what they add up to — the same
  // figure the allocation used — and carries its share of the invoice.
  it("counts a shipment by its charges when it has no printed total", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          amount: "300.00",
          shipments: [
            shipment({ bol: "A", amount: "100.00" }),
            shipment({
              bol: "B",
              amount: null,
              charges: [
                { label: "Fuel", amount: "150.00", kind: "fee" },
                { label: "Tax", amount: "50.00", kind: "tax" },
              ],
            }),
          ],
        }),
      ],
      [],
      lines,
    );
    expect(result.rows.map((r) => [r.bol, r.amount, r.relative])).toEqual([
      ["A", 100, 100],
      ["B", 200, 200],
    ]);
    expect(result.totals.amount).toBe(300);
  });

  it("without an invoice total, charges each waybill its own amount, credits included", () => {
    const result = buildBolBreakdown(
      [
        invoice({
          amount: null,
          shipments: [shipment({ bol: "A", amount: "100.00" }), shipment({ bol: "B", amount: "-20.00" })],
        }),
      ],
      [],
      lines,
    );
    expect(result.rows.map((r) => r.relative)).toEqual([100, -20]);
    expect(result.totals.relative).toBe(80);
  });
});
