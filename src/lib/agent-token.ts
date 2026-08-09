import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Token check for the agent-facing endpoints.
 *
 * The MCP endpoint carries its token in the path (`/api/mcp/<token>`) because a
 * claude.ai custom connector stores one URL and no headers. That makes the
 * comparison worth doing properly: a naive `!==` returns as soon as two strings
 * differ, which leaks the shared secret one character at a time to anyone who
 * can measure the response.
 *
 * Both sides are hashed before comparing. `timingSafeEqual` throws when the two
 * buffers differ in length, and feeding it raw tokens would both crash on a
 * wrong-length guess and leak the secret's length; two SHA-256 digests are
 * always 32 bytes, so the comparison is uniform for every input.
 */
export function isValidAgentToken(
  candidate: string | undefined | null,
  expected: string | undefined = process.env.BOL_AGENT_TOKEN,
): boolean {
  // No token configured means the endpoint is not enabled — never open.
  if (!expected || !candidate) return false;
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
