// Mock-tier tests for the `group_messages` operation (src/ops.ts). Zero real network:
// the handler's global fetch is stubbed with a spy; the fixture token
// TESTTOKEN_SHOULD_NEVER_LEAK must never appear in any result or error (R015).
//
// Contract proof for R003 (message projection), R009 (single-cursor pagination +
// truthful metadata) and R015 (token non-disclosure / no persistence):
//  - limit clamped to the official max 100, default 20, invalid -> 20 + warning
//  - direction-scoped pagination metadata (before/after/since/latest)
//  - upstream 304 is end-of-history for before/latest, never an error
//  - progress guard trips on a non-advancing cursor with exactly one fetch
//  - conflicting cursors are rejected locally with zero fetches
//  - malformed envelopes/elements are redacted malformed_response (no zod text)
//  - nothing is persisted under ctx.dataDir; extra upstream fields are dropped
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import { groupMessagesInput, messageShape, operations } from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";

const groupMessages = operations.find((op) => op.name === "group_messages");
if (!groupMessages) throw new Error("group_messages operation missing from operations");
if (!groupMessages.output) throw new Error("group_messages operation has no declared output");

const GROUP_ID = "123";

/** Every serialized result/error observed in a case, asserted token-free at the end. */
const tokenObservations: string[] = [];

/** One upstream message in official shape, plus fields the projection must drop. */
function msg(
  id: string,
  extra: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    created_at: Number(id) * 10,
    name: "Tester",
    text: `message ${id}`,
    attachments: [],
    sender_id: "sender-should-be-dropped",
    conversation_id: "conv-should-be-dropped",
    fwd_count: 0,
    ...extra,
  };
}

const IMAGE_ATTACHMENT = { type: "image", url: "https://i.groupme.com/x.jpeg" };
const LOCATION_ATTACHMENT = {
  type: "location",
  lat: "40.7",
  lng: "-74.0",
  name: "Somewhere",
};
const SPLIT_ATTACHMENT = {
  type: "split",
  token: "split-token",
  recipients: [{ user_id: "2222222" }],
};

/** Official-shape envelope: {meta:{count:N}, response:{count:N, messages:[...]}}. */
function messageEnvelope(messages: unknown[], count?: number): Response {
  const n = count ?? (Array.isArray(messages) ? messages.length : 0);
  return new Response(JSON.stringify({ meta: { count: n }, response: { count: n, messages } }), {
    status: 200,
  });
}

function makeContext(config: Record<string, string | undefined>): Context {
  return { config, dataDir: mkdtempSync(join(tmpdir(), "groupmetoolkit-group-messages-")) };
}

type FetchSpy = ReturnType<typeof vi.fn>;

