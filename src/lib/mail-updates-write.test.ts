import { beforeEach, describe, expect, it, vi } from "vitest";
import { mailUpdateInput } from "./validation";

const { poLines, inserted, writeBolMatches, audit, revalidatePath } = vi.hoisted(() => ({
  poLines: [] as { poNumber: string; isOpen: boolean }[],
  inserted: [] as Record<string, unknown>[],
  writeBolMatches: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/db/queries", () => ({ getPoLineKeys: async () => poLines }));
vi.mock("./bol-write", () => ({ writeBolMatches }));
vi.mock("./audit", () => ({ audit }));
vi.mock("next/cache", () => ({ revalidatePath }));
// A fake insert with the table's unique (message, PO, kind) constraint.
vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const dup = inserted.some(
              (r) =>
                r.messageId === row.messageId && r.poNumber === row.poNumber && r.kind === row.kind,
            );
            if (dup) return [];
            inserted.push(row);
            return [{ id: inserted.length }];
          },
        }),
      }),
    }),
  },
}));

const { recordMailUpdates } = await import("./mail-updates-write");

const update = (over: Record<string, unknown> = {}) =>
  mailUpdateInput.parse({ poNumber: "4500012345", kind: "delay", emailId: "m1", ...over });

beforeEach(() => {
  poLines.length = 0;
  inserted.length = 0;
  writeBolMatches.mockReset();
  writeBolMatches.mockResolvedValue({ ok: true, written: 2, skipped: 0, results: [] });
  audit.mockReset();
  revalidatePath.mockReset();
});

describe("recordMailUpdates", () => {
  it("records an update against a purchase order we know, once", async () => {
    poLines.push({ poNumber: "PO-4500012345", isOpen: true });

    const first = await recordMailUpdates([update()], "agent");
    const second = await recordMailUpdates([update()], "agent");

    expect(first).toMatchObject({ recorded: 1, duplicates: 0 });
    expect(second).toMatchObject({ recorded: 0, duplicates: 1 });
    // Stored under the PO's key, so the spelling a report uses cannot split it.
    expect(inserted).toEqual([expect.objectContaining({ poNumber: "4500012345", source: "agent" })]);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("treats the same mail reported under another spelling of the PO as a duplicate", async () => {
    poLines.push({ poNumber: "PO-4500012345", isOpen: true }, { poNumber: "4500012345", isOpen: true });
    await recordMailUpdates([update({ poNumber: "PO-4500012345" })], "agent");
    const again = await recordMailUpdates([update({ poNumber: "4500-0123-45" })], "agent");
    expect(again).toMatchObject({ recorded: 0, duplicates: 1 });
    expect(inserted).toHaveLength(1);
  });

  // A partial shipment names the items it carried; only those get the waybill.
  it("narrows a partial shipment's waybill to the P/Ns it carried", async () => {
    poLines.push({ poNumber: "4500012345", isOpen: true });
    await recordMailUpdates(
      [update({ kind: "bol", bol: "9860064911", pns: ["PN-A", "PN-C"] })],
      "agent",
    );
    expect(writeBolMatches).toHaveBeenCalledWith([
      expect.objectContaining({ poNumber: "4500012345", pn: "PN-A" }),
      expect.objectContaining({ poNumber: "4500012345", pn: "PN-C" }),
    ]);
  });

  // A person who took a wrong waybill off a line must not see it come back with
  // the next run that happens to re-report the same mail.
  it("offers the waybill to the lines only when the mail is first recorded", async () => {
    poLines.push({ poNumber: "4500012345", isOpen: true });
    const bol = update({ kind: "bol", bol: "9860064911" });
    await recordMailUpdates([bol], "agent");
    await recordMailUpdates([bol], "agent");
    expect(writeBolMatches).toHaveBeenCalledTimes(1);
  });

  it("skips a purchase order no line carries", async () => {
    const summary = await recordMailUpdates([update({ poNumber: "999" })], "agent");
    expect(summary).toMatchObject({ recorded: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });

  // A shipping notice found by its purchase order puts the waybill on the order.
  it("writes a bill of lading onto the PO's lines through the shared gate", async () => {
    poLines.push({ poNumber: "4500012345", isOpen: true });
    const summary = await recordMailUpdates(
      [update({ kind: "bol", bol: "9860064911", carrier: "DHL", quote: "AWB 9860064911" })],
      "agent",
    );
    expect(writeBolMatches).toHaveBeenCalledWith([
      expect.objectContaining({
        bol: "9860064911",
        poNumber: "4500012345",
        lineId: null,
        sourceEmailId: "m1",
      }),
    ]);
    expect(summary.bol).toMatchObject({ written: 2 });
  });

  it("does not touch bills of lading for other kinds", async () => {
    poLines.push({ poNumber: "4500012345", isOpen: true });
    await recordMailUpdates([update({ kind: "payment_request" })], "agent");
    expect(writeBolMatches).not.toHaveBeenCalled();
  });
});
