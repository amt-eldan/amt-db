import { z } from "zod";
import { getBolWorklist } from "@/db/queries";
import { writeBolMatches } from "./bol-write";
import { bolMatchInput } from "./validation";

/**
 * A hand-rolled MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless).
 *
 * `@modelcontextprotocol/sdk` was the obvious candidate and was rejected on
 * purpose: its `StreamableHTTPServerTransport` is written against Node's
 * `IncomingMessage`/`ServerResponse`, while a Next 16 route handler is handed a
 * Web `Request` and must return a Web `Response`. Bridging the two needs an
 * adapter layer and a session store this server has no use for — it is two tools,
 * no subscriptions, no server-initiated messages, and every call is independent.
 * What the SDK would have contributed is the dispatch below, which is short
 * enough to read in one sitting and has no upgrade path to get wrong.
 */

/** Newest first. An `initialize` asking for one of these gets it echoed back. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INFO = {
  name: "amt-bol",
  title: "AMT — מעקב שטרי מטען",
  version: "1.0.0",
};

/**
 * Shown to the agent right after connecting. This is where the workflow lives,
 * so a scheduled task does not have to be told it again in every prompt.
 */
const INSTRUCTIONS = `שרת שטרי המטען של AMT. סדר העבודה:

1. קרא ל-bol_worklist כדי לקבל את השורות הפתוחות שחסר בהן שטר מטען. כל שורה מגיעה עם מפתחות החיפוש שלה.
2. חפש בתיבת המייל לפי המפתחות, לפי סדר העדיפות: poNumber (הזמנת הרכש שלנו לספק — האות החזק ביותר) ← pn (מק"ט היצרן) ← orderNumber (משני, הספק לרוב לא מכיר אותו) ← supplier (אישוש בלבד).
3. החזר את מה שמצאת ב-bol_submit_matches, עם ה-lineId שהתקבל ב-worklist. מייל אחד שמכסה כמה פריטים → כמה התאמות, אחת לכל lineId, עם אותו sourceEmailId.

אל תנחש: התאמה שאינך בטוח בה — החזר אותה עם confidence נמוך (מתחת ל-0.5) או אל תחזיר אותה בכלל. השרת מדלג על התאמה עמומה ומדווח עליה, ולעולם לא דורס שטר מטען שכבר קיים.`;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The match schema the agent sees is generated from `bolMatchInput` itself —
 * the same Zod schema that validates the call — so the advertised contract
 * cannot drift from the enforced one.
 */
function matchJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(bolMatchInput, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export const TOOLS: McpTool[] = [
  {
    name: "bol_worklist",
    title: "רשימת שורות שחסר בהן שטר מטען",
    description:
      "Returns the open order lines that still have no bill of lading, most urgent first, each with the keys to search the mailbox by. " +
      "Search-key priority: poNumber (our purchase order to the supplier — the strongest signal, it appears on their shipping confirmations) → " +
      "pn (manufacturer part number; repeats across orders, so it does not identify a line on its own) → " +
      "orderNumber (secondary — the supplier usually does not know it) → supplier (corroboration only: sender domain or name). " +
      "Carry each line's `lineId` back to bol_submit_matches — that is what binds a tracking number to one specific line. " +
      "Lines already filled, closed, or marked arrived by hand are not returned, so re-running is safe and cannot duplicate work.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bol_submit_matches",
    title: "כתיבת שטרי מטען שנמצאו",
    description:
      "Writes bills of lading found in the mailbox onto their lines. Send one object or an array under `matches`; " +
      "`lineId` should be one received from bol_worklist; when the email belongs to no line on the worklist, leave it out and send the keys the email quotes " +
      "(`poNumber` / `pn` / `orderNumber`) instead and the server resolves the line itself. Include `sourceEmailId` and `sourceQuote` — every write is audited with them, " +
      "which is what makes an automatic write reviewable afterwards. " +
      "The write is guarded and reports what it refused: keys matching more than one open line are reported rather than guessed, an existing bill of lading is never overwritten (a different value comes back as needing manual review), " +
      "closed lines are skipped, and a match with confidence below 0.5 is skipped rather than guessed. A match without `confidence` is taken as asserted by the agent. " +
      "Returns { ok, written, skipped, results } — report the skips in the daily summary so a human can finish them.",
    inputSchema: {
      type: "object",
      properties: {
        matches: {
          description: "One match, or an array of them.",
          anyOf: [
            { type: "array", minItems: 1, items: matchJsonSchema() },
            matchJsonSchema(),
          ],
        },
      },
      required: ["matches"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool's answer. Text, because that is what every MCP client can render. */
function toolText(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A tool that failed on its own terms — the model sees this and can correct it. */
function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * Handles one JSON-RPC message. Returns the response, or `null` for a
 * notification (which by the spec gets no response body at all).
 */
export async function handleMcpMessage(message: unknown): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return fail(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
  }

  const { jsonrpc, method, id, params } = message as {
    jsonrpc?: unknown;
    method?: unknown;
    id?: JsonRpcId;
    params?: unknown;
  };

  const isNotification = id === undefined || id === null;

  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return isNotification ? null : fail(id!, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
  }

  // Notifications are one-way: acknowledge by saying nothing.
  if (isNotification) return null;

  try {
    return await dispatch(method, id!, params);
  } catch (err) {
    // A tool that throws (the database is down, most likely) is answered in the
    // protocol the client speaks, not as a bare 500 it cannot parse. The message
    // stays generic on purpose — a driver error can carry the connection string.
    console.error(`MCP ${method} failed:`, err);
    return fail(id!, JSON_RPC_ERRORS.internal, "Internal error");
  }
}

async function dispatch(
  method: string,
  id: JsonRpcId,
  params: unknown,
): Promise<JsonRpcResponse> {
  switch (method) {
    case "initialize": {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOLS });

    case "tools/call":
      return callTool(id, params);

    default:
      return fail(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

async function callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };

  if (name === "bol_worklist") {
    const lines = await getBolWorklist();
    return ok(id, toolText({ ok: true, count: lines.length, lines }));
  }

  if (name === "bol_submit_matches") {
    const raw = (args as { matches?: unknown } | undefined)?.matches;
    if (raw === undefined || raw === null) {
      return ok(id, toolError('חסר השדה "matches".'));
    }

    // One match or many, exactly like POST /api/bol/matches accepts.
    const items = Array.isArray(raw) ? raw : [raw];
    if (items.length === 0) {
      return ok(id, toolError('"matches" ריק — אין מה לכתוב.'));
    }

    const parsed = items.map((item) => bolMatchInput.safeParse(item));
    const invalid = parsed.findIndex((p) => !p.success);
    if (invalid !== -1) {
      const result = parsed[invalid];
      const issues = result.success
        ? ""
        : result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return ok(id, toolError(`התאמה #${invalid + 1} לא עברה ולידציה — ${issues}`));
    }

    const summary = await writeBolMatches(parsed.map((p) => p.data!));
    return ok(id, toolText(summary));
  }

  return fail(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${String(name)}`);
}
