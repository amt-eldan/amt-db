import { NextRequest, NextResponse } from "next/server";
import { getBolWorklist } from "@/db/queries";

/**
 * Worklist for the external shipment-tracking agent.
 * GET /api/bol/worklist  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 *
 * Returns the open lines still missing a bill of lading, each with the keys to
 * search the mailbox by (poNumber / pn / orderNumber / supplier). The agent
 * carries `lineId` back to POST /api/bol/matches, which is what binds a found
 * tracking number to one specific line.
 */
export async function GET(request: NextRequest) {
  const token = process.env.BOL_AGENT_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  if (!token || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lines = await getBolWorklist();
  return NextResponse.json({ ok: true, count: lines.length, lines });
}
