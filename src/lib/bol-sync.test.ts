import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BolWorklistRow } from "@/db/queries";
import type { GmailPort } from "./bol-sync";
import type { ParsedEmail } from "./gmail-parse";

// The worklist and the writer are the two things this module touches outside
// itself. Both are stubbed: the writer's own rules are covered in
// bol-write.test.ts, and what is worth testing here is the mail→line matching and
// what the run decides to hand over.
const { getBolWorklist, writeBolMatches } = vi.hoisted(() => ({
  getBolWorklist: vi.fn(),
  writeBolMatches: vi.fn(),
}));

vi.mock("@/db/queries", () => ({ getBolWorklist }));
vi.mock("./bol-write", () => ({ writeBolMatches }));

const { syncBolFromMail } = await import("./bol-sync");

function worklistLine(over: Partial<BolWorklistRow> = {}): BolWorklistRow {
  return {
    lineId: 42,
    orderNumber: "5975",
    customer: "Ness-Tech",
    pn: "CH-USB-2",
    sku: null,
    poNumber: "4501234567",
    supplier: "DigiKey",
    contractDueDate: null,
    buyPriceUsd: null,
    ...over,
  };
}

function mail(over: Partial<ParsedEmail> & { id: string }): ParsedEmail {
  return {
    threadId: null,
    subject: "",
    from: "shipping@digikey.com",
    date: "2026-08-20",
    text: "",
    ...over,
  };
}

/** A mailbox that answers every search with the same set of mails. */
function port(mails: ParsedEmail[]): GmailPort {
  const byId = new Map(mails.map((m) => [m.id, m]));
  return {
    search: vi.fn(async () => [...byId.keys()]),
    fetch: vi.fn(async (id: string) => byId.get(id)!),
  };
}

/** What was actually passed to the writer on the single call it received. */
const written = () => writeBolMatches.mock.calls[0]?.[0] ?? [];

beforeEach(() => {
  getBolWorklist.mockReset();
  writeBolMatches.mockReset();
  writeBolMatches.mockResolvedValue({ ok: true, written: 1, skipped: 0, results: [] });
});

describe("syncBolFromMail — matching a mail to a line", () => {
  it("writes a labelled number from a mail that names the purchase order", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({
      gmail: port([
        mail({
          id: "m1",
          text: "Re: PO 4501234567\nTracking Number: 1Z999AA10123456784",
        }),
      ]),
    });

    expect(result.ok).toBe(true);
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ lineId: 42, bol: "1Z999AA10123456784", carrier: "UPS" });
    expect(written()[0].sourceEmailId).toBe("m1");
  });

  it("matches a purchase order written with separators", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "PO 450-123-4567 tracking 1Z999AA10123456784" })]),
    });
    expect(written()).toHaveLength(1);
  });

  it("matches on the part number when the mail quotes no purchase order", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "Your P/N CH-USB-2 shipped, AWB 1234567890" })]),
    });
    expect(written()[0]).toMatchObject({ bol: "1234567890", carrier: "DHL" });
  });

  it("ignores a mail that names no line on the worklist", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "Tracking Number: 1Z999AA10123456784 for PO 9999999999" })]),
    });
    expect(writeBolMatches).not.toHaveBeenCalled();
    expect(result.ok && result.matchedLines).toBe(0);
  });

  // The substring trap: "5975" appears inside "159755", and matching it would
  // attach a stranger's tracking number to this line.
  it("does not match an order number that merely appears inside a longer number", async () => {
    getBolWorklist.mockResolvedValue([
      worklistLine({ poNumber: null, pn: null, orderNumber: "5975" }),
    ]);
    await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "invoice 15975500 tracking 1Z999AA10123456784" })]),
    });
    expect(writeBolMatches).not.toHaveBeenCalled();
  });

  it("never offers the line's own purchase order as the tracking number", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "Your shipment 4501234567 is on its way" })]),
    });
    expect(writeBolMatches).not.toHaveBeenCalled();
    expect(result.ok && result.review).toHaveLength(0);
  });

  it("reads one mail once even when it serves several lines", async () => {
    getBolWorklist.mockResolvedValue([
      worklistLine({ lineId: 1, poNumber: "4501234567" }),
      worklistLine({ lineId: 2, poNumber: "4507654321" }),
    ]);
    const gmail = port([
      mail({
        id: "m1",
        text: "PO 4501234567 and PO 4507654321\nTracking Number: 1Z999AA10123456784",
      }),
    ]);
    const result = await syncBolFromMail({ gmail });
    expect(result.ok && result.mailsRead).toBe(1);
    expect(written()).toHaveLength(2);
  });
});

