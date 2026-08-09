import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderLine } from "@/db/schema";
import { bolMatchInput } from "./validation";

// The lines the fake database will hand back, keyed by id. `inArray` is stubbed
// to a plain { ids } so the fake can see which ids were asked for without pulling
// in drizzle's expression machinery.
const { rows, candidates, applyLineFields, revalidatePath, getBolCandidateLines } = vi.hoisted(
  () => ({
    rows: new Map<number, unknown>(),
    candidates: [] as unknown[],
    applyLineFields: vi.fn(),
    revalidatePath: vi.fn(),
    getBolCandidateLines: vi.fn(),
  }),
);

vi.mock("drizzle-orm", () => ({ inArray: (_column: unknown, ids: number[]) => ({ ids }) }));
// Stubbed rather than exercised: the resolver itself is covered in bol-match.test.ts,
// and importing the real queries module would drag drizzle's query builder in.
vi.mock("@/db/queries", () => ({ getBolCandidateLines }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("./line-fields", () => ({ applyLineFields }));
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

const { writeBolMatches } = await import("./bol-write");

/** An open line with nothing filled in yet — the normal target of a match. */
function line(over: Partial<OrderLine> = {}): OrderLine {
  return {
    id: 42,
    bol: null,
    isOpen: true,
    deliveryUpdate: null,
    carrier: null,
    ...over,
  } as OrderLine;
}

const match = (over: Record<string, unknown> = {}) =>
  bolMatchInput.parse({ lineId: 42, bol: "1Z999AA10123456784", ...over });

/** The field object handed to applyLineFields on the nth write. */
const writtenFields = (call = 0) => applyLineFields.mock.calls[call][1] as Record<string, unknown>;

beforeEach(() => {
  rows.clear();
  candidates.length = 0;
  applyLineFields.mockClear();
  revalidatePath.mockClear();
  getBolCandidateLines.mockReset();
  getBolCandidateLines.mockImplementation(async () => candidates);
});

describe("writeBolMatches", () => {
  it("writes a match onto an open, empty line and reports it", async () => {
    rows.set(42, line());

    const summary = await writeBolMatches([match({ carrier: "UPS", confidence: 0.95 })]);

    expect(summary).toEqual({
      ok: true,
      written: 1,
      skipped: 0,
      results: [{ lineId: 42, status: "written", matchedBy: "lineId" }],
    });
    expect(writtenFields()).toMatchObject({
      bol: "1Z999AA10123456784",
      carrier: "UPS",
      bolSource: "auto",
      bolConfidence: "0.95",
    });
  });

  it("records the source email as provenance, so an automatic write is reviewable", async () => {
    rows.set(42, line());

    await writeBolMatches([
      match({ sourceEmailId: "18fabc123", sourceQuote: "your shipment has been delivered" }),
    ]);

    expect(applyLineFields.mock.calls[0][2]).toMatchObject({
      agent: "bol-tracking",
      emailId: "18fabc123",
      quote: "your shipment has been delivered",
    });
  });

  it("never overwrites a bill of lading that is already there", async () => {
    rows.set(42, line({ bol: "EXISTING123" }));

    const summary = await writeBolMatches([match()]);

    expect(applyLineFields).not.toHaveBeenCalled();
    expect(summary.written).toBe(0);
    expect(summary.results[0]).toMatchObject({
      lineId: 42,
      status: "skipped",
      reason: expect.stringContaining("different value"),
    });
  });

  it("skips closed lines, unknown lines and low-confidence guesses", async () => {
    rows.set(1, line({ id: 1, isOpen: false }));
    rows.set(3, line({ id: 3 }));
    // id 2 is deliberately absent — a lineId the agent invented.

    const summary = await writeBolMatches([
      match({ lineId: 1 }),
      match({ lineId: 2 }),
      match({ lineId: 3, confidence: 0.2 }),
    ]);

    expect(applyLineFields).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ written: 0, skipped: 3 });
    expect(summary.results.map((r) => r.reason)).toEqual([
      "line is closed",
      "line not found",
      expect.stringContaining("below 0.5"),
    ]);
  });

  it("normalises the carrier status and fills delivery_update while it is empty", async () => {
    rows.set(42, line({ deliveryUpdate: "  " }));

    await writeBolMatches([match({ statusText: "Delivered", etaDate: "2026-08-20" })]);

    expect(writtenFields()).toMatchObject({
      shipmentStatus: "delivered",
      deliveryUpdate: "Delivered",
      shipmentEta: "2026-08-20",
    });
    expect(writtenFields().shipmentStatusAt).toBeInstanceOf(Date);
  });

  it("leaves a human's delivery_update alone while still recording the status", async () => {
    rows.set(42, line({ deliveryUpdate: "דיברתי עם הספק, יוצא ביום ראשון" }));

    await writeBolMatches([match({ statusText: "In transit" })]);

    const fields = writtenFields();
    expect(fields.shipmentStatus).toBe("in_transit");
    expect(fields).not.toHaveProperty("deliveryUpdate");
  });

  it("counts a mixed batch and revalidates only when something was written", async () => {
    rows.set(42, line());
    rows.set(43, line({ id: 43, bol: "ALREADY" }));

    const summary = await writeBolMatches([match(), match({ lineId: 43 })]);

    expect(summary).toMatchObject({ ok: true, written: 1, skipped: 1 });
    expect(revalidatePath).toHaveBeenCalledWith("/bol");
    expect(revalidatePath).toHaveBeenCalledWith("/orders");
  });

  it("does not revalidate when every match was skipped", async () => {
    rows.set(42, line({ bol: "ALREADY" }));

    await writeBolMatches([match()]);

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("writes nothing for an empty batch", async () => {
    const summary = await writeBolMatches([]);
    expect(summary).toEqual({ ok: true, written: 0, skipped: 0, results: [] });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never looks up candidates when every match names its line", async () => {
    rows.set(42, line());

    await writeBolMatches([match()]);

    expect(getBolCandidateLines).not.toHaveBeenCalled();
  });

  it("resolves a match with no lineId from the keys the email quoted", async () => {
    rows.set(42, line());
    candidates.push({
      lineId: 42,
      orderNumber: "ORD-1",
      pn: "ABC-123",
      sku: null,
      poNumber: "PO-9",
      supplier: "Acme",
      bol: null,
      isOpen: true,
    });

    const summary = await writeBolMatches([
      bolMatchInput.parse({ bol: "1Z999AA10123456784", poNumber: "PO-9" }),
    ]);

    expect(summary).toMatchObject({
      written: 1,
      results: [{ lineId: 42, status: "written", matchedBy: "poNumber" }],
    });
    // The keys that found the line travel to the audit trail next to the email.
    expect(applyLineFields.mock.calls[0][2]).toMatchObject({
      matchedBy: "poNumber",
      searchKeys: { poNumber: "PO-9" },
    });
  });

  it("reports a lineId-less match it could not resolve instead of guessing", async () => {
    const summary = await writeBolMatches([
      bolMatchInput.parse({ bol: "1Z999AA10123456784", pn: "NOT-HERE" }),
    ]);

    expect(summary).toMatchObject({ written: 0, skipped: 1 });
    expect(summary.results[0]).toMatchObject({ lineId: null, status: "skipped" });
    expect(summary.results[0].reason).toBeTruthy();
    expect(applyLineFields).not.toHaveBeenCalled();
  });
});
