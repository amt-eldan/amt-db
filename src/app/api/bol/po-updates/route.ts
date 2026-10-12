import { NextRequest, NextResponse } from "next/server";
import { getPoWatchlist } from "@/db/queries";
import { requireBearer } from "@/lib/api-auth";
import { recordMailUpdates } from "@/lib/mail-updates-write";
import { mailUpdateInput } from "@/lib/validation";

/**
 * Supplier mail about purchase orders — the REST twin of the `po_watchlist` and
 * `mail_updates_submit` MCP tools, for a caller that can hold a token.
 *
 *   GET  /api/bol/po-updates   open purchase orders to watch the mailbox for
 *   POST /api/bol/po-updates   one update or an array (see `mailUpdateInput`)
 *
 * Authorization: Bearer <BOL_AGENT_TOKEN>. Under /api/bol so it shares that
 * token and the proxy's exemption from the session cookie. Everything else lives
 * in `recordMailUpdates`, shared with the MCP tool.
 */
export async function GET(request: NextRequest) {
  const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
  if (denied) return denied;

  const orders = await getPoWatchlist();
  return NextResponse.json({ ok: true, count: orders.length, orders });
}

export async function POST(request: NextRequest) {
  const denied = requireBearer(request, process.env.BOL_AGENT_TOKEN);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const items = Array.isArray(body) ? body : [body];
  const parsed = items.map((item) => mailUpdateInput.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  return NextResponse.json(await recordMailUpdates(parsed.map((p) => p.data!), "agent"));
}
