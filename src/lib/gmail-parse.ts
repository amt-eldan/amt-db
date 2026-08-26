/**
 * Turning a Gmail API message into the two things the bill-of-lading sync needs:
 * plain text it can search, and the few headers a human needs to recognise the
 * mail it came from.
 *
 * Kept separate from the network client and free of any I/O, because this is the
 * part that is genuinely easy to get wrong — a Gmail payload is a recursive MIME
 * tree, base64url with the padding stripped, and the interesting body is
 * sometimes three levels down inside multipart/alternative nested in
 * multipart/mixed. All of that is checkable against a captured message, and none
 * of it needs a mailbox.
 */

/** The shape of a `users.messages.get?format=full` response, as far as we read it. */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

/** What the sync works with: one mail, flattened. */
export interface ParsedEmail {
  id: string;
  threadId: string | null;
  subject: string;
  from: string;
  /** Date the mail was received, ISO yyyy-mm-dd, or null when Gmail sent none. */
  date: string | null;
  /** Subject and body together — what the extractor searches. */
  text: string;
}

/**
 * base64url → text. Gmail uses the URL alphabet and strips the padding, so
 * neither `atob` nor a plain Buffer round-trip is enough on its own.
 *
 * Returns "" for anything undecodable rather than throwing: one malformed part
 * in a mail must not lose the rest of the mail.
 */
export function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** A header by name, case-insensitively — Gmail's casing is not guaranteed. */
export function headerValue(part: GmailPart | undefined, name: string): string {
  const wanted = name.toLowerCase();
  const found = part?.headers?.find((h) => (h.name ?? "").toLowerCase() === wanted);
  return (found?.value ?? "").trim();
}

/**
 * Markup → readable text, enough for identifier matching.
 *
 * Carriers and suppliers send HTML-only mail routinely, and a tracking number in
 * a table cell is invisible unless the tags come out. `<br>` and block ends
 * become newlines first so a number and its label do not weld into one token —
 * the extractor's label proximity check reads across a fixed window of
 * characters, and losing the boundary would silently widen it.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every part in the tree, depth first. */
function walk(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!part) return out;
  out.push(part);
  for (const child of part.parts ?? []) walk(child, out);
  return out;
}

/**
 * The readable body of a message.
 *
 * text/plain wins where a mail carries both — it is what the sender wrote,
 * without the markup noise. HTML is used when it is all there is. Attachments
 * are skipped: a part with a filename is a file, and a PDF's bytes read as
 * base64 gibberish that would only add false candidates for the extractor.
 */
export function extractBody(payload: GmailPart | undefined): string {
  const parts = walk(payload);
  const usable = parts.filter((p) => !p.filename && p.body?.data);

  const plain = usable
    .filter((p) => (p.mimeType ?? "").startsWith("text/plain"))
    .map((p) => decodeBase64Url(p.body!.data))
    .join("\n")
    .trim();
  if (plain) return plain;

  const html = usable
    .filter((p) => (p.mimeType ?? "").startsWith("text/html"))
    .map((p) => decodeBase64Url(p.body!.data))
    .join("\n");
  return html ? htmlToText(html) : "";
}

/** Gmail's internalDate (ms since epoch, as a string) → ISO yyyy-mm-dd. */
export function messageDate(message: GmailMessage): string | null {
  const ms = Number(message.internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * One Gmail message, flattened into what the sync searches.
 *
 * The subject leads the text because that is often where the tracking number is
 * ("Shipment 1Z... has been delivered"), and the extractor's label proximity
 * check needs the subject's own label next to it rather than the body's.
 */
export function parseMessage(message: GmailMessage): ParsedEmail {
  const subject = headerValue(message.payload, "Subject");
  const body = extractBody(message.payload);
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? null,
    subject,
    from: headerValue(message.payload, "From"),
    date: messageDate(message),
    text: [subject, body].filter(Boolean).join("\n"),
  };
}
