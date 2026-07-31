import { describe, expect, it } from "vitest";
import { buildDashboard, type DashboardInput, type DashboardLine } from "./dashboard";

const today = new Date("2026-07-19T12:00:00");

function line(over: Partial<DashboardLine> & { lineId: number }): DashboardLine {
  return {
    orderNumber: "5975",
    customerName: "Ness-Tech",
    supplier: "DigiKey",
    qty: "10",
    unitPrice: "100",
    buyPrice: "60",
    shippingCost: null,
    orderDate: "2026-07-01",
    contractDueDate: null,
    bol: null,
    bolSource: null,
    bolConfidence: null,
    deliveryUpdate: null,
    notes: null,
    manualStatus: null,
    isOpen: true,
    ...over,
  };
}

function input(over: Partial<DashboardInput> = {}): DashboardInput {
  return {
    lines: [],
    supplierInvoices: [],
    courierInvoices: [],
    pendingOrders: 0,
    pendingCourierInvoices: 0,
    today,
    ...over,
  };
}

const alertIds = (data: ReturnType<typeof buildDashboard>) => data.alerts.map((a) => a.id);

describe("buildDashboard — open pipeline", () => {
  it("values the open lines and counts their customers", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1 }),
          line({ lineId: 2, customerName: "134", qty: "5", unitPrice: "20" }),
          line({ lineId: 3, isOpen: false }), // closed lines are not pipeline
        ],
      }),
    );
    expect(data.open.lines).toBe(2);
    expect(data.open.value).toBe(1100);
    expect(data.open.customers).toBe(2);
  });

  it("expects profit only from lines that already have a buy price", () => {
    const data = buildDashboard(
      input({ lines: [line({ lineId: 1 }), line({ lineId: 2, buyPrice: null })] }),
    );
    expect(data.open.expectedProfit).toBe(400);
    expect(data.open.expectedProfitLines).toBe(1);
  });

  it("breaks the open lines down by the same status the orders page shows", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, manualStatus: "הגיע" }),
          line({ lineId: 2, manualStatus: "סופק חלקי" }),
          line({ lineId: 3, contractDueDate: "2026-07-01" }), // past due → late
          line({ lineId: 4, contractDueDate: "2026-08-01" }),
        ],
      }),
    );
    expect(data.open.byStatus).toEqual({ green: 1, orange: 1, red: 1, neutral: 1 });
  });

  it("adds money in agorot rather than in floats", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, qty: "1", unitPrice: "0.1", buyPrice: null }),
          line({ lineId: 2, qty: "1", unitPrice: "0.2", buyPrice: null }),
        ],
      }),
    );
    expect(data.open.value).toBe(0.3);
  });
});

describe("buildDashboard — the month", () => {
  it("summarizes the latest month that has closed lines", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, isOpen: false, orderDate: "2026-06-03", shippingCost: "50" }),
          line({ lineId: 2, isOpen: false, orderDate: "2026-05-03" }),
        ],
      }),
    );
    expect(data.month.ym).toBe("2026-06");
    expect(data.month.label).toBe("יוני 2026");
    expect(data.month.sale).toBe(1000);
    expect(data.month.profit).toBe(350); // (100-60)*10 - 50
    expect(data.month.shipping).toBe(50);
    expect(data.month.margin).toBeCloseTo(0.35);
    expect(data.month.stale).toBe(true);
  });

  it("says nothing is stale when the current month already has closed lines", () => {
    const data = buildDashboard(
      input({ lines: [line({ lineId: 1, isOpen: false, orderDate: "2026-07-02" })] }),
    );
    expect(data.month.ym).toBe("2026-07");
    expect(data.month.stale).toBe(false);
  });

  it("counts lines whose profit is unknown instead of guessing at it", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, isOpen: false, orderDate: "2026-07-02" }),
          line({ lineId: 2, isOpen: false, orderDate: "2026-07-02", buyPrice: null }),
        ],
      }),
    );
    expect(data.month.lines).toBe(2);
    expect(data.month.pending).toBe(1);
    expect(data.month.profit).toBe(400);
  });

  it("falls back to the current month when nothing is closed yet", () => {
    const data = buildDashboard(input({ lines: [line({ lineId: 1 })] }));
    expect(data.month.ym).toBe("2026-07");
    expect(data.month.sale).toBe(0);
    expect(data.month.margin).toBeNull();
  });
});

