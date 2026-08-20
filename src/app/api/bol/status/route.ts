import { NextRequest, NextResponse } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import { writeShipmentUpdates } from "@/lib/shipment-write";
import { shipmentUpdateInput } from "@/lib/validation";

/**
 * Where a shipment has got to, for a line that already holds a bill of lading.
 * POST /api/bol/status  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Body: one update or an array of them (see `shipmentUpdateInput`).
 *
 * The write and every guard around it live in `writeShipmentUpdates`, shared with
 * the `shipment_update` MCP tool so both doors in behave identically. This handler
 * only authenticates, validates and shapes the HTTP response.
 *
 * Separate from /api/bol/matches because the two have opposite guards: a tracking
 * number must never be overwritten, while a status is expected to be replaced on
 * every run.
 */
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
  const parsed = items.map((item) => shipmentUpdateInput.safeParse(item));
  const firstError = parsed.find((p) => !p.success);
  if (firstError && !firstError.success) {
    return NextResponse.json(
      { error: "validation failed", details: firstError.error.issues },
      { status: 422 },
    );
  }

  const summary = await writeShipmentUpdates(parsed.map((p) => p.data!));
  return NextResponse.json(summary);
}
