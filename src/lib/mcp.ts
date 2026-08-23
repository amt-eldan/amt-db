import { z } from "zod";
import { getBolWorklist, getShipmentWorklist } from "@/db/queries";
import { writeBolMatches } from "./bol-write";
import { writeShipmentUpdates } from "./shipment-write";
import { bolMatchInput, shipmentUpdateInput } from "./validation";

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
const INSTRUCTIONS = `שרת שטרי המטען של AMT. שתי משימות בכל הרצה, בסדר הזה:

**א. איפה נמצאים המשלוחים שכבר יש להם שטר מטען**
1. קרא ל-shipment_worklist. כל שורה מגיעה עם bol, carrier, ומתי נבדקה לאחרונה (הישנות ראשונות).
2. לכל שטר מטען — היכנס לאתר המעקב של הספקית (FedEx / DHL / UPS) וקרא את הסטטוס האמיתי.
3. דווח ב-shipment_update: status, ו-deliveredAt **רק** כשהספקית אומרת שהמשלוח נמסר ונוקבת בתאריך. sourceUrl = הדף שקראת.

**חשוב מאוד: שטר מטען הוא לא מסירה.** שורה נצבעת ירוק רק כשמגיע status=delivered מהספקית. אל תדווח delivered על "out for delivery" או "arrived at facility".

**ב. שטרי מטען חדשים בתיבת המייל**
4. קרא ל-bol_worklist — השורות הפתוחות שחסר בהן שטר מטען, כל אחת עם מפתחות החיפוש שלה.
5. חפש במייל לפי סדר העדיפות: poNumber (הזמנת הרכש שלנו לספק — האות החזק ביותר) ← pn (מק"ט היצרן) ← orderNumber (משני, הספק לרוב לא מכיר אותו) ← supplier (אישוש בלבד).
6. דווח ב-bol_submit_matches עם ה-lineId מה-worklist. מייל אחד שמכסה כמה פריטים → כמה התאמות, אחת לכל lineId, עם אותו sourceEmailId.

**מחיר קנייה:** הזמנות הרכש נקובות בדולרים. אם המייל או ההזמנה נוקבים במחיר קנייה ליחידה — שלח אותו כ-buyPriceUsd, **בדולרים ובלי להמיר**. השרת מביא את השער היציג של בנק ישראל לתאריך המסירה וממיר בעצמו, ושומר את השער שבו המיר. אל תחשב שערים ואל תמיר סכומים.

אל תנחש: התאמה שאינך בטוח בה — החזר אותה עם confidence נמוך (מתחת ל-0.5) או אל תחזיר אותה בכלל. השרת מדלג על התאמה עמומה ומדווח עליה, ולעולם לא דורס שטר מטען שכבר קיים ולא דורס מה שאדם הזין ביד.`;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Every schema the agent sees is generated from the very Zod schema that
 * validates the call, so the advertised contract cannot drift from the enforced
 * one.
 */
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const matchJsonSchema = () => jsonSchemaOf(bolMatchInput);
const shipmentUpdateJsonSchema = () => jsonSchemaOf(shipmentUpdateInput);

