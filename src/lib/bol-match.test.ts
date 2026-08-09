import { describe, expect, it } from "vitest";
import {
  evaluateBolMatch,
  isBolEmpty,
  resolveBolLine,
  type BolCandidateLine,
} from "./bol-match";

const openEmpty = { bol: null, isOpen: true };
const match = { bol: "1Z999AA10123456784", confidence: null };

describe("isBolEmpty", () => {
  it("treats NULL and whitespace as empty", () => {
    expect(isBolEmpty({ bol: null })).toBe(true);
    expect(isBolEmpty({ bol: "" })).toBe(true);
    expect(isBolEmpty({ bol: "   " })).toBe(true);
    expect(isBolEmpty({ bol: "1Z999" })).toBe(false);
  });
});

describe("evaluateBolMatch", () => {
  it("writes a confident match onto an open, empty line", () => {
    expect(evaluateBolMatch(openEmpty, match)).toEqual({ write: true });
    expect(evaluateBolMatch(openEmpty, { ...match, confidence: "1" })).toEqual({ write: true });
    expect(evaluateBolMatch({ bol: "  ", isOpen: true }, match)).toEqual({ write: true });
  });

  it("never overwrites a bol that is already set", () => {
    const filled = { bol: "EXISTING123", isOpen: true };
    const verdict = evaluateBolMatch(filled, match);
    expect(verdict.write).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("different value") });
  });

  it("distinguishes a repeat of the same bol from a real conflict", () => {
    const same = evaluateBolMatch({ bol: " 1Z999AA10123456784 ", isOpen: true }, match);
    expect(same).toEqual({ write: false, reason: "bol already set (same value)" });
  });

  it("skips closed lines and unknown lines", () => {
    expect(evaluateBolMatch({ bol: null, isOpen: false }, match)).toEqual({
      write: false,
      reason: "line is closed",
    });
    expect(evaluateBolMatch(undefined, match)).toEqual({
      write: false,
      reason: "line not found",
    });
  });

  it("skips low confidence rather than guessing", () => {
    expect(evaluateBolMatch(openEmpty, { ...match, confidence: "0.3" }).write).toBe(false);
    expect(evaluateBolMatch(openEmpty, { ...match, confidence: "0" }).write).toBe(false);
    // At/above the floor it writes; absent confidence is asserted by the agent.
    expect(evaluateBolMatch(openEmpty, { ...match, confidence: "0.5" }).write).toBe(true);
    expect(evaluateBolMatch(openEmpty, { ...match, confidence: null }).write).toBe(true);
  });

  it("checks the line state before confidence, so a conflict is never masked", () => {
    const verdict = evaluateBolMatch(
      { bol: "EXISTING123", isOpen: true },
      { ...match, confidence: "0.1" },
    );
    expect(verdict).toMatchObject({ reason: expect.stringContaining("already set") });
  });
});

function candidate(over: Partial<BolCandidateLine> = {}): BolCandidateLine {
  return {
    lineId: 1,
    orderNumber: "4441537295",
    pn: "CH-USB-2-1.0AB",
    sku: "10-813580624",
    poNumber: "PO-8871",
    supplier: "AXTON",
    bol: null,
    isOpen: true,
    ...over,
  };
}

describe("resolveBolLine", () => {
  it("finds the open line by the P/N quoted in the email", () => {
    const lines = [candidate(), candidate({ lineId: 2, pn: "OTHER-PN", poNumber: "PO-9000" })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines)).toEqual({ lineId: 1, matchedBy: "pn" });
  });

  it("reads a retyped P/N: separators and case are noise", () => {
    const lines = [candidate()];
    expect(resolveBolLine({ pn: "ch usb 2 1.0ab" }, lines)).toMatchObject({ lineId: 1 });
    expect(resolveBolLine({ pn: "CHUSB210AB" }, lines)).toMatchObject({ lineId: 1 });
  });

  it("matches the P/N against the catalog number too", () => {
    expect(resolveBolLine({ pn: "10-813580624" }, [candidate()])).toMatchObject({ lineId: 1 });
  });

  it("reports the P/N it could not place", () => {
    expect(resolveBolLine({ pn: "NOT-OURS" }, [candidate()])).toEqual({
      lineId: null,
      reason: "no line matches pn=NOT-OURS",
    });
  });

  it("prefers the PO number and says so", () => {
    const lines = [candidate()];
    expect(resolveBolLine({ poNumber: "PO-8871", pn: "CH-USB-2-1.0AB" }, lines)).toEqual({
      lineId: 1,
      matchedBy: "poNumber",
    });
  });

  it("keys narrow rather than compete: a wrong second key is not a match", () => {
    const lines = [candidate()];
    expect(resolveBolLine({ poNumber: "PO-8871", pn: "SOMETHING-ELSE" }, lines)).toMatchObject({
      lineId: null,
    });
  });

  // The whole point of the guard: one P/N on two open orders is not a decision
  // an unattended run gets to make.
  it("refuses to guess when several open lines share the P/N", () => {
    const lines = [candidate({ lineId: 4 }), candidate({ lineId: 7, orderNumber: "4441537999" })];
    const resolution = resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines);
    expect(resolution.lineId).toBe(null);
    expect(resolution).toMatchObject({
      reason: expect.stringContaining("2 open lines match pn=CH-USB-2-1.0AB (lines 4, 7)"),
    });
  });

  it("breaks that tie with the order number, or with the supplier", () => {
    const lines = [candidate({ lineId: 4 }), candidate({ lineId: 7, orderNumber: "4441537999" })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB", orderNumber: "4441537999" }, lines)).toMatchObject(
      { lineId: 7 },
    );

    const two = [candidate({ lineId: 4 }), candidate({ lineId: 7, supplier: "DIGIKEY" })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB", supplier: "digikey" }, two)).toMatchObject({
      lineId: 7,
    });
  });

  it("skips lines that already have a bill of lading, so the waiting one gets it", () => {
    const lines = [
      candidate({ lineId: 4, bol: "1Z-EARLIER" }),
      candidate({ lineId: 7 }),
      candidate({ lineId: 9, isOpen: false }),
    ];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines)).toMatchObject({ lineId: 7 });
  });

  // Returning the line (instead of "no match") is what lets evaluateBolMatch say
  // whether this is a repeat of the same number or a real conflict.
  it("hands back the single taken line so the write guard can name the reason", () => {
    const lines = [candidate({ lineId: 4, bol: "1Z-EARLIER" })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines)).toMatchObject({ lineId: 4 });
  });

  it("reports a closed line as closed, not as missing", () => {
    const lines = [candidate({ isOpen: false })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines)).toEqual({
      lineId: null,
      reason: "only closed lines match pn=CH-USB-2-1.0AB",
    });
  });

  it("reports when every matching open line is already filled", () => {
    const lines = [candidate({ lineId: 4, bol: "A" }), candidate({ lineId: 7, bol: "B" })];
    expect(resolveBolLine({ pn: "CH-USB-2-1.0AB" }, lines)).toEqual({
      lineId: null,
      reason:
        "all 2 open lines matching pn=CH-USB-2-1.0AB already have a bill of lading (lines 4, 7)",
    });
  });

  it("supplier alone never identifies a line", () => {
    expect(resolveBolLine({ supplier: "AXTON" }, [candidate()])).toEqual({
      lineId: null,
      reason: "no lineId and no search keys (pn / poNumber / orderNumber)",
    });
    expect(resolveBolLine({ pn: "  " }, [candidate()])).toMatchObject({ lineId: null });
  });
});
