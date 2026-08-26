/**
 * The "סנכרון שטרי מטען" button: for every open line that has no bill of lading,
 * look in the mailbox for one, and write what is found.
 *
 * This is the same job the scheduled Claude task does in its Gmail phase, run on
 * demand from the open-orders screen. It exists because the scheduled run is
 * every four hours and a person looking at the screen wants the answer now.
 *
 * It is deliberately the *narrower* of the two. Claude reads a mail and
 * understands it; this reads a mail and matches identifiers, which is weaker and
 * fails differently. So the rule here is that a weaker reader must be a more
 * cautious one: it writes only what a label vouched for (see ./tracking-extract),
 * it reports everything else instead of guessing, and it goes through
 * `writeBolMatches` — the same gate, the same never-overwrite guard, the same
 * audit trail as the agent path. The two are not expected to find identical sets,
 * and neither can clobber the other's work.
 *
 * One thing it pointedly does **not** do: set a shipment status. A supplier mail
 * saying "delivered" is not the carrier saying so, and green on a row means the
 * goods arrived. Filling `bol` here colours the row "במשלוח" and the carrier-page
 * path (`writeShipmentUpdates`) is what may later turn it green.
 */

import { getBolWorklist, type BolWorklistRow } from "@/db/queries";
import { writeBolMatches, type BolMatchResult } from "./bol-write";
import {
  fetchMessage,
  gmailConfig,
  GmailError,
  searchMessageIds,
  type GmailConfig,
} from "./gmail";
import { parseMessage, type ParsedEmail } from "./gmail-parse";
import {
  bestTrackingCandidate,
  findTrackingCandidates,
  type TrackingCandidate,
} from "./tracking-extract";
import { bolMatchInput } from "./validation";

/**
 * How long the run may take. A server action has to answer while someone is
 * watching a spinner, and Vercel's own ceiling is 60s — so the budget is spent
 * deliberately and the run reports being cut short rather than dying at the
 * platform limit with nothing written.
 */
const DEFAULT_BUDGET_MS = 40_000;

/**
 * How far back to read. A tracking number that arrived four months ago and was
 * never filed is a manual-review problem, not something to find by scanning ever
 * more mail on every click.
 */
const DEFAULT_LOOKBACK_DAYS = 120;

/** Ceiling on mails read in one run, so a busy mailbox cannot stretch the budget. */
const DEFAULT_MAX_MESSAGES = 250;

/** Mails fetched at once. Gmail's per-user rate limit is generous; latency is the cost. */
const FETCH_CONCURRENCY = 8;

/**
 * The label words the broad search looks for.
 *
 * The same vocabulary the extractor requires before it will vouch for a number,
 * on purpose: a mail this query cannot find is a mail the extractor would have
 * refused to write from anyway, so the narrow query costs no writes.
 */
const MAIL_KEYWORDS = [
  "tracking",
  "AWB",
  "waybill",
  "shipment",
  "shipped",
  '"שטר מטען"',
  '"מספר מעקב"',
];

export interface BolSyncOptions {
  budgetMs?: number;
  lookbackDays?: number;
  maxMessages?: number;
  /** Injected in tests. Defaults to the real Gmail calls. */
  gmail?: GmailPort;
  now?: () => number;
}

/** The two mailbox operations this needs, named so a test can stand in for them. */
export interface GmailPort {
  search(query: string, limit: number): Promise<string[]>;
  fetch(id: string): Promise<ParsedEmail>;
}

/** A number that was found but not written, and why it is worth a human's look. */
export interface BolSyncReviewItem {
  lineId: number;
  orderNumber: string;
  customer: string;
  poNumber: string | null;
  pn: string | null;
  bol: string;
  carrier: string | null;
  confidence: number;
  emailId: string;
  reason: string;
}

export interface BolSyncSummary {
  ok: true;
  /** Open lines with no bill of lading when the run started. */
  worklist: number;
  /** Lines a mail was actually found and read for. */
  matchedLines: number;
  /** Mails read from the mailbox. */
  mailsRead: number;
  written: number;
  review: BolSyncReviewItem[];
  results: BolMatchResult[];
  /** True when the time budget ran out before every line had been looked at. */
  truncated: boolean;
}

export type BolSyncOutcome = BolSyncSummary | { ok: false; error: string };

function livePort(config: GmailConfig): GmailPort {
  return {
    search: (query, limit) => searchMessageIds(config, query, limit),
    fetch: async (id) => parseMessage(await fetchMessage(config, id)),
  };
}