describe("buildDashboard — trend", () => {
  it("always returns six months ending with the current one", () => {
    const data = buildDashboard(input());
    expect(data.trend).toHaveLength(6);
    expect(data.trend.map((p) => p.ym)).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
    expect(data.trend[5].label).toBe("יולי");
  });

  it("crosses the new year backwards", () => {
    const data = buildDashboard(input({ today: new Date("2026-02-10T12:00:00") }));
    expect(data.trend.map((p) => p.ym)).toEqual([
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("puts closed lines in the month of their order date", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, isOpen: false, orderDate: "2026-05-20" }),
          line({ lineId: 2, isOpen: false, orderDate: "2026-05-28", qty: "1", unitPrice: "10" }),
        ],
      }),
    );
    const may = data.trend.find((p) => p.ym === "2026-05")!;
    expect(may.sale).toBe(1010);
    expect(may.lines).toBe(2);
  });

  it("ignores a closed line with no order date rather than dropping it into a bucket", () => {
    const data = buildDashboard(
      input({ lines: [line({ lineId: 1, isOpen: false, orderDate: null })] }),
    );
    expect(data.trend.every((p) => p.lines === 0)).toBe(true);
    expect(data.month.lines).toBe(0);
  });
});

describe("buildDashboard — alerts", () => {
  it("puts what is late first and drops everything with a count of zero", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, contractDueDate: "2026-07-01" }), // late + no BOL
          line({ lineId: 2, isOpen: false, buyPrice: null }), // closed, no buy price
        ],
        pendingOrders: 3,
      }),
    );
    expect(alertIds(data)[0]).toBe("late");
    expect(alertIds(data)).toContain("staged-orders");
    expect(alertIds(data)).toContain("missing-buy-price");
    expect(alertIds(data)).not.toContain("courier-unallocated");
  });

  it("does not ask for a bill of lading on a line already marked as arrived", () => {
    const data = buildDashboard(
      input({ lines: [line({ lineId: 1, manualStatus: "הגיע", bol: null })] }),
    );
    expect(alertIds(data)).not.toContain("missing-bol");
  });

  it("treats whitespace as no bill of lading", () => {
    const data = buildDashboard(input({ lines: [line({ lineId: 1, bol: "   " })] }));
    expect(data.alerts.find((a) => a.id === "missing-bol")?.count).toBe(1);
  });

  it("flags an auto-filled bill of lading only when the agent was unsure", () => {
    const data = buildDashboard(
      input({
        lines: [
          line({ lineId: 1, bol: "A", bolSource: "auto", bolConfidence: "0.95" }),
          line({ lineId: 2, bol: "B", bolSource: "auto", bolConfidence: "0.4" }),
          line({ lineId: 3, bol: "C", bolSource: "manual", bolConfidence: null }),
        ],
      }),
    );
    expect(data.alerts.find((a) => a.id === "low-confidence-bol")?.count).toBe(1);
  });

  it("flags a courier invoice that was approved without a split", () => {
    const data = buildDashboard(
      input({
        courierInvoices: [
          { courier: "DHL", amount: "351", currency: "ILS", allocatedTotal: null, allocatedLines: 0 },
          { courier: "UPS", amount: "100", currency: "ILS", allocatedTotal: "100", allocatedLines: 2 },
        ],
      }),
    );
    expect(data.alerts.find((a) => a.id === "courier-unallocated")?.count).toBe(1);
  });
});

describe("buildDashboard — documents", () => {
  it("sums shekel invoices only and counts the foreign ones instead", () => {
    const data = buildDashboard(
      input({
        supplierInvoices: [
          { supplier: "AXTON", amount: "1000", currency: "ILS", orderId: 1 },
          { supplier: "DigiKey", amount: "500", currency: "USD", orderId: null },
        ],
        courierInvoices: [
          { courier: "DHL", amount: "351", currency: "ILS", allocatedTotal: "300", allocatedLines: 2 },
          { courier: "UPS", amount: "80", currency: "EUR", allocatedTotal: null, allocatedLines: 0 },
        ],
      }),
    );
    expect(data.docs.supplierIls).toBe(1000);
    expect(data.docs.courierIls).toBe(351);
    expect(data.docs.courierAllocated).toBe(300);
    expect(data.docs.foreignCurrency).toBe(2);
    expect(data.docs.supplierUnlinked).toBe(1);
  });

  it("ranks suppliers by shekel spend, biggest first", () => {
    const data = buildDashboard(
      input({
        supplierInvoices: [
          { supplier: "AXTON", amount: "100", currency: "ILS", orderId: 1 },
          { supplier: "AXTON", amount: "300", currency: "ILS", orderId: 1 },
          { supplier: "Mouser", amount: "250", currency: "ILS", orderId: 1 },
        ],
      }),
    );
    expect(data.topSuppliers).toEqual([
      { name: "AXTON", value: 400, count: 2 },
      { name: "Mouser", value: 250, count: 1 },
    ]);
  });

  it("ranks customers by open value and keeps at most five", () => {
    const lines = Array.from({ length: 7 }, (_, i) =>
      line({ lineId: i + 1, customerName: `לקוח ${i}`, qty: "1", unitPrice: String((i + 1) * 10) }),
    );
    const data = buildDashboard(input({ lines }));
    expect(data.topCustomers).toHaveLength(5);
    expect(data.topCustomers[0]).toEqual({ name: "לקוח 6", value: 70, count: 1 });
  });
});
