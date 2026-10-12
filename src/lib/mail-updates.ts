/**
 * Supplier mail about a purchase order, the way the rest of the app reads it.
 *
 * The scheduled Claude task already reads the orders mailbox twice a day for
 * bills of lading. A supplier writes about more than that — the shipment is late,
 * a pro-forma has to be paid before they release the goods — and until now all of
 * that stayed in the mailbox. The task now reports those too, keyed by our PO
 * number (the one identifier supplier mail reliably quotes), and the dashboard
 * and /updates screen show what is still unhandled.
 *
 * Pure: labels, the PO key, and the dashboard counts. The writing is in
 * ./mail-updates-write.
 */

import { poKey } from "./courier-match";

export const MAIL_UPDATE_KINDS = ["bol", "delay", "payment_request"] as const;
export type MailUpdateKind = (typeof MAIL_UPDATE_KINDS)[number];

export const MAIL_UPDATE_LABELS: Record<MailUpdateKind, string> = {
  bol: "שטר מטען",
  delay: "עיכוב באספקה",
  payment_request: "בקשה לתשלום",
};

export function isMailUpdateKind(value: unknown): value is MailUpdateKind {
  return typeof value === "string" && (MAIL_UPDATE_KINDS as readonly string[]).includes(value);
}

/** The PO comparison key — shared with the bill-of-lading resolver (courier-match). */
export { poKey };

/**
 * A link that opens the mail in Gmail, for whoever is signed in to the orders
 * mailbox. Gmail's web client accepts the API's hex thread id after `#all/`; the
 * message id works there too when no thread id was reported.
 */
export function gmailLink(threadId: string | null, messageId: string): string | null {
  const id = threadId || messageId;
  if (!/^[0-9a-f]{8,}$/i.test(id)) return null;
  return `https://mail.google.com/mail/u/0/#all/${id}`;
}

/** Unhandled updates per kind — what the dashboard turns into alerts. */
export type MailUpdateCounts = Record<MailUpdateKind, number>;

export function emptyMailUpdateCounts(): MailUpdateCounts {
  return { bol: 0, delay: 0, payment_request: 0 };
}