describe("syncBolFromMail — what it reports instead of writing", () => {
  it("reports two equally strong numbers rather than choosing", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({
      gmail: port([
        mail({ id: "m1", text: "PO 4501234567 Tracking Number: 1Z999AA10123456784" }),
        mail({ id: "m2", text: "PO 4501234567 Tracking Number: 1Z999AA10123456785" }),
      ]),
    });
    expect(writeBolMatches).not.toHaveBeenCalled();
    expect(result.ok && result.review[0].reason).toContain("בדיקה ידנית");
  });

  it("treats the same number in two mails as confirmation, not a conflict", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({
      gmail: port([
        mail({ id: "m1", text: "PO 4501234567 Tracking Number: 1Z999AA10123456784" }),
        mail({ id: "m2", text: "PO 4501234567 Tracking Number: 1Z999AA10123456784" }),
      ]),
    });
    expect(written()).toHaveLength(1);
    expect(result.ok && result.review).toHaveLength(0);
  });

  // The writer is the one place that decides; its reason is what the user needs.
  it("surfaces the writer's skip reason as a review item", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    writeBolMatches.mockResolvedValue({
      ok: true,
      written: 0,
      skipped: 1,
      results: [{ lineId: 42, status: "skipped", reason: "bol already set (same value)" }],
    });
    const result = await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "PO 4501234567 Tracking Number: 1Z999AA10123456784" })]),
    });
    expect(result.ok && result.written).toBe(0);
    expect(result.ok && result.review[0].reason).toBe("bol already set (same value)");
  });

  it("hands an unvouched number over anyway, for the writer to refuse", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "PO 4501234567 — reference 9988776655 attached" })]),
    });
    // Below the auto floor, so it is sent with its low confidence and refused
    // there rather than being silently dropped here.
    expect(Number(written()[0].confidence)).toBeLessThan(0.5);
  });

  it("never sends a status, so a mail cannot turn a row green", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    await syncBolFromMail({
      gmail: port([
        mail({
          id: "m1",
          text: "PO 4501234567 Tracking Number: 1Z999AA10123456784 — Delivered, signed for",
        }),
      ]),
    });
    expect(written()[0].statusText).toBeNull();
    expect(written()[0].deliveredAt).toBeNull();
  });
});

describe("syncBolFromMail — bounds and failures", () => {
  it("does nothing at all when no line is missing a bill of lading", async () => {
    getBolWorklist.mockResolvedValue([]);
    const gmail = port([]);
    const result = await syncBolFromMail({ gmail });
    expect(gmail.search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, worklist: 0, written: 0 });
  });

  it("reports being cut short instead of running past its budget", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    // A clock already past the deadline: nothing may be fetched.
    const result = await syncBolFromMail({
      gmail: port([mail({ id: "m1", text: "PO 4501234567 tracking 1Z999AA10123456784" })]),
      budgetMs: 0,
      now: () => 1_000,
    });
    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.mailsRead).toBe(0);
  });

  it("says so when the mailbox is not configured", async () => {
    getBolWorklist.mockResolvedValue([worklistLine()]);
    const result = await syncBolFromMail({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("GMAIL_SERVICE_ACCOUNT_EMAIL");
  });
});