/**
 * A regex that finds an identifier in mail text, tolerating how it was typed.
 *
 * A purchase order written "4501234567" on our side turns up as "450-123-4567"
 * or "PO 4501234567" in a supplier's mail, so the separators between characters
 * are optional. The word boundaries are the part that matters: a plain substring
 * search for order number "5975" would match inside "159755", and that is a
 * wrong line, which is worse than a missed one.
 */
function identifierPattern(value: string): RegExp | null {
  const chars = value.replace(/[^A-Za-z0-9]/g, "");
  // Three characters is not an identifier, it is a coincidence waiting to happen.
  if (chars.length < 4) return null;
  const body = chars.split("").join("[^A-Za-z0-9]{0,2}");
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, "i");
}

/** The keys a mail may name a line by, strongest first. */
function lineKeys(line: BolWorklistRow): { field: string; pattern: RegExp }[] {
  const keys: { field: string; pattern: RegExp }[] = [];
  for (const [field, value] of [
    ["poNumber", line.poNumber],
    ["pn", line.pn],
    ["sku", line.sku],
    ["orderNumber", line.orderNumber],
  ] as const) {
    const pattern = value ? identifierPattern(value) : null;
    if (pattern) keys.push({ field, pattern });
  }
  return keys;
}

/** Runs `worker` over `items` a few at a time, stopping when `stop()` says so. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  stop: () => boolean,
  worker: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length && !stop()) {
      const item = items[cursor++];
      const result = await worker(item);
      if (result !== null) out.push(result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** The best reading of a line's number across every mail that named the line. */
interface LineFinding {
  line: BolWorklistRow;
  candidate: TrackingCandidate;
  emailId: string;
  /** Two different numbers, equally vouched for — not a thing to resolve by picking. */
  ambiguous: boolean;
}

/**
 * Folds one mail into the findings: which of the still-unmatched lines it names,
 * and what tracking number it carries for each.
 */
function absorbMail(
  mail: ParsedEmail,
  lines: { line: BolWorklistRow; keys: { field: string; pattern: RegExp }[] }[],
  findings: Map<number, LineFinding>,
): void {
  for (const { line, keys } of lines) {
    if (!keys.some((k) => k.pattern.test(mail.text))) continue;

    // The line's own identifiers are excluded from the search for a tracking
    // number: a ten-digit purchase order is also a valid DHL number, and handing
    // it back would be the right line with the wrong value in the field.
    const candidate = bestTrackingCandidate(
      findTrackingCandidates(mail.text, {
        poNumber: line.poNumber,
        orderNumber: line.orderNumber,
        pn: line.pn,
        sku: line.sku,
      }),
    );
    if (!candidate) continue;

    const existing = findings.get(line.lineId);
    if (!existing) {
      findings.set(line.lineId, { line, candidate, emailId: mail.id, ambiguous: false });
      continue;
    }
    if (existing.candidate.bol === candidate.bol) {
      // The same number in two mails is confirmation, not a conflict.
      if (candidate.confidence > existing.candidate.confidence) {
        existing.candidate = candidate;
        existing.emailId = mail.id;
      }
      continue;
    }
    if (candidate.confidence > existing.candidate.confidence) {
      findings.set(line.lineId, { line, candidate, emailId: mail.id, ambiguous: false });
    } else if (candidate.confidence === existing.candidate.confidence) {
      existing.ambiguous = true;
    }
  }
}

/**
 * Reads the mailbox for the open lines that have no bill of lading, and writes
 * the numbers it can vouch for.
 *
 * Two passes, in this order for a reason. The broad one is a single search over
 * recent mail mentioning a tracking label, which covers most lines in one round
 * trip. The targeted one then searches by purchase-order number for the lines the
 * broad pass did not reach — that is how this was done by hand in the tracking
 * spreadsheet, and it catches the mails whose wording the keyword query misses.
 * Doing the cheap pass first means the expensive per-line searches are only spent
 * on what is actually still missing.
 *
 * Both share one time budget, and running out of it is a reported outcome, not a
 * failure: what was written stays written, `truncated` says the sweep was partial,
 * and pressing the button again picks up where it left off (the lines just filled
 * are no longer on the worklist).
 */
