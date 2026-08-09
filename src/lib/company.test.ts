import { describe, expect, it } from "vitest";
import { isOwnCompanyName } from "./company";

describe("isOwnCompanyName", () => {
  it("recognises the forms our own name takes on documents", () => {
    for (const name of [
      "AMT",
      "amt",
      "A.M.T",
      "א.מ.ט",
      "אמט",
      'א.מ.ט טכנולוגיות בע"מ',
      "AMT Ltd.",
      "Atrium Micro Technologies",
      "atrium micro technologies ltd",
      "אטריום מיקרו טכנולוגיות",
    ]) {
      expect(isOwnCompanyName(name), name).toBe(true);
    }
  });

  it("does not swallow customers that merely look similar", () => {
    for (const name of [
      "AMTEK",
      "Amtel Electronics",
      "משרד ראש הממשלה",
      "Ness-Tech",
      "134",
      "אלביט מערכות",
      "",
      "   ",
    ]) {
      expect(isOwnCompanyName(name), name).toBe(false);
    }
  });
});
