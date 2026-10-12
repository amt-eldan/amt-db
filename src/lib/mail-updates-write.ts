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
 *  - **Stored under the PO's key** (`poKey`: no separators, no "PO" prefix), so the
 *    same mail reported against "PO-4500012345" and "4500012345" is one row.
 *  - **A bill of lading goes through `writeBolMatches`**, with the PO number as
 *    the key — the same gate every other door uses, so it never overwrites a
 *    number already on a line. Without `pns` the waybill lands on the PO's open
 *    lines still waiting for one; with `pns` (a partial shipment) only on those
 *    items; and a waybill already on part of the PO is not spread to the rest
 *    (see resolveBolLines). It is written when the mail is first recorded, not on
 *    every re-report — a number a person removed must not come back by itself.
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
  const knownPos = new Set(lines.map((line) => poKey(line.poNumber)).filter(Boolean));

  const actor: Actor = source === "agent" ? "agent:mail-updates" : "user";
  const results: MailUpdateResult[] = [];
  const bolMatches = [];

  for (const item of items) {
    const base = { poNumber: item.poNumber, kind: item.kind, emailId: item.emailId };
    const poNumber = poKey(item.poNumber);
    if (!poNumber || !knownPos.has(poNumber)) {
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

    // Only when the mail is new: on a re-report the number was already offered to
    // the lines, and offering it again would undo a person who took it off one.
    if (row && item.kind === "bol" && item.bol) {
      for (const pn of item.pns.length > 0 ? item.pns : [null]) {
        const parsed = bolMatchInput.safeParse({
          bol: item.bol,
          poNumber,
          pn,
          carrier: item.carrier,
          confidence: item.confidence,
          sourceEmailId: item.emailId,
          sourceQuote: item.quote ?? item.subject,
        });
        if (parsed.success) bolMatches.push(parsed.data);
      }
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
