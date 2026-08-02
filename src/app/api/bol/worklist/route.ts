import { NextRequest, NextResponse } from "next/server";
import { getBolWorklist } from "@/db/queries";
import { requireBearer } from "@/lib/api-auth";

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
  const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
  if (denied) return denied;

  const lines = await getBolWorklist();
  return NextResponse.json({ ok: true, count: lines.length, lines });
}
