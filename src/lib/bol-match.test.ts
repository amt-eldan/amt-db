import { describe, expect, it } from "vitest";
import { evaluateBolMatch, isBolEmpty } from "./bol-match";

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
