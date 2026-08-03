/**
 * Whitespace counts as no bill of lading, the same way lineStatus treats it —
 * a bol of " " must not turn a line green.
 */
export function hasBol(line: { bol: string | null }): boolean {
  return !!line.bol?.trim();
}