function stubFetch(impl: (...args: unknown[]) => Promise<Response>): FetchSpy {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Parsed query params of the first fetch call, order-insensitive. */
function queryOf(spy: FetchSpy, call = 0): Record<string, string> {
  const [url] = spy.mock.calls[call] as [string, RequestInit];
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(
    `https://api.groupme.com/v3/groups/${GROUP_ID}/messages`,
  );
  return Object.fromEntries(parsed.searchParams.entries());
}

function urlOf(spy: FetchSpy, call = 0): string {
  const [url] = spy.mock.calls[call] as [string, RequestInit];
  return url as string;
}

interface Outcome {
  result?: Record<string, unknown>;
  error?: unknown;
  ctx: Context;
}

async function call(
  args: Record<string, unknown>,
  config: Record<string, string | undefined> = { GROUPME_ACCESS_TOKEN: TOKEN },
): Promise<Outcome> {
  const ctx = makeContext(config);
  try {
    const result = (await groupMessages!.handler(args as never, ctx)) as Record<string, unknown>;
    tokenObservations.push(JSON.stringify(result));
    return { result, ctx };
  } catch (caught) {
    tokenObservations.push(JSON.stringify(caught));
    return { error: caught, ctx };
  }
}

/** Type-narrowed pagination accessor for assertions. */
type Pagination = {
  direction: string;
  hasContinuation: boolean;
  endOfHistory: boolean;
  nextBeforeId: string | null;
  nextAfterId: string | null;
  progressGuardTripped: boolean;
  upstreamCount: number | null;
};

function pagination(outcome: Outcome): Pagination {
  expect(outcome.error).toBeUndefined();
  return (outcome.result as { pagination: Pagination }).pagination;
}

function resultOf(outcome: Outcome): Record<string, unknown> {
  expect(outcome.error).toBeUndefined();
  const result = outcome.result as Record<string, unknown>;
  // Every successful result must satisfy the declared output contract.
  groupMessages!.output!.parse(result);
  return result;
}

const tempDirs: string[] = [];

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("group_messages: before_id happy path", () => {
  it("pages a full limit-2 window [m9,m8] for before_id=m10 with a nextBeforeId and exact URL", async () => {
    // A full page (2 of limit 2) is the only shape that truthfully has a continuation.
    const spy = stubFetch(async () => messageEnvelope([msg("9"), msg("8")]));
    const outcome = await call({ group_id: GROUP_ID, before_id: "10", limit: 2 });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(result.limit).toBe(2);
    expect(result.limitClamped).toBe(false);
    expect((result.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["9", "8"]);

    const url = urlOf(spy);
    // Query order is the handler's insertion order (cursor, then limit).
    expect(url).toBe(`https://api.groupme.com/v3/groups/${GROUP_ID}/messages?before_id=10&limit=2`);
    const params = queryOf(spy);
    expect(params).toEqual({ limit: "2", before_id: "10" });
    expect(url).not.toContain(TOKEN);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Access-Token"]).toBe(TOKEN);
    expect(headers["Authorization"]).toBeUndefined();
    expect(init.method).toBe("GET");

    const page = pagination(outcome);
    expect(page.direction).toBe("before");
    expect(page.nextBeforeId).toBe("9");
    expect(page.nextAfterId).toBe("8");
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(true);
    expect(page.progressGuardTripped).toBe(false);
    expect(page.upstreamCount).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});

function notModified(): Response {
  // 304 carries no body; fetch implementations surface it as a bodyless response.
  return new Response(null, { status: 304 });
}

function upstreamError(status: number, errors: string[] = []): Response {
  return new Response(JSON.stringify({ meta: { code: status, errors } }), { status });
}

describe("group_messages: 304 end-of-history", () => {
  it("maps upstream 304 on before_id to an empty, truthful end-of-history page", async () => {
    const spy = stubFetch(async () => notModified());
    const outcome = await call({ group_id: GROUP_ID, before_id: "10" });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.messages).toEqual([]);
    const page = pagination(outcome);
    expect(page.direction).toBe("before");
    expect(page.endOfHistory).toBe(true);
    expect(page.hasContinuation).toBe(false);
    expect(page.nextBeforeId).toBeNull();
    expect(page.nextAfterId).toBeNull();
    expect(page.progressGuardTripped).toBe(false);
    expect(page.upstreamCount).toBeNull();
  });

  it("does not claim end-of-history for 304 on after_id", async () => {
    stubFetch(async () => notModified());
    const outcome = await call({ group_id: GROUP_ID, after_id: "12" });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(result.messages).toEqual([]);
    const page = pagination(outcome);
    expect(page.direction).toBe("after");
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(true);
  });
});

describe("group_messages: page-length truth", () => {
  it("a short before_id page (2 of 20) is end-of-history", async () => {
    stubFetch(async () => messageEnvelope([msg("9"), msg("8")]));
    const outcome = await call({ group_id: GROUP_ID, before_id: "10" });
    resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    const page = pagination(outcome);
    expect(page.endOfHistory).toBe(true);
    expect(page.hasContinuation).toBe(false);
  });

  it("a full before_id page continues rather than claiming history exhaustion", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(String(19 - i)));
    stubFetch(async () => messageEnvelope(messages));
    const outcome = await call({ group_id: GROUP_ID, before_id: "20" });
    resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    const page = pagination(outcome);
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(true);
    expect(page.nextBeforeId).toBe("19");
  });
});

describe("group_messages: after_id direction", () => {
  it("returns [m11,m12] ascending with direction after and a nextAfterId", async () => {
    const spy = stubFetch(async () => messageEnvelope([msg("11"), msg("12")]));
    const outcome = await call({ group_id: GROUP_ID, after_id: "10" });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(queryOf(spy)).toEqual({ limit: "20", after_id: "10" });
    expect((result.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["11", "12"]);
    const page = pagination(outcome);
    expect(page.direction).toBe("after");
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(true);
    expect(page.nextAfterId).toBe("12");
    expect(page.progressGuardTripped).toBe(false);
  });
});

describe("group_messages: since_id direction", () => {
  it("a full since_id page warns that gap-freeness is unproven and never claims end-of-history", async () => {
    stubFetch(async () => messageEnvelope([msg("99"), msg("98")]));
    const outcome = await call({ group_id: GROUP_ID, since_id: "97", limit: 2 });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect((result.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["99", "98"]);
    expect(result.warnings).toEqual(["since_id_gap_unproven"]);
    const page = pagination(outcome);
    expect(page.direction).toBe("since");
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(true);
    // Traversal is only proven up to nextAfterId; the result carries no claim beyond it.
    expect(page.nextAfterId).toBe("98");
    expect(result).not.toHaveProperty("gapFree");
    expect(result).not.toHaveProperty("complete");
  });
});

describe("group_messages: limit clamp", () => {
  it("accepts a raw limit of 500 in the schema, requests 100, and reports limitClamped", async () => {
    const args = { group_id: GROUP_ID, limit: 500 };
    // The generated CLI parses the schema before the handler; prove the schema accepts 500.
    expect(() => groupMessagesInput.parse(args)).not.toThrow();

    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call(args);
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(queryOf(spy)).toEqual({ limit: "100" });
    expect(result.limit).toBe(100);
    expect(result.limitClamped).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("defaults a raw limit of 0 to 20 with a warning and no clamp flag", async () => {
    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call({ group_id: GROUP_ID, limit: 0 });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(queryOf(spy)).toEqual({ limit: "20" });
    expect(result.limit).toBe(20);
    expect(result.limitClamped).toBe(false);
    expect(result.warnings).toEqual(["limit_invalid_defaulted_20"]);
  });

  it("echoes a raw limit of 7 unclamped", async () => {
    const spy = stubFetch(async () => messageEnvelope([msg("9")]));
    const outcome = await call({ group_id: GROUP_ID, limit: 7 });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(queryOf(spy)).toEqual({ limit: "7" });
    expect(result.limit).toBe(7);
    expect(result.limitClamped).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("omitted limit requests the official default of 20", async () => {
    const spy = stubFetch(async () => messageEnvelope([msg("9"), msg("8")]));
    const outcome = await call({ group_id: GROUP_ID });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(queryOf(spy)).toEqual({ limit: "20" });
    expect(result.limit).toBe(20);
    expect(result.limitClamped).toBe(false);
  });
});

describe("group_messages: progress guard", () => {
  it("trips when before_id=m8 returns m8 as the oldest element, after a single fetch", async () => {
    const spy = stubFetch(async () => messageEnvelope([msg("8"), msg("7")]));
    const outcome = await call({ group_id: GROUP_ID, before_id: "8" });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(spy).toHaveBeenCalledTimes(1);
    const page = pagination(outcome);
    expect(page.progressGuardTripped).toBe(true);
    expect(page.endOfHistory).toBe(false);
    expect(page.hasContinuation).toBe(false);
    expect(page.nextBeforeId).toBeNull();
    expect(page.nextAfterId).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("trips when after_id returns nothing newer than the cursor", async () => {
    stubFetch(async () => messageEnvelope([msg("10"), msg("9")]));
    const outcome = await call({ group_id: GROUP_ID, after_id: "10" });
    resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    const page = pagination(outcome);
    expect(page.progressGuardTripped).toBe(true);
    expect(page.hasContinuation).toBe(false);
  });
});

describe("group_messages: conflicting cursors", () => {
  it.each([
    { before_id: "10", after_id: "11" },
    { since_id: "5", before_id: "10" },
    { after_id: "11", since_id: "10" },
  ])("rejects %o locally with zero fetches and names both keys", async (cursors) => {
    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call({ group_id: GROUP_ID, ...cursors });
    tempDirs.push(outcome.ctx.dataDir);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(GroupMeError);
    const message = (outcome.error as Error).message;
    for (const key of Object.keys(cursors)) expect(message).toContain(key);
    const envelope = JSON.parse(message) as Record<string, unknown>;
    expect(envelope.code).toBe("invalid_input");
    expect(envelope.detail).toContain("at most one");
    expect(message).not.toContain(TOKEN);
  });
});

describe("group_messages: upstream errors", () => {
  it("maps an upstream 404 to not_found without leaking the token", async () => {
    stubFetch(async () => upstreamError(404, [`token ${TOKEN} rejected`]));
    const outcome = await call({ group_id: GROUP_ID });
    tempDirs.push(outcome.ctx.dataDir);

    expect(outcome.error).toBeInstanceOf(GroupMeError);
    const error = outcome.error as GroupMeError;
    expect(error.code).toBe("not_found");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.upstreamErrors)).not.toContain(TOKEN);
  });

  it("rejects a non-array response.messages as malformed_response", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ meta: { count: 1 }, response: { messages: {} } }), {
          status: 200,
        }),
    );
    const outcome = await call({ group_id: GROUP_ID });
    tempDirs.push(outcome.ctx.dataDir);

    expect(outcome.error).toBeInstanceOf(GroupMeError);
    expect((outcome.error as GroupMeError).code).toBe("malformed_response");
    expect((outcome.error as Error).message).toBe('{"code":"malformed_response","status":200}');
  });

  it.each([
    ["numeric id", { id: 42 }],
    ["non-numeric created_at", { created_at: "yesterday" }],
    ["missing name", { name: undefined }],
  ])("rejects a message with %s as redacted malformed_response", async (_label, override) => {
    stubFetch(async () => messageEnvelope([{ ...msg("9"), ...override }]));
    const outcome = await call({ group_id: GROUP_ID });
    tempDirs.push(outcome.ctx.dataDir);

    expect(outcome.error).toBeInstanceOf(GroupMeError);
    const error = outcome.error as GroupMeError;
    expect(error.code).toBe("malformed_response");
    // No zod issue text leaks; only the redacted envelope is surfaced.
    expect(error.message).toBe('{"code":"malformed_response","status":200}');
    expect(error.message).not.toMatch(/expected|received|invalid_type/i);
  });
});

describe("group_messages: projection and non-persistence", () => {
  it("projects attachments and optional text, dropping upstream-only fields", async () => {
    stubFetch(async () =>
      messageEnvelope([
        msg("9", {
          text: "hello",
          attachments: [IMAGE_ATTACHMENT, LOCATION_ATTACHMENT, SPLIT_ATTACHMENT],
        }),
        msg("8", { text: null, attachments: [IMAGE_ATTACHMENT] }),
        msg("7", { text: undefined, attachments: [SPLIT_ATTACHMENT] }),
      ]),
    );
    const outcome = await call({ group_id: GROUP_ID, before_id: "10" });
    const result = resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.id)).toEqual(["9", "8", "7"]);
    for (const message of messages) {
      // Only projected keys survive; `text` is optional (absent when upstream omitted it).
      const keys = Object.keys(message).sort();
      expect(keys.every((key) => ["attachments", "created_at", "id", "name", "text"].includes(key))).toBe(true);
    }
    expect(Object.keys(messages[0]).sort()).toEqual([
      "attachments",
      "created_at",
      "id",
      "name",
      "text",
    ]);
    expect(Object.keys(messages[1])).toContain("text");
    expect(Object.keys(messages[2])).not.toContain("text");
    expect(messages[0].attachments).toEqual([IMAGE_ATTACHMENT, LOCATION_ATTACHMENT, SPLIT_ATTACHMENT]);
    expect(messages[0].text).toBe("hello");
    expect(messages[1].text).toBeNull();
    expect(messages[2].text).toBeUndefined();
    expect(messages[2].attachments).toEqual([SPLIT_ATTACHMENT]);
    expect(messages[1].attachments).toEqual([IMAGE_ATTACHMENT]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sender_id");
    expect(serialized).not.toContain("conversation_id");
    expect(serialized).not.toContain("fwd_count");
  });

  it("creates no file under ctx.dataDir during a read", async () => {
    stubFetch(async () => messageEnvelope([msg("9"), msg("8")]));
    const outcome = await call({ group_id: GROUP_ID, before_id: "10" });
    resultOf(outcome);
    tempDirs.push(outcome.ctx.dataDir);

    expect(existsSync(outcome.ctx.dataDir)).toBe(true);
    expect(readdirSync(outcome.ctx.dataDir)).toEqual([]);
  });
});

describe("group_messages: auth and token non-disclosure", () => {
  it("fails closed with missing_auth and zero fetches when the token is absent", async () => {
    const spy = stubFetch(async () => messageEnvelope([msg("9")]));
    const outcome = await call({ group_id: GROUP_ID }, {});
    tempDirs.push(outcome.ctx.dataDir);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).toBeInstanceOf(GroupMeError);
    expect((outcome.error as GroupMeError).code).toBe("missing_auth");
    expect((outcome.error as Error).message).toBe('{"code":"missing_auth"}');
    expect((outcome.error as Error).message).not.toContain(TOKEN);
  });

  it("never lets the canary token appear in any observed result or error", () => {
    expect(tokenObservations.length).toBeGreaterThan(0);
    for (const observed of tokenObservations) expect(observed).not.toContain(TOKEN);
  });
});
