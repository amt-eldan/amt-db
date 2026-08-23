import { NextRequest, NextResponse } from "next/server";
import { getShipmentWorklist } from "@/db/queries";
import { requireBearer } from "@/lib/api-auth";

/**
 * The shipments to go and check on.
 * GET /api/bol/shipments  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Optional `?limit=` (1..500, default 200).
 *
 * The counterpart of /api/bol/worklist: that one lists lines still missing a
 * tracking number, this one lists the numbers we already hold whose shipment has
 * not been confirmed delivered. Least-recently-checked first, so a partial run
 * spends itself on the most stale rows.
 *
 * Lives under /api/bol/ deliberately — src/proxy.ts exempts that prefix from the
 * session cookie, so a new sibling needs no change there.
 */
export async function GET(request: NextRequest) {
  const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
  if (denied) return denied;

  const raw = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.floor(raw)) : undefined;

  const lines = await getShipmentWorklist(limit);
  return NextResponse.json({ ok: true, count: lines.length, lines });
}