export async function syncBolFromMail(options: BolSyncOptions = {}): Promise<BolSyncOutcome> {
  const config = gmailConfig();
  if (!config && !options.gmail) {
    return {
      ok: false,
      error:
        "הגישה לתיבת המייל לא מוגדרת בשרת — נדרשים GMAIL_SERVICE_ACCOUNT_EMAIL, GMAIL_SERVICE_ACCOUNT_KEY ו-GMAIL_MAILBOX",
    };
  }
  const gmail = options.gmail ?? livePort(config!);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const outOfTime = () => now() >= deadline;

  const worklist = await getBolWorklist();
  if (worklist.length === 0) {
    return {
      ok: true,
      worklist: 0,
      matchedLines: 0,
      mailsRead: 0,
      written: 0,
      review: [],
      results: [],
      truncated: false,
    };
  }

  const withKeys = worklist
    .map((line) => ({ line, keys: lineKeys(line) }))
    .filter((entry) => entry.keys.length > 0);

  const findings = new Map<number, LineFinding>();
  // One mail is often relevant to several lines, and pass two searches for lines
  // pass one already read mail for. Parsed once, kept for the whole run.
  const seenMails = new Map<string, ParsedEmail>();

  const readMail = async (id: string): Promise<ParsedEmail | null> => {
    const cached = seenMails.get(id);
    if (cached) return cached;
    const mail = await gmail.fetch(id);
    seenMails.set(id, mail);
    return mail;
  };

  try {
    // --- pass one: everything recent that mentions a tracking label ---------
    const broadQuery = `newer_than:${lookbackDays}d (${MAIL_KEYWORDS.join(" OR ")})`;
    const broadIds = await gmail.search(broadQuery, maxMessages);
    const broadMails = await pooled(broadIds, FETCH_CONCURRENCY, outOfTime, readMail);
    for (const mail of broadMails) absorbMail(mail, withKeys, findings);

    // --- pass two: by purchase order, for the lines still unaccounted for ---
    const remaining = withKeys.filter(
      (entry) => !findings.has(entry.line.lineId) && entry.line.poNumber,
    );
    await pooled(remaining, FETCH_CONCURRENCY, outOfTime, async (entry) => {
      const query = `newer_than:${lookbackDays}d "${entry.line.poNumber}"`;
      const ids = await gmail.search(query, 10);
      for (const id of ids) {
        if (outOfTime()) break;
        const mail = await readMail(id);
        if (mail) absorbMail(mail, [entry], findings);
      }
      return null;
    });
  } catch (error) {
    if (error instanceof GmailError) return { ok: false, error: error.message };
    throw error;
  }

  // --- write, through the one gate that may touch `bol` --------------------
  const review: BolSyncReviewItem[] = [];
  const matches = [];
  for (const finding of findings.values()) {
    const { line, candidate, emailId } = finding;
    const base = {
      lineId: line.lineId,
      orderNumber: line.orderNumber,
      customer: line.customer,
      poNumber: line.poNumber,
      pn: line.pn,
      bol: candidate.bol,
      carrier: candidate.carrier,
      confidence: candidate.confidence,
      emailId,
    };

    if (finding.ambiguous) {
      review.push({ ...base, reason: "כמה מספרים שונים באותה מידת ודאות — נדרשת בדיקה ידנית" });
      continue;
    }

    // Everything else, writable or not, goes through the schema and then through
    // writeBolMatches. A confidence below the floor is refused *there*, by the
    // same rule that refuses the agent's — so there is one place that decides
    // what may be written to `bol`, not two.
    const parsed = bolMatchInput.safeParse({
      lineId: line.lineId,
      bol: candidate.bol,
      carrier: candidate.carrier,
      confidence: candidate.confidence,
      sourceEmailId: emailId,
      sourceQuote: candidate.quote,
      // No statusText on purpose: a mail is not the carrier, and this must not be
      // able to turn a row green. See the note at the top of this file.
    });
    if (!parsed.success) {
      review.push({ ...base, reason: "המספר שנמצא לא עבר אימות" });
      continue;
    }
    matches.push(parsed.data);
  }

  const write = matches.length > 0 ? await writeBolMatches(matches) : null;

  // A skip from the writer is a review item too — the reason it gives is the
  // useful part ("confidence below the floor", "bol already set to a different
  // value"), and it is what the person pressing the button needs to see.
  for (const result of write?.results ?? []) {
    if (result.status !== "skipped" || result.lineId === null) continue;
    const finding = findings.get(result.lineId);
    if (!finding) continue;
    review.push({
      lineId: finding.line.lineId,
      orderNumber: finding.line.orderNumber,
      customer: finding.line.customer,
      poNumber: finding.line.poNumber,
      pn: finding.line.pn,
      bol: finding.candidate.bol,
      carrier: finding.candidate.carrier,
      confidence: finding.candidate.confidence,
      emailId: finding.emailId,
      reason: result.reason ?? "דולג",
    });
  }

  return {
    ok: true,
    worklist: worklist.length,
    matchedLines: findings.size,
    mailsRead: seenMails.size,
    written: write?.written ?? 0,
    review,
    results: write?.results ?? [],
    truncated: outOfTime(),
  };
}
