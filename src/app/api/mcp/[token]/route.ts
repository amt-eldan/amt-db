import { NextRequest, NextResponse } from "next/server";
import { isValidAgentToken } from "@/lib/agent-token";
import { handleMcpMessage } from "@/lib/mcp";

export const runtime = "nodejs"; // node:crypto, and the Neon driver behind the tools
export const dynamic = "force-dynamic";

/**
 * MCP endpoint for a claude.ai custom connector — the door the scheduled
 * bill-of-lading task comes through.
 *
 * Why this exists next to a working REST API: a scheduled task on claude.ai runs
 * in a sandbox with no outbound network and no secret store, so it cannot call
 * /api/bol/* at all. A custom connector is called by Anthropic's infrastructure
 * instead of from that sandbox, which clears both walls — but it only speaks MCP.
 *
 * The token is in the path because a connector stores one URL and no headers.
 * A wrong token gets 404, not 401: to anyone guessing, this route does not exist.
 * The URL is never logged here — it is the credential.
 *
 * Transport: Streamable HTTP, stateless. Every POST is a complete exchange, so
 * there is no session to resume and no server-initiated stream to hold open;
 * GET and DELETE therefore answer 405, as the spec prescribes for a server that
 * offers neither.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/mcp/[token]">) {
  const { token } = await ctx.params;
  if (!isValidAgentToken(token)) return notFound();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // Batches were dropped in protocol 2025-06-18 but older clients may still send
  // one, and answering both shapes is a few lines.
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleMcpMessage))).filter((r) => r !== null);
    // Nothing but notifications: acknowledged, nothing to say back.
    if (responses.length === 0) return new NextResponse(null, { status: 202 });
    return NextResponse.json(responses);
  }

  const response = await handleMcpMessage(body);
  if (response === null) return new NextResponse(null, { status: 202 });
  return NextResponse.json(response);
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/mcp/[token]">) {
  const { token } = await ctx.params;
  if (!isValidAgentToken(token)) return notFound();
  return methodNotAllowed();
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/mcp/[token]">) {
  const { token } = await ctx.params;
  if (!isValidAgentToken(token)) return notFound();
  return methodNotAllowed();
}

/** Same body a missing route would give: nothing to learn from guessing. */
function notFound() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

function methodNotAllowed() {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed" } },
    { status: 405, headers: { Allow: "POST" } },
  );
}
