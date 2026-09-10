import { describe, expect, it } from "vitest";
import { escapeCsvValue, toCsv } from "./csv";

describe("escapeCsvValue", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeCsvValue("DigiKey")).toBe("DigiKey");
    expect(escapeCsvValue(41.5)).toBe("41.5");
  });

  it("is empty for nothing, not the string 'null'", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  // A supplier name with a comma is the case that silently shifts every column
  // after it by one.
  it("quotes a value containing a comma", () => {
    expect(escapeCsvValue("Arrow Electronics, Inc.")).toBe('"Arrow Electronics, Inc."');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvValue('P/N "special"')).toBe('"P/N ""special"""');
  });

  it("quotes a value containing a newline or a carriage return", () => {
    expect(escapeCsvValue("line one\nline two")).toBe('"line one\nline two"');
    expect(escapeCsvValue("line one\rline two")).toBe('"line one\rline two"');
  });
});

describe("toCsv", () => {
  it("starts with a BOM, so Excel reads Hebrew as UTF-8", () => {
    expect(toCsv(["לקוח"], [])).toBe("﻿לקוח");
  });

  it("joins rows with CRLF", () => {
    const csv = toCsv(["a", "b"], [
      [1, 2],
      [3, 4],
    ]);
    expect(csv).toBe("﻿a,b\r\n1,2\r\n3,4");
  });

  it("escapes the header row too", () => {
    expect(toCsv(["מחיר, בשקלים"], [])).toBe('﻿"מחיר, בשקלים"');
  });

  it("writes a header-only document when there are no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("﻿a,b");
  });
});
