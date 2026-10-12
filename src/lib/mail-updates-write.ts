/**
 * Recording supplier mail about a purchase order — and, for a bill of lading,
 * putting the number on the order's open lines.
 *
 * Two doors call this: the `mail_updates_submit` MCP tool (the scheduled Claude
 * task, which is the reader that actually has the orders mailbox) and
 * POST /api/bol/po-updates. One function, so the two cannot drift.
 *
 * The rules:
 *  - **Only purchase orders we know.** A PO number no line carries is reported
 *    back, not stored: an update nobody can attach to an order is noise on the
 *    dashboard.
 *  - **Once per mail.** (mail, PO, kind) is unique and the insert is
 *    `on conflict do nothing`, so a mail read on every run is recorded once.
 *  - **A bill of lading goes through `writeBolMatches`**, with the PO number as
 *    the key — the same gate every other door uses, so it never overwrites a
 *    number already on a line, and one PO's waybill lands on all of its open
 *    lines that are still waiting for one (see resolveBolLines).
 */

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { getPoLineKeys } from "@/db/queries";
import { mailUpdates } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { writeBolMatches, type BolWriteSummary } from "./bol-write";
import { poKey } from "./mail-updates";
import { bolMatchInput, type MailUpdateInput } from "./validation";

export interface MailUpdateResult {
  poNumber: string;
  kind: string;
  emailId: string;
  status: "recorded" | "duplicate" | "skipped";
  id?: number;
  reason?: string;
}

export interface MailUpdateSummary {
  ok: true;
  recorded: number;
  duplicates: number;
  skipped: number;
  results: MailUpdateResult[];
  /** What happened to the bills of lading the updates carried, line by line. */
  bol: BolWriteSummary | null;
}

export async function recordMailUpdates(
  items: MailUpdateInput[],
  source: "agent" | "sync" = "agent",
): Promise<MailUpdateSummary> {
  const lines = await getPoLineKeys();
  const poByKey = new Map<string, string>();
  for (const line of lines) {
    const k = poKey(line.poNumber);
    // Prefer the spelling of an open line, so the stored PO reads like the screen.
    if (k && (!poByKey.has(k) || line.isOpen)) poByKey.set(k, line.poNumber);
  }

  const actor: Actor = source === "agent" ? "agent:mail-updates" : "user";
  const results: MailUpdateResult[] = [];
  const bolMatches = [];

  for (const item of items) {
    const base = { poNumber: item.poNumber, kind: item.kind, emailId: item.emailId };
    const poNumber = poByKey.get(poKey(item.poNumber));
    if (!poNumber) {
      results.push({
        ...base,
        status: "skipped",
        reason: "unknown PO — no order line carries this purchase-order number",
      });
      continue;
    }

    const [row] = await db
      .insert(mailUpdates)
      .values({
        messageId: item.emailId,
        threadId: item.threadId,
        poNumber,
        kind: item.kind,
        subject: item.subject,
        sender: item.from,
        receivedAt: item.receivedAt,
        quote: item.quote,
        bol: item.bol,
        newDate: item.newDate,
        source,
      })
      .onConflictDoNothing()
      .returning({ id: mailUpdates.id });

    if (row) {
      results.push({ ...base, poNumber, status: "recorded", id: row.id });
      await audit(
        "mail_update",
        row.id,
        "create",
        { poNumber, kind: item.kind, emailId: item.emailId, subject: item.subject },
        actor,
      );
    } else {
      results.push({ ...base, poNumber, status: "duplicate" });
    }

    // The number goes onto the lines whether or not this mail was seen before:
    // writeBolMatches is idempotent, and a run that recorded the mail but died
    // before writing the number must not leave it off the lines for good.
    if (item.kind === "bol" && item.bol) {
      const parsed = bolMatchInput.safeParse({
        bol: item.bol,
        poNumber,
        carrier: item.carrier,
        confidence: item.confidence,
        sourceEmailId: item.emailId,
        sourceQuote: item.quote ?? item.subject,
      });
      if (parsed.success) bolMatches.push(parsed.data);
    }
  }

  const bol = bolMatches.length > 0 ? await writeBolMatches(bolMatches) : null;

  const recorded = results.filter((r) => r.status === "recorded").length;
  if (recorded > 0) {
    revalidatePath("/");
    revalidatePath("/updates");
  }

  return {
    ok: true,
    recorded,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
    bol,
  };
}
