import { describe, expect, it } from "vitest";
import { isAlreadyExists, isUniqueViolation, pgErrorCode } from "./pg-error";

describe("isUniqueViolation", () => {
  it("detects the pg error directly", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  it("detects it through the wrapper drizzle throws", () => {
    // drizzle: new Error("Failed query: ...", { cause: pgError })
    const pgError = Object.assign(new Error("duplicate key value"), { code: "23505" });
    expect(isUniqueViolation(new Error("Failed query: insert into …", { cause: pgError }))).toBe(true);
  });

  it("ignores other postgres errors", () => {
    const notNull = Object.assign(new Error("null value"), { code: "23502" });
    expect(isUniqueViolation(new Error("Failed query", { cause: notNull }))).toBe(false);
  });

  it("is safe on plain errors, strings, null and cyclic causes", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);

    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});

describe("pgErrorCode", () => {
  it("returns the code from under drizzle's wrapper", () => {
    const pgError = Object.assign(new Error("column already exists"), { code: "42701" });
    expect(pgErrorCode(new Error("Failed query", { cause: pgError }))).toBe("42701");
  });

  it("returns null when there is no code to find", () => {
    expect(pgErrorCode(new Error("boom"))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
  });
});

describe("isAlreadyExists", () => {
  it("recognizes a duplicate table, column and object", () => {
    for (const code of ["42P07", "42701", "42710"]) {
      expect(isAlreadyExists(Object.assign(new Error("dup"), { code }))).toBe(true);
    }
  });

  it("does not mistake other failures for it", () => {
    expect(isAlreadyExists(Object.assign(new Error("nope"), { code: "42P01" }))).toBe(false);
    expect(isAlreadyExists(new Error("boom"))).toBe(false);
  });
});
