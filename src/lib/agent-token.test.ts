import { describe, expect, it } from "vitest";
import { isValidAgentToken } from "./agent-token";

const SECRET = "s3cret-bol-agent-token";

describe("isValidAgentToken", () => {
  it("accepts the configured token", () => {
    expect(isValidAgentToken(SECRET, SECRET)).toBe(true);
  });

  it("rejects a wrong token, including near misses and prefixes", () => {
    for (const candidate of [
      "wrong",
      SECRET.slice(0, -1), // one character short
      SECRET + "x", // one character long
      SECRET.toUpperCase(),
      " " + SECRET, // padding is not trimmed away
      SECRET.replace("s3", "s4"),
    ]) {
      expect(isValidAgentToken(candidate, SECRET), candidate).toBe(false);
    }
  });

  it("rejects an empty or missing candidate", () => {
    expect(isValidAgentToken("", SECRET)).toBe(false);
    expect(isValidAgentToken(undefined, SECRET)).toBe(false);
    expect(isValidAgentToken(null, SECRET)).toBe(false);
  });

  it("stays closed when no token is configured — an unset secret is not a wildcard", () => {
    expect(isValidAgentToken("anything", undefined)).toBe(false);
    expect(isValidAgentToken("anything", "")).toBe(false);
    expect(isValidAgentToken("", "")).toBe(false);
    expect(isValidAgentToken(undefined, undefined)).toBe(false);
  });

  it("does not throw on a length mismatch (timingSafeEqual would, on raw buffers)", () => {
    expect(() => isValidAgentToken("a", "a-much-longer-secret")).not.toThrow();
  });

  it("falls back to BOL_AGENT_TOKEN from the environment", () => {
    const previous = process.env.BOL_AGENT_TOKEN;
    process.env.BOL_AGENT_TOKEN = SECRET;
    try {
      expect(isValidAgentToken(SECRET)).toBe(true);
      expect(isValidAgentToken("nope")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOL_AGENT_TOKEN;
      else process.env.BOL_AGENT_TOKEN = previous;
    }
  });
});
