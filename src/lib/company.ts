/**
 * Who "we" are, for extraction that has to tell us apart from the other party on
 * the document.
 *
 * A customer's purchase order is addressed *to us*: the "לכבוד" / "ספק" /
 * "Vendor" block carries our name, and the buyer is whoever issued the document.
 * Reading it the other way round files our own name as the customer, so the
 * extractor recognises our name and refuses to store it in `customer`.
 */

/** How we refer to ourselves in Hebrew UI copy and in the extraction prompt. */
export const OWN_COMPANY_LABEL = "Atrium Micro Technologies (AMT)";

/** Whole-token forms of the short name — "AMTEK" is a different company. */
const OWN_NAME_TOKENS = new Set(["amt", "אמט"]);

/** Full-name forms, matched after whitespace is squeezed out. */
const OWN_NAME_FRAGMENTS = ["atriummicro", "אטריוםמיקרו"];

/**
 * Lowercase and drop everything that varies between documents — the dots in
 * "א.מ.ט", the quotes in `בע"מ`, a trailing "Ltd." — so the forms we actually
 * see on paper collapse onto the same string.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/["'`״׳.,()\[\]/\\_-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t !== "" && !["ltd", "inc", "llc", "co", "בעמ", "חברת"].includes(t))
    .join(" ");
}

/**
 * True when `name` is our own company rather than a customer. Deliberately
 * narrow: it must be our short name as a whole token, or our full name — a
 * customer whose name merely contains those letters is not us.
 */
export function isOwnCompanyName(name: string): boolean {
  const normalized = normalize(name);
  if (normalized === "") return false;
  if (normalized.split(" ").some((token) => OWN_NAME_TOKENS.has(token))) return true;
  const compact = normalized.replace(/ /g, "");
  return OWN_NAME_FRAGMENTS.some((fragment) => compact.includes(fragment));
}