/** One item or an array of them, the shape both write tools accept. */
function oneOrMany(itemSchema: Record<string, unknown>, description: string) {
  return {
    description,
    anyOf: [{ type: "array", minItems: 1, items: itemSchema }, itemSchema],
  };
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
        matches: oneOrMany(matchJsonSchema(), "One match, or an array of them."),
      },
      required: ["matches"],
      additionalProperties: false,
    },
  },
  {
    name: "shipment_worklist",
    title: "משלוחים שצריך לבדוק איפה הם",
    description:
      "Returns the open lines that DO have a bill of lading and whose shipment has not been confirmed delivered yet — the shipments to go and check on. " +
      "Least-recently-checked first (a shipment never checked comes before one checked this morning), so a partial run always spends itself on the most stale rows. " +
      "Each row carries `bol` and `carrier` to look up, and `shipmentStatusAt` so you can see when it was last read. " +
      "This is the counterpart of bol_worklist: that one asks which lines still need a tracking number, this one asks where the numbers we hold have got to. " +
      "Lines already delivered, closed, or marked arrived by hand are not returned.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "How many rows to return. Default 200.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shipment_update",
    title: "עדכון סטטוס משלוח",
    description:
      "Reports where a shipment has got to, for a line that already holds a bill of lading. Send one object or an array under `updates`; `lineId` is required and comes from shipment_worklist. " +
      "`status` is the normalized state — 'in_transit' | 'delivered' | 'exception' — and is preferred over prose; send the carrier's own wording in `statusText` too and it is kept for a human to read. " +
      "**'delivered' is the only thing that turns a row green, so send it only when the carrier says the goods were handed over** — not for 'out for delivery', not for 'arrived at facility'. " +
      "Send `deliveredAt` (yyyy-mm-dd) with the date the CARRIER states, never today's date: it is what dates the exchange rate, so a wrong date is a wrong profit figure. " +
      "`buyPriceUsd` is the unit purchase price in dollars, unconverted — the server fetches the Bank of Israel representative rate for the delivery date, converts, and records the rate it used. Do not convert currency yourself. " +
      "Include `sourceUrl` (the tracking page you read) so the write is reviewable. " +
      "The write is guarded: it never touches `bol`, never overwrites a delivery note a human wrote, never overwrites a buy price a human entered, and writes nothing at all when nothing changed — so running it twice a day is safe. " +
      "Returns { ok, written, unchanged, skipped, results }, where each written result lists which fields actually moved.",
    inputSchema: {
      type: "object",
      properties: {
        updates: oneOrMany(shipmentUpdateJsonSchema(), "One update, or an array of them."),
      },
      required: ["updates"],
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
    // One match or many, exactly like POST /api/bol/matches accepts.
    const batch = parseBatch(args, "matches", bolMatchInput, "התאמה");
    if ("error" in batch) return ok(id, toolError(batch.error));
    return ok(id, toolText(await writeBolMatches(batch.items)));
  }

  if (name === "shipment_worklist") {
    const limit = (args as { limit?: unknown } | undefined)?.limit;
    const lines = await getShipmentWorklist(
      typeof limit === "number" && limit > 0 ? Math.min(500, Math.floor(limit)) : undefined,
    );
    return ok(id, toolText({ ok: true, count: lines.length, lines }));
  }

  if (name === "shipment_update") {
    const batch = parseBatch(args, "updates", shipmentUpdateInput, "עדכון");
    if ("error" in batch) return ok(id, toolError(batch.error));
    return ok(id, toolText(await writeShipmentUpdates(batch.items)));
  }

  return fail(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${String(name)}`);
}

/**
 * Both write tools take one object or an array of them under a named field, and
 * both must reject the whole batch on the first bad item rather than writing
 * half of it — a partial write with no error is the kind of thing nobody notices.
 * The Hebrew message names which item failed and why, because that message is
 * what ends up in the daily summary.
 */
function parseBatch<T extends z.ZodType>(
  args: unknown,
  field: string,
  schema: T,
  noun: string,
): { items: z.infer<T>[] } | { error: string } {
  const raw = (args as Record<string, unknown> | undefined)?.[field];
  if (raw === undefined || raw === null) return { error: `חסר השדה "${field}".` };

  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return { error: `"${field}" ריק — אין מה לכתוב.` };

  const parsed = items.map((item) => schema.safeParse(item));
  const invalid = parsed.findIndex((p) => !p.success);
  if (invalid !== -1) {
    const result = parsed[invalid];
    const issues = result.success
      ? ""
      : result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { error: `${noun} #${invalid + 1} לא עברה ולידציה — ${issues}` };
  }

  return { items: parsed.map((p) => p.data!) };
}
