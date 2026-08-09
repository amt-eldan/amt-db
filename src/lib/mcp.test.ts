import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTool } from "./mcp";

const { getBolWorklist, writeBolMatches } = vi.hoisted(() => ({
  getBolWorklist: vi.fn(),
  writeBolMatches: vi.fn(),
}));

vi.mock("@/db/queries", () => ({ getBolWorklist }));
vi.mock("./bol-write", () => ({ writeBolMatches }));

const { handleMcpMessage } = await import("./mcp");

const rpc = (method: string, params?: unknown, id: string | number = 1) =>
  handleMcpMessage({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

const call = (name: string, args?: unknown) => rpc("tools/call", { name, arguments: args });

/** The text a tool answered with, parsed back from its single content block. */
function toolPayload(response: Awaited<ReturnType<typeof handleMcpMessage>>) {
  const result = response!.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

beforeEach(() => {
  getBolWorklist.mockReset();
  writeBolMatches.mockReset();
});

describe("initialize", () => {
  it("echoes a protocol version it supports", async () => {
    const response = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect((response!.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
  });

  it("answers an unknown or missing version with its own", async () => {
    for (const params of [{ protocolVersion: "1999-01-01" }, {}]) {
      const response = await rpc("initialize", params);
      expect((response!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    }
  });

  it("advertises tools and hands the agent the workflow", async () => {
    const result = (await rpc("initialize", {}))!.result as {
      capabilities: { tools: unknown };
      instructions: string;
    };
    expect(result.capabilities.tools).toBeDefined();
    expect(result.instructions).toContain("bol_worklist");
    expect(result.instructions).toContain("poNumber");
  });
});

describe("protocol plumbing", () => {
  it("says nothing to a notification", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("rejects a malformed message", async () => {
    expect((await handleMcpMessage("not an object"))!.error?.code).toBe(-32600);
    expect((await handleMcpMessage({ id: 1, method: "initialize" }))!.error?.code).toBe(-32600);
  });

  it("reports an unknown method without dying", async () => {
    expect((await rpc("resources/list"))!.error?.code).toBe(-32601);
  });

  it("answers ping", async () => {
    expect((await rpc("ping"))!.result).toEqual({});
  });

  it("keeps the id it was given", async () => {
    expect((await rpc("ping", undefined, "abc-7"))!.id).toBe("abc-7");
  });
});

describe("tools/list", () => {
  it("lists both tools with the schema generated from bolMatchInput", async () => {
    const { tools } = (await rpc("tools/list"))!.result as { tools: McpTool[] };
    expect(tools.map((t) => t.name)).toEqual(["bol_worklist", "bol_submit_matches"]);

    const matches = tools[1].inputSchema.properties as { matches: { anyOf: [{ items: object }] } };
    const item = matches.matches.anyOf[0].items as { required: string[] };
    expect(item.required).toEqual(["lineId", "bol"]);
  });

  it("documents the search-key priority the agent needs", async () => {
    const { tools } = (await rpc("tools/list"))!.result as { tools: McpTool[] };
    expect(tools[0].description).toContain("poNumber");
    expect(tools[0].description).toContain("supplier");
  });
});

describe("bol_worklist", () => {
  it("returns the worklist with its count", async () => {
    getBolWorklist.mockResolvedValue([{ lineId: 42, poNumber: "PO-8871" }]);
    const { text } = toolPayload(await call("bol_worklist"));
    expect(JSON.parse(text)).toEqual({
      ok: true,
      count: 1,
      lines: [{ lineId: 42, poNumber: "PO-8871" }],
    });
  });
});

describe("bol_submit_matches", () => {
  const summary = { ok: true, written: 1, skipped: 0, results: [{ lineId: 42, status: "written" }] };

  it("passes validated matches through and returns the write summary", async () => {
    writeBolMatches.mockResolvedValue(summary);
    const { text } = toolPayload(
      await call("bol_submit_matches", {
        matches: [{ lineId: 42, bol: "1Z999AA10123456784", confidence: 0.9 }],
      }),
    );

    expect(JSON.parse(text)).toEqual(summary);
    // Zod ran: confidence arrives at the writer as the clamped string it stores.
    expect(writeBolMatches).toHaveBeenCalledWith([
      expect.objectContaining({ lineId: 42, bol: "1Z999AA10123456784", confidence: "0.9" }),
    ]);
  });

  it("accepts a single match as well as an array", async () => {
    writeBolMatches.mockResolvedValue(summary);
    await call("bol_submit_matches", { matches: { lineId: 42, bol: "1Z999" } });
    expect(writeBolMatches).toHaveBeenCalledWith([expect.objectContaining({ lineId: 42 })]);
  });

  it("tells the agent what was wrong instead of writing a bad match", async () => {
    const bad = await call("bol_submit_matches", { matches: [{ lineId: 42, bol: "   " }] });
    const { text, isError } = toolPayload(bad);
    expect(isError).toBe(true);
    expect(text).toContain("bol");
    expect(writeBolMatches).not.toHaveBeenCalled();

    const missing = toolPayload(await call("bol_submit_matches", {}));
    expect(missing.isError).toBe(true);
    expect(writeBolMatches).not.toHaveBeenCalled();

    const empty = toolPayload(await call("bol_submit_matches", { matches: [] }));
    expect(empty.isError).toBe(true);
    expect(writeBolMatches).not.toHaveBeenCalled();
  });

  it("reports an unknown tool as a protocol error", async () => {
    const response = await call("bol_delete_everything", {});
    expect(response!.error?.code).toBe(-32602);
    expect(response!.error?.message).toContain("bol_delete_everything");
  });
});
