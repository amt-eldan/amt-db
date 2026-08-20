/**
 * Whitespace counts as no bill of lading, the same way lineStatus treats it —
 * a bol of " " must not colour a line as shipped.
 */
export function hasBol(line: { bol: string | null }): boolean {
  return !!line.bol?.trim();
}
