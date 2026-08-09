import { describe, expect, it } from "vitest";
import { requireBearer } from "./api-auth";
import { secretEquals } from "./auth";

const withAuth = (header?: string) =>
  new Request("https://example.test/api/bol/worklist", header ? { headers: { authorization: header } } : undefined);

describe("secretEquals", () => {
  it("matches identical strings and nothing else", () => {
    expect(secretEquals("s3cret", "s3cret")).toBe(true);
    expect(secretEquals("s3cret", "s3crey")).toBe(false);
    expect(secretEquals("s3cret", "s3cre")).toBe(false);
    expect(secretEquals("", "")).toBe(true);
    expect(secretEquals("", "x")).toBe(false);
  });

  it("compares by bytes, so non-ASCII secrets work", () => {
    expect(secretEquals("סוד", "סוד")).toBe(true);
    expect(secretEquals("סוד", "סור")).toBe(false);
  });
});

describe("requireBearer", () => {
  it("passes a correct token through", () => {
    expect(requireBearer(withAuth("Bearer tok"), "tok")).toBeNull();
  });

  it("accepts the scheme case-insensitively and with extra spacing", () => {
    expect(requireBearer(withAuth("bearer tok"), "tok")).toBeNull();
    expect(requireBearer(withAuth("BEARER  tok"), "tok")).toBeNull();
    expect(requireBearer(withAuth("  Bearer tok  "), "tok")).toBeNull();
  });

  it("rejects a wrong, missing or malformed token with 401", () => {
    expect(requireBearer(withAuth("Bearer nope"), "tok")?.status).toBe(401);
    expect(requireBearer(withAuth(), "tok")?.status).toBe(401);
    expect(requireBearer(withAuth("tok"), "tok")?.status).toBe(401);
    expect(requireBearer(withAuth("Basic dG9r"), "tok")?.status).toBe(401);
    expect(requireBearer(withAuth("Bearer"), "tok")?.status).toBe(401);
  });

  it("rejects everyone when the server-side token is unset", () => {
    // A forgotten environment variable must not open the endpoint up.
    expect(requireBearer(withAuth("Bearer tok"), undefined)?.status).toBe(401);
    expect(requireBearer(withAuth("Bearer "), "")?.status).toBe(401);
  });
});
