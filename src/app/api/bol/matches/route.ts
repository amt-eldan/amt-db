import { NextRequest, NextResponse } from "next/server";
import { writeBolMatches } from "@/lib/bol-write";
import { bolMatchInput } from "@/lib/validation";

/**
 * Bill-of-lading matches found by the external tracking agent.
 * POST /api/bol/matches  with  Authorization: Bearer <BOL_AGENT_TOKEN>
 * Body: one match or an array of them (see `bolMatchInput`).
 *
 * The write itself — and every guard around it — lives in `writeBolMatches`,
 * shared with the `bol_submit_matches` MCP tool so both doors in behave
 * identically. This handler only authenticates, validates and shapes the HTTP
 * response.
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

  const summary = await writeBolMatches(parsed.map((p) => p.data!));
  return NextResponse.json(summary);
}
