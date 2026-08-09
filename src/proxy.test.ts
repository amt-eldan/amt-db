import { describe, expect, it } from "vitest";
import { isOAuthDiscoveryPath } from "./proxy";

/**
 * A connector asks for OAuth metadata before it will speak MCP. Getting this
 * wrong does not fail loudly — the probe follows the redirect to /login, reads
 * 200 and an HTML page as if it were the metadata, and the connector reports a
 * broken sign-in service. Hence a test on the one predicate that prevents it.
 */
describe("isOAuthDiscoveryPath", () => {
  it("catches the discovery documents, bare and with the resource path appended", () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      // RFC 8414 / RFC 9728 put the resource's own path after the well-known part.
      "/.well-known/oauth-protected-resource/api/mcp/some-token",
      "/.well-known/oauth-authorization-server/api/mcp/some-token",
    ]) {
      expect(isOAuthDiscoveryPath(path), path).toBe(true);
    }
  });

  it("leaves every other path to the session check", () => {
    for (const path of [
      "/",
      "/orders",
      "/login",
      "/api/mcp/some-token",
      "/api/bol/worklist",
      "/.well-known/security.txt",
      "/.well-known/oauth-protected-resource-lookalike",
      "/well-known/oauth-authorization-server", // no dot: not the real thing
    ]) {
      expect(isOAuthDiscoveryPath(path), path).toBe(false);
    }
  });
});
