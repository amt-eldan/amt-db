import { describe, expect, it } from "vitest";
import { bestTrackingCandidate, findTrackingCandidates } from "./tracking-extract";
import { MIN_AUTO_CONFIDENCE } from "./bol-match";

const writable = (confidence: number) => confidence >= MIN_AUTO_CONFIDENCE;

describe("findTrackingCandidates — carrier shapes", () => {
  it("reads a labelled UPS number and names the carrier", () => {
    const [found] = findTrackingCandidates("Tracking Number: 1Z999AA10123456784");
    expect(found.bol).toBe("1Z999AA10123456784");
    expect(found.carrier).toBe("UPS");
    expect(writable(found.confidence)).toBe(true);
  });

  it("reads a UPS number printed in groups, and stores it without the spaces", () => {
    const [found] = findTrackingCandidates("Tracking Number: 1Z 999 AA1 0123 4567 84");
    expect(found.bol).toBe("1Z999AA10123456784");
    expect(found.carrier).toBe("UPS");
  });

  it("reads a FedEx number printed as three groups of four", () => {
    const [found] = findTrackingCandidates("Your tracking number is 7712 3456 7890");
    expect(found.bol).toBe("771234567890");
    expect(found.carrier).toBe("FedEx");
    expect(writable(found.confidence)).toBe(true);
  });

  it("reads a DHL Express ten-digit number", () => {
    const [found] = findTrackingCandidates("AWB 1234567890 has shipped");
    expect(found.bol).toBe("1234567890");
    expect(found.carrier).toBe("DHL");
  });

  it("reads a DHL eCommerce prefixed number", () => {
    const [found] = findTrackingCandidates("Waybill: JJD0099998888777766");
    expect(found.carrier).toBe("DHL");
    expect(writable(found.confidence)).toBe(true);
  });

  it("reads the Hebrew label too", () => {
    const [found] = findTrackingCandidates("שטר מטען: 1Z999AA10123456784 נשלח אליכם");
    expect(found.bol).toBe("1Z999AA10123456784");
    expect(writable(found.confidence)).toBe(true);
  });

  it("finds a number in the subject line, where carriers put it", () => {
    const [found] = findTrackingCandidates(
      "FedEx Shipment 771234567890 Delivered\nYour package arrived.",
    );
    expect(found.bol).toBe("771234567890");
    expect(writable(found.confidence)).toBe(true);
  });
});

describe("findTrackingCandidates — what it refuses to write", () => {
  // The whole reason the extractor scores instead of just matching.
  it("will not write a number no label vouched for", () => {
    const [found] = findTrackingCandidates("Invoice total 771234567890 for your records");
    expect(found.bol).toBe("771234567890");
    expect(writable(found.confidence)).toBe(false);
  });

  // A purchase order is very often ten digits, which is also a DHL number.
  it("never returns the line's own purchase order number", () => {
    const found = findTrackingCandidates("Tracking Number: 4501234567", {
      poNumber: "4501234567",
    });
    expect(found).toHaveLength(0);
  });

  it("never returns the line's order number or part number", () => {
    const found = findTrackingCandidates("tracking 771234567890 for P/N 1Z999AA10123456784", {
      orderNumber: "7712-3456-7890",
      pn: "1z999aa10123456784",
    });
    expect(found).toHaveLength(0);
  });

  it("drops placeholder padding", () => {
    expect(findTrackingCandidates("Tracking Number: 0000000000")).toHaveLength(0);
  });

  it("drops an unlabelled timestamp that happens to be digits", () => {
    expect(findTrackingCandidates("message id 202608261234 in our logs")).toHaveLength(0);
  });

  it("keeps a labelled number even when its digits open with a date", () => {
    const [found] = findTrackingCandidates("Tracking Number: 202608261234");
    expect(found.bol).toBe("202608261234");
    expect(writable(found.confidence)).toBe(true);
  });

  it("finds nothing in a mail with no numbers at all", () => {
    expect(findTrackingCandidates("Your order has been received. Thank you.")).toHaveLength(0);
  });

  it("finds nothing in empty text", () => {
    expect(findTrackingCandidates("")).toHaveLength(0);
  });
});

describe("findTrackingCandidates — label proximity", () => {
  it("does not let a distant label vouch for a number", () => {
    const far = `Tracking Number: 1Z999AA10123456784${" ".repeat(200)}9988776655`;
    const found = findTrackingCandidates(far);
    const ups = found.find((c) => c.carrier === "UPS")!;
    const orphan = found.find((c) => c.bol === "9988776655")!;
    expect(writable(ups.confidence)).toBe(true);
    expect(writable(orphan.confidence)).toBe(false);
  });

  it("keeps the label across a line break, where carriers put it", () => {
    const [found] = findTrackingCandidates("Tracking Number:\n\n  1Z999AA10123456784");
    expect(writable(found.confidence)).toBe(true);
  });

  it("reports every number it found, best first", () => {
    const found = findTrackingCandidates(
      "Tracking Number: 1Z999AA10123456784. Also in this mail: 5544332211.",
    );
    expect(found).toHaveLength(2);
    expect(found[0].bol).toBe("1Z999AA10123456784");
    expect(found[0].confidence).toBeGreaterThan(found[1].confidence);
  });

  it("does not count the same number twice when it appears twice", () => {
    const found = findTrackingCandidates(
      "Tracking Number: 1Z999AA10123456784 — see 1Z999AA10123456784 for details",
    );
    expect(found).toHaveLength(1);
  });

  it("carries a quote of its surroundings for the audit trail", () => {
    const [found] = findTrackingCandidates("Dear customer, tracking number 1Z999AA10123456784 ships today");
    expect(found.quote).toContain("1Z999AA10123456784");
    expect(found.quote).not.toContain("\n");
  });
});

describe("bestTrackingCandidate", () => {
  it("picks the clear winner", () => {
    const best = bestTrackingCandidate(
      findTrackingCandidates("Tracking Number: 1Z999AA10123456784 and also 5544332211"),
    );
    expect(best?.bol).toBe("1Z999AA10123456784");
  });

  // Two equally-vouched numbers in one mail is the ambiguity the whole matching
  // path refuses to resolve by guessing.
  it("refuses to choose between two equally strong numbers", () => {
    const best = bestTrackingCandidate(
      findTrackingCandidates(
        "Tracking Number: 1Z999AA10123456784\nTracking Number: 1Z999AA10123456785",
      ),
    );
    expect(best).toBeNull();
  });

  it("is null when nothing was found", () => {
    expect(bestTrackingCandidate([])).toBeNull();
  });
});
