import { describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import { operations } from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

// Q7 negative surface for the CLI/MCP listing smoke task: every operation, at the handler
// layer the built CLI and MCP surfaces both call, must fail closed on missing auth.
//
// The per-operation tests in me/chats/groups/group-messages/search-group-messages already
// assert each handler's own missing_auth path with its own fixtures. This file asserts the
// INVARIANT ACROSS ALL OPERATIONS — that no operation added later can quietly skip the
// credential preflight or reach fetch without one — which is exactly what the built-surface
// smokes (scripts/smoke-missing-auth.mjs, scripts/smoke-mcp-surface.mjs) prove end-to-end.
//
// Valid arguments per operation: the schema must pass, so the ONLY possible error is
// missing_auth. `group` takes `id`; the message operations take `group_id`.

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  chats: { page: 1 },
  group: { id: "12345678" },
  group_messages: { group_id: "12345678" },
  groups: { page: 1 },
  me: {},
  search_group_messages: { group_id: "12345678", query: "alpha" },
};

const credentialFreeContext = (): Context => ({ config: {}, dataDir: "/tmp/groupmetoolkit-test" });

describe("surface invariant: every operation fails closed without a token", () => {
  it("covers every declared operation (fails when a new op is added without a case here)", () => {
    expect(operations.map((op) => op.name).sort()).toEqual(Object.keys(VALID_ARGS).sort());
  });

  it.each(operations.map((op) => [op.name, op] as const))(
    "%s raises missing_auth before any network call",
    async (name, op) => {
      const spy = vi.fn(() => {
        throw new Error("network must not be reached");
      });
      vi.stubGlobal("fetch", spy);
      try {
        const args = op.input.parse(VALID_ARGS[name] ?? {});
        await expect(op.handler(args as never, credentialFreeContext())).rejects.toBeInstanceOf(
          GroupMeError,
        );
        const caught = await op.handler(args as never, credentialFreeContext()).catch((e) => e);
        expect((caught as GroupMeError).code).toBe("missing_auth");
        expect(spy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(operations.map((op) => [op.name, op] as const))(
    "%s surfaces a structured envelope with no credential material",
    async (name, op) => {
      vi.stubGlobal("fetch", vi.fn());
      try {
        const args = op.input.parse(VALID_ARGS[name] ?? {});
        const caught = await op.handler(args as never, credentialFreeContext()).catch((e) => e);
        // The message IS the redacted JSON envelope every surface prints verbatim.
        const envelope = JSON.parse((caught as Error).message) as Record<string, unknown>;
        expect(envelope).toEqual({ code: "missing_auth" });
        for (const noise of ["X-Access-Token", "Authorization", "Bearer", "GROUPME_ACCESS_TOKEN"]) {
          expect((caught as Error).message).not.toContain(noise);
        }
        // A cause must never be attached to missing_auth: there was no request to diagnose.
        expect((caught as Error).cause).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rejects an empty-string token the same way (not just an absent one)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    try {
      const me = operations.find((op) => op.name === "me")!;
      const caught = await me
        .handler({} as never, { config: { GROUPME_ACCESS_TOKEN: "" }, dataDir: "/tmp/x" })
        .catch((e) => e);
      expect((caught as GroupMeError).code).toBe("missing_auth");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Boundary: a non-string token (a host that mis-injects an object) must not be coerced.
  it("rejects a non-string token without coercion", async () => {
    vi.stubGlobal("fetch", vi.fn());
    try {
      const me = operations.find((op) => op.name === "me")!;
      const caught = await me
        .handler({} as never, {
          config: { GROUPME_ACCESS_TOKEN: { secret: "x" } as unknown as string },
          dataDir: "/tmp/x",
        })
        .catch((e) => e);
      expect((caught as GroupMeError).code).toBe("missing_auth");
      expect((caught as Error).message).not.toContain("secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
