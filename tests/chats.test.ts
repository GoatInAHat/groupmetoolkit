// Mock-tier tests for the `chats` operation (src/ops.ts, D014). Zero real network: the
// handler's global fetch is stubbed with a spy; the fixture token TESTTOKEN_SHOULD_NEVER_LEAK
// must never appear in any result or error. Modeled on tests/groups.test.ts.
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import { chatsInput, chatsOutput, operations } from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";

const chats = operations.find((op) => op.name === "chats");
if (!chats || !chats.output) throw new Error("chats operation missing from operations");

/** One /chats row as the upstream payload carries it: numeric other_user.id plus the
 * upstream-only conversation keys (sender_id/recipient_id/conversation_id/group_id). */
const UPSTREAM_CHAT = {
  id: "abc123",
  created_at: 1700000000,
  updated_at: 1700000500,
  other_user: { id: 777, name: "Dana", image_url: "https://i.groupme.com/avatars/d.jpeg" },
  last_message: {
    id: "msg-1",
    sender_id: "777",
    recipient_id: "111",
    conversation_id: "abc123",
    group_id: null,
    created_at: 1700000499,
    name: "Dana",
    text: null,
    attachments: [{ type: "image", url: "https://i.groupme.com/x.jpeg" }],
  },
  extra_upstream_key: "dropped",
};

function envelope(payload: unknown): Response {
  return new Response(JSON.stringify({ meta: {}, response: payload }), { status: 200 });
}

function makeContext(config: Record<string, string | undefined>): Context {
  return { config, dataDir: "/tmp/groupmetoolkit-test" };
}

type FetchSpy = ReturnType<typeof vi.fn>;

function stubFetch(impl: (...args: unknown[]) => Promise<Response>): FetchSpy {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Every serialized outcome the suite observes; the canary scan reads this list. */
const tokenObservations: string[] = [];

function observe(value: unknown): string {
  const serialized = JSON.stringify(value);
  tokenObservations.push(serialized);
  return serialized;
}

async function call(args: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }> {
  try {
    const result = await chats!.handler(args, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    observe(result);
    return { result };
  } catch (caught) {
    observe((caught as GroupMeError).message ?? caught);
    return { error: caught };
  }
}

/** Re-parse the declared output contract so each successful case exercises it. */
function resultOf(outcome: { result?: unknown; error?: unknown }): unknown {
  expect(outcome.error).toBeUndefined();
  const parsed = chatsOutput.safeParse(outcome.result);
  expect(parsed.success).toBe(true);
  return parsed.data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chats: mocked index read", () => {
  it("reads page 2 per_page 25, sends the token in the header only, and projects the row", async () => {
    const spy = stubFetch(async () => envelope([UPSTREAM_CHAT]));
    const outcome = await call({ page: 2, per_page: 25 });
    const data = resultOf(outcome) as {
      page: number;
      perPage: number;
      count: number;
      chats: Array<Record<string, unknown>>;
    };
    expect(data).toMatchObject({ page: 2, perPage: 25, count: 1 });

    const chat = data.chats[0] as {
      other_user: { id: unknown };
      last_message: Record<string, unknown>;
    };
    // Numeric upstream other_user.id is normalized to a string (D014).
    expect(chat.other_user.id).toBe("777");
    // text:null is preserved for an attachment-only message.
    expect(chat.last_message.text).toBeNull();
    expect(chat.last_message.attachments).toEqual([{ type: "image", url: "https://i.groupme.com/x.jpeg" }]);
    // Upstream-only conversation keys and extras are dropped.
    for (const dropped of ["sender_id", "recipient_id", "conversation_id", "group_id", "extra_upstream_key"]) {
      expect(JSON.stringify(data)).not.toContain(`"${dropped}"`);
    }

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groupme.com/v3/chats?page=2&per_page=25");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Access-Token"]).toBe(TOKEN);
    expect(headers["Authorization"]).toBeUndefined();
    expect(url).not.toContain(TOKEN);
  });

  it("echoes page 1 / perPage 0 when page and per_page are omitted (never the observed length)", async () => {
    stubFetch(async () => envelope([]));
    const outcome = await call({});
    const data = resultOf(outcome);
    expect(data).toEqual({ page: 1, perPage: 0, count: 0, chats: [] });
  });

  it("still echoes an explicit page without inventing perPage from the row count", async () => {
    stubFetch(async () => envelope([UPSTREAM_CHAT]));
    const outcome = await call({ page: 3 });
    expect(resultOf(outcome)).toMatchObject({ page: 3, perPage: 0, count: 1 });
  });

  it("an empty array returns count 0 with exactly page/perPage/count/chats keys", async () => {
    stubFetch(async () => envelope([]));
    const outcome = await call({});
    const data = resultOf(outcome) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["chats", "count", "page", "perPage"]);
    const serialized = JSON.stringify(outcome.result);
    for (const absent of ["total", "hasMore", "nextPage", "omit"]) {
      expect(serialized).not.toContain(`"${absent}"`);
    }
  });

  it("passes an upstream 404 through as a redacted not_found with no token", async () => {
    stubFetch(async () => new Response("{}", { status: 404 }));
    const { error } = await call({});
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("not_found");
    expect((error as GroupMeError).status).toBe(404);
    expect(observe(error)).not.toContain(TOKEN);
  });
});

