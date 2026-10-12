import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderLine } from "@/db/schema";
import { poApplyInput } from "./validation";

const { rows, applyLineFields, revalidatePath, convertBuyPriceToIls } = vi.hoisted(() => ({
  rows: new Map<number, unknown>(),
  applyLineFields: vi.fn(),
  revalidatePath: vi.fn(),
  convertBuyPriceToIls: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({ inArray: (_column: unknown, ids: number[]) => ({ ids }) }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./line-fields", () => ({ applyLineFields }));
vi.mock("./fx-apply", () => ({ convertBuyPriceToIls }));
// The courier second look has its own tests (courier-match.test.ts); here it is
// only checked to run after a write, and never when nothing was written.
const { allocatePendingCourierShipments } = vi.hoisted(() => ({
  allocatePendingCourierShipments: vi.fn(),
}));
vi.mock("./courier-allocate", () => ({ allocatePendingCourierShipments }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: ({ ids }: { ids: number[] }) =>
          Promise.resolve(ids.filter((id) => rows.has(id)).map((id) => rows.get(id))),
      }),
    }),
  },
}));

const { writePurchaseOrderCosts } = await import("./po-write");

function line(over: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 7,
    isOpen: true,
    qty: "100",
    poNumber: null,
    supplier: null,
    buyPrice: null,
    buyPriceForeign: null,
    buyCurrency: null,
    fxRate: null,
    fxRateDate: null,
    fxRateSource: null,
    deliveredAt: null,
    poUnitCost: null,
    poCurrency: null,
    poQty: null,
    ...over,
  } as OrderLine;
}

const input = (over: Record<string, unknown> = {}) =>
  poApplyInput.parse({
    poNumber: "PO-4471",
    supplier: "Farnell UK",
    currency: "GBP",
    sourceFile: "po.pdf",
    matches: [{ lineId: 7, unitCost: 2.35, qty: 100 }],
    ...over,
  });

const written = (call = 0) => applyLineFields.mock.calls[call][1] as Record<string, unknown>;

beforeEach(() => {
  rows.clear();
  applyLineFields.mockClear();
  revalidatePath.mockClear();
  convertBuyPriceToIls.mockReset();
  convertBuyPriceToIls.mockResolvedValue({});
});

describe("writePurchaseOrderCosts", () => {
  // A sterling order used to be refused whole: no price and no quantity reached
  // any line. It is an ordinary purchase order now.
  it("records a pound price and the order's own figures", async () => {
    rows.set(7, line());
    const summary = await writePurchaseOrderCosts(input());
    expect(summary.written).toBe(1);
    expect(written()).toMatchObject({
      poNumber: "PO-4471",
      supplier: "Farnell UK",
      buyPriceForeign: "2.35",
      buyCurrency: "GBP",
      poUnitCost: "2.35",
      poCurrency: "GBP",
      poQty: "100",
    });
  });

  it("converts through the shared helper in the order's currency", async () => {
    rows.set(7, line({ deliveredAt: "2026-09-30" }));
    await writePurchaseOrderCosts(input({ currency: "EUR" }));
    expect(convertBuyPriceToIls).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      "2.35",
      "EUR",
      "2026-09-30",
    );
  });

  // The line's quantity is the customer's and drives the sale value.
  it("fills an empty quantity, and never overwrites a typed one", async () => {
    rows.set(7, line({ qty: null }));
    await writePurchaseOrderCosts(input());
    expect(written()).toMatchObject({ qty: "100", poQty: "100" });

    applyLineFields.mockClear();
    rows.set(7, line({ qty: "80" }));
    await writePurchaseOrderCosts(input());
    expect(written()).not.toHaveProperty("qty");
    expect(written()).toMatchObject({ poQty: "100" });
  });

  it("writes a shekel order straight to the buy price", async () => {
    rows.set(7, line());
    await writePurchaseOrderCosts(input({ currency: "ILS" }));
    expect(written()).toMatchObject({
      buyPrice: "2.35",
      fxRateSource: "document",
      poCurrency: "ILS",
    });
    expect(convertBuyPriceToIls).not.toHaveBeenCalled();
  });

  // The office's own shekel figure stays; the order's sits beside it to compare.
  it("keeps a hand-typed shekel price and records the order's next to it", async () => {
    rows.set(7, line({ buyPrice: "9.9", fxRateSource: "manual" }));
    await writePurchaseOrderCosts(input({ currency: "ILS" }));
    expect(written()).not.toHaveProperty("buyPrice");
    expect(written()).toMatchObject({ poUnitCost: "2.35", poCurrency: "ILS" });
  });

  it("still refuses a line tied to a different purchase order", async () => {
    rows.set(7, line({ poNumber: "PO-1" }));
    const summary = await writePurchaseOrderCosts(input());
    expect(summary).toMatchObject({ written: 0, skipped: 1 });
    expect(applyLineFields).not.toHaveBeenCalled();
  });
});
