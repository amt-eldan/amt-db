import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orderLines } from "@/db/schema";
import { evaluateBolMatch } from "@/lib/bol-match";
import { applyLineFields } from "@/lib/line-fields";
import { bolMatchInput } from "@/lib/validation";

type MatchResult = {
  lineId: number;
  status: "written" | "skipped";
  reason?: string;
};

/**
 * Bill-of-lading matches found by the external tracking agent.
 * POST /api/bol/matches  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Body: one match or an array of them (see `bolMatchInput`).
 *
 * Writes each confident match straight onto order_lines.bol. Guards, because
 * this write marks a shipment as arrived:
 *  - never overwrites a BOL that is already set (human or earlier run),
 *  - only touches open lines,
 *  - skips low-confidence matches rather than guessing,
 *  - records the source email + quote in audit_log for every write.
 */
export async function POST(request: NextRequest) {
  const token = process.env.BOL_AGENT_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  if (!token || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  const parsed = items.map((item) => bolMatchInput.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  const results: MatchResult[] = [];
  for (const p of parsed) {
    const match = p.data!;

    const [existing] = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.id, match.lineId));

    const verdict = evaluateBolMatch(existing, match);
    if (!verdict.write) {
      results.push({ lineId: match.lineId, status: "skipped", reason: verdict.reason });
      continue;
    }

    await applyLineFields(
      existing!, // evaluateBolMatch only returns write:true for a line it found
      {
        bol: match.bol,
        carrier: match.carrier,
        bolSource: "auto",
        bolConfidence: match.confidence,
      },
      {
        agent: "bol-tracking",
        emailId: match.sourceEmailId,
        quote: match.sourceQuote,
        carrierStatus: match.statusText,
        confidence: match.confidence,
      },
    );
    results.push({ lineId: match.lineId, status: "written" });
  }

  const written = results.filter((r) => r.status === "written").length;
  if (written > 0) {
    revalidatePath("/");
    revalidatePath("/monthly");
    revalidatePath("/bol");
  }

  return NextResponse.json({
    ok: true,
    written,
    skipped: results.length - written,
    results,
  });
}