describe("chats: malformed upstream payloads are redacted malformed_response", () => {
  function expectMalformed(status: number): Promise<void> {
    return (async () => {
      const { error } = await call({});
      expect(error).toBeInstanceOf(GroupMeError);
      expect((error as GroupMeError).code).toBe("malformed_response");
      expect((error as GroupMeError).status).toBe(status);
      const serialized = observe(error);
      expect(serialized).not.toContain(TOKEN);
      // No zod issue text ever surfaces.
      for (const wording of ["expected", "received", "path"]) {
        expect(serialized).not.toContain(wording);
      }
    })();
  }

  it("null inner response", async () => {
    stubFetch(async () => envelope(null));
    await expectMalformed(200);
  });

  it("non-array inner response", async () => {
    stubFetch(async () => envelope({ chats: [] }));
    await expectMalformed(200);
  });

  it("element missing other_user.name", async () => {
    stubFetch(async () => envelope([{ ...UPSTREAM_CHAT, other_user: { id: 777, image_url: null } }]));
    await expectMalformed(200);
  });

  it("element with other_user.id that is neither string nor number", async () => {
    stubFetch(async () => envelope([{ ...UPSTREAM_CHAT, other_user: { id: { nested: true }, name: "Dana", image_url: null } }]));
    await expectMalformed(200);
  });

  it("element with last_message missing", async () => {
    stubFetch(async () => envelope([{ ...UPSTREAM_CHAT, last_message: null }]));
    await expectMalformed(200);
  });

  it("a 304 is malformed_response, not an empty page", async () => {
    stubFetch(async () => new Response(null, { status: 304 }));
    await expectMalformed(304);
  });
});

describe("chats: auth, persistence and token non-disclosure", () => {
  it("missing_auth with zero network calls when the token is absent from config (MEM014)", async () => {
    delete process.env["GROUPME_ACCESS_TOKEN"];
    const spy = stubFetch(async () => envelope([UPSTREAM_CHAT]));
    let error: unknown;
    try {
      await chats!.handler({}, makeContext({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("missing_auth");
    expect(spy).not.toHaveBeenCalled();
    expect(observe(error)).not.toContain(TOKEN);
  });

  it("persists nothing: ctx.dataDir is untouched after a read", async () => {
    stubFetch(async () => envelope([UPSTREAM_CHAT]));
    const ctx = makeContext({ GROUPME_ACCESS_TOKEN: TOKEN });
    const dataDir = new URL("../.tmp-chats-test", import.meta.url).pathname;
    const { mkdirSync, rmSync } = await import("node:fs");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    try {
      await chats!.handler({}, { ...ctx, dataDir });
      expect(readdirSync(dataDir).length).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("the canary token appears in no serialized result or error collected above", () => {
    expect(tokenObservations.length).toBeGreaterThan(0);
    for (const serialized of tokenObservations) {
      expect(serialized).not.toContain(TOKEN);
    }
  });

  it("the input schema rejects a non-positive page without a network call", () => {
    const spy = stubFetch(async () => envelope([]));
    expect(chatsInput.safeParse({ page: 0 }).success).toBe(false);
    expect(chatsInput.safeParse({ per_page: -1 }).success).toBe(false);
    expect(chatsInput.safeParse({ page: 1.5 }).success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
