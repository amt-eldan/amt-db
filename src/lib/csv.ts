/**
 * Building a CSV the way Excel in Hebrew actually opens it, in one place.
 *
 * Three details decide whether a file opens correctly or as mojibake, and all
 * three were duplicated across the export buttons before this existed:
 *
 * - **A UTF-8 BOM.** Without it Excel on Windows reads the bytes as the local
 *   codepage and every Hebrew heading turns to noise. This is the whole reason
 *   the string starts with ﻿.
 * - **CRLF line endings**, which is what the CSV spec says and what Excel's
 *   importer is least surprising about.
 * - **Quoting only when needed**, with embedded quotes doubled — a supplier name
 *   containing a comma must not become two columns.
 */

/** One cell, quoted only if it would otherwise break the row. */
export function escapeCsvValue(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A carriage return has to trigger quoting too: rows are joined with CRLF, so
  // a bare \r inside a cell would end the row early.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export type CsvCell = string | number | null | undefined;

/** Header row plus body, as a complete CSV document ready to be written out. */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const body = rows.map((row) => row.map(escapeCsvValue).join(","));
  return "﻿" + [headers.map(escapeCsvValue).join(","), ...body].join("\r\n");
}

/**
 * Hands the file to the browser. Browser-only — callers are client components.
 *
 * The anchor is put in the document and the blob URL is revoked on a later tick.
 * Both matter outside Chrome: Firefox ignores a click on an anchor that is not in
 * the DOM, and revoking in the same tick as the click can cancel the download
 * before it starts.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
