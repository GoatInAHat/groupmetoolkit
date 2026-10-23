// Mock-tier tests for the `search_group_messages` operation (src/ops.ts, R004/D003/D013).
// Zero real network: the handler's global fetch is stubbed with a spy backed by a QUEUE of
// per-call Responses, so a bounded multi-page scan is provable call-by-call. The fixture
// token TESTTOKEN_SHOULD_NEVER_LEAK must never appear in any result or error (R015).
//
// Contract proof (R004, D013, MEM021):
//  - the scan is client-side: every request carries ONLY before_id and limit (never
//    query/text/q), and pages are fetched sequentially, at most ceil(budget/limit) times
//  - clamps (D011) are derived from RAW args: budget 500/limit 100/maxMatches 100, defaults
//    100/20/25, invalid -> default + a named warning, never a rejection
//  - truthful metadata: endOfHistory ONLY on 304 / an empty page / a short page whose rows
//    were all examined; budget_exhausted only when the budget stopped a non-exhausted scan;
//    match_cap_reached only when the cap stopped examination; scanned counts examined rows only
//  - nextBeforeId is the last EXAMINED row in server order, so a continuation skips nothing
//  - progress guard trips on a non-advancing cursor; malformed pages are ONE redacted error
//  - missing_auth with zero fetches, no persistence, no regex built from caller input
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import {
  messageShape,
  operations,
  searchGroupMessagesInput,
  searchGroupMessagesOutput,
} from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";
const GROUP_ID = "123";

const search = operations.find((op) => op.name === "search_group_messages");
if (!search) throw new Error("search_group_messages operation missing from operations");
if (!search.output) throw new Error("search_group_messages operation has no declared output");

/** Every serialized result/error observed in a case, asserted token-free at the end. */
const tokenObservations: string[] = [];

type FetchSpy = ReturnType<typeof vi.fn>;

function stubFetch(impl: (...args: unknown[]) => Promise<Response>): FetchSpy {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

interface Outcome {
  result?: Record<string, unknown>;
  error?: unknown;
  ctx: Context;
}

const tempDirs: string[] = [];

function makeContext(config: Record<string, string | undefined>): Context {
  const dataDir = mkdtempTempDir();
  return { config, dataDir };
}

function mkdtempTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "groupmetoolkit-search-"));
  tempDirs.push(dir);
  return dir;
}

/** One upstream message in official shape, plus fields the projection must drop. */
function msg(id: string, text: string | null | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id,
    created_at: Number(id) * 10,
    name: "Tester",
    attachments: [],
    sender_id: "sender-should-be-dropped",
    conversation_id: "conv-should-be-dropped",
    fwd_count: 0,
    ...extra,
  };
  if (text !== undefined) row["text"] = text;
  return row;
}

/** Official-shape page: {meta:{count:N}, response:{count:N, messages:[...]}}. */
function messageEnvelope(messages: unknown[], count?: number, status = 200): Response {
  const n = count ?? (Array.isArray(messages) ? messages.length : 0);
  return new Response(JSON.stringify({ meta: { count: n, code: status, errors: [] }, response: { count: n, messages } }), {
    status,
  });
}

function notModified(): Response {
  return new Response(null, { status: 304 });
}

/**
 * A queue-backed fetch stub: each call shifts the next Response. `queueLength` is asserted
 * at the end of a case so a missing or extra fetch is visible, not silently absorbed.
 */
function queuedFetch(queue: Response[]): FetchSpy {
  return stubFetch(async () => {
    const next = queue.shift();
    if (!next) throw new Error("queuedFetch: fetch called past the end of the response queue");
    return next;
  });
}

/** Descending rows, exactly as a before_id page arrives (server order). */
function descending(firstId: number, lastId: number, text: (offset: number) => string | null): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let id = firstId, offset = 0; id >= lastId; id--, offset++) {
    rows.push(msg(String(id), text(offset)));
  }
  return rows;
}

/** Parsed query params of one fetch call, order-insensitive. */
function queryOf(spy: FetchSpy, call = 0): Record<string, string> {
  const [url] = spy.mock.calls[call] as [string, RequestInit];
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(`https://api.groupme.com/v3/groups/${GROUP_ID}/messages`);
  return Object.fromEntries(parsed.searchParams.entries());
}

function urlOf(spy: FetchSpy, call = 0): string {
  const [url] = spy.mock.calls[call] as [string, RequestInit];
  return url as string;
}

async function call(
  args: Record<string, unknown>,
  config: Record<string, string | undefined> = { GROUPME_ACCESS_TOKEN: TOKEN },
): Promise<Outcome> {
  const ctx = makeContext(config);
  try {
    const result = (await search!.handler(args as never, ctx)) as Record<string, unknown>;
    tokenObservations.push(JSON.stringify(result));
    return { result, ctx };
  } catch (caught) {
    tokenObservations.push(JSON.stringify(caught));
    return { error: caught, ctx };
  }
}

interface SearchResult {
  group_id: string;
  query: string;
  budget: number;
  budgetClamped: boolean;
  limit: number;
  limitClamped: boolean;
  maxMatches: number;
  maxMatchesClamped: boolean;
  scanned: number;
  matched: number;
  pagesFetched: number;
  matches: Array<{ id: string; text?: string | null }>;
  progressGuardTripped: boolean;
  endOfHistory: boolean;
  nextBeforeId: string | null;
  warnings: string[];
}

/** Re-parse the declared output contract so every successful case exercises it. */
function resultOf(outcome: Outcome): SearchResult {
  expect(outcome.error).toBeUndefined();
  const parsed = searchGroupMessagesOutput.safeParse(outcome.result);
  expect(parsed.success).toBe(true);
  return (parsed as { data: SearchResult }).data;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("search_group_messages: budget-limited scan across pages", () => {
  it("budget 105 / limit 100 over a full page then a 5-row page fetches exactly twice and reports scanned 105", async () => {
    // Page 1: 100 descending rows (ids 300..201), alternating alpha/beta (50 matches).
    // Page 2: 5 descending rows (ids 200..196), all alpha.
    const page1 = descending(300, 201, (offset) => (offset % 2 === 0 ? "alpha" : "beta"));
    const page2 = descending(200, 196, () => "alpha");
    const queue = [messageEnvelope(page1), messageEnvelope(page2)];
    const spy = queuedFetch(queue);

    // The default maxMatches (25) would stop page 1 early: the budget must be the stopper.
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 105, limit: 100, maxMatches: 100 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(queue.length).toBe(0);

    // The ONLY query params ever sent are before_id and limit: no server-side search.
    expect(queryOf(spy, 0)).toEqual({ limit: "100" });
    // The second request resumes strictly older than page 1's oldest row (201).
    expect(queryOf(spy, 1)).toEqual({ limit: "100", before_id: "201" });
    for (const callIndex of [0, 1]) {
      const params = queryOf(spy, callIndex);
      expect(Object.keys(params).sort()).toEqual(
        Object.keys(params).filter((key) => key === "before_id" || key === "limit").sort(),
      );
      for (const forbidden of ["query", "text", "q", "search"]) expect(params).not.toHaveProperty(forbidden);
    }
    expect(urlOf(spy, 0)).not.toContain(TOKEN);
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Access-Token"]).toBe(TOKEN);
    expect(headers["Authorization"]).toBeUndefined();
    expect(init.method).toBe("GET");

    expect(result.budget).toBe(105);
    expect(result.budgetClamped).toBe(false);
    expect(result.maxMatches).toBe(100);
    expect(result.limit).toBe(100);
    expect(result.limitClamped).toBe(false);
    expect(result.scanned).toBe(105);
    expect(result.pagesFetched).toBe(2);
    expect(result.matched).toBe(55); // 50 on page 1 + 5 on page 2
    expect(result.warnings).not.toContain("match_cap_reached");
    expect(result.progressGuardTripped).toBe(false);
    // The budget (105) ran out exactly at the end of a SHORT page, so examination finished:
    // the scan is genuinely exhausted and claims it (plan truthfulness rule: a short page
    // whose rows were all examined is end-of-history, never budget_exhausted).
    expect(result.endOfHistory).toBe(true);
    expect(result.nextBeforeId).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.matches.map((match) => match.id)).toEqual([
      ...page1.filter((_, offset) => offset % 2 === 0).map((row) => row["id"]),
      ...page2.map((row) => row["id"]),
    ]);
    for (const match of result.matches) {
      expect((match.text ?? "").toLowerCase()).toContain("alpha");
      messageShape.parse(match);
      // Upstream-only fields are dropped by projection.
      expect(match).not.toHaveProperty("sender_id");
    }
  });

  it("a budget that stops mid-page counts only examined rows in scanned and points nextBeforeId at the last examined row", async () => {
    // limit 10, budget 25 -> page 1 full (10), page 2 full (10), page 3 examined only 5 of 10.
    const pageRows = (firstId: number, text: string) => descending(firstId, firstId - 9, () => text);
    const queue = [
      messageEnvelope(pageRows(100, "alpha")),
      messageEnvelope(pageRows(90, "alpha")),
      messageEnvelope(pageRows(80, "alpha")),
    ];
    const spy = queuedFetch(queue);

    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 25, limit: 10, maxMatches: 100 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(queue.length).toBe(0);
    expect(result.scanned).toBe(25); // 10 + 10 + 5: unexamined rows of page 3 are not counted
    expect(result.matched).toBe(25);
    expect(result.pagesFetched).toBe(3);
    expect(result.endOfHistory).toBe(false); // the third page was full, so more history MAY exist
    expect(result.warnings).toContain("budget_exhausted");
    // Page 3 rows descend 80..71; only 80..76 were examined, so the cursor is 76.
    expect(result.nextBeforeId).toBe("76");
  });

  it("stops defensively at ceil(budget/limit) fetches even if pages never shorten", async () => {
    // budget 5 / limit 5 -> maxPages 1: exactly one fetch, budget exhausted on a full page.
    const queue = [messageEnvelope(descending(500, 496, () => "alpha"))];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 5, limit: 5 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(queue.length).toBe(0);
    expect(result.pagesFetched).toBe(1);
    expect(result.scanned).toBe(5);
    expect(result.endOfHistory).toBe(false);
    expect(result.warnings).toContain("budget_exhausted");
    expect(result.nextBeforeId).toBe("496");
  });
});

describe("search_group_messages: truthful end-of-history", () => {
  it("a short final page exhausts the scan: endOfHistory true, nextBeforeId null, no budget_exhausted", async () => {
    const queue = [messageEnvelope(descending(50, 46, () => "alpha"))];
    const spy = queuedFetch(queue);
    // The default maxMatches (25) would stop page 1 early: the budget must be the stopper.
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 105, limit: 100, maxMatches: 100 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(5);
    expect(result.pagesFetched).toBe(1);
    expect(result.endOfHistory).toBe(true);
    expect(result.nextBeforeId).toBeNull();
    expect(result.warnings).not.toContain("budget_exhausted");
    expect(result.warnings).not.toContain("match_cap_reached");
    expect(result.matched).toBe(5);
  });

  it("an upstream 304 on a later page is end-of-history, not an error, and stops all further fetches", async () => {
    const queue = [messageEnvelope(descending(100, 91, () => "beta")), notModified()];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 300, limit: 10 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(queue.length).toBe(0);
    expect(result.pagesFetched).toBe(2);
    expect(result.scanned).toBe(10);
    expect(result.matched).toBe(0);
    expect(result.endOfHistory).toBe(true);
    expect(result.nextBeforeId).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("an empty first page is end-of-history with zero matches and no warnings", async () => {
    const queue = [messageEnvelope([])];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "missing", budget: 900, limit: 500 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.endOfHistory).toBe(true);
    expect(result.nextBeforeId).toBeNull();
    expect(result.warnings).toEqual([]);
    // 900/500 clamp: budget 500 with budgetClamped, limit 100 with limitClamped.
    expect(result.budget).toBe(500);
    expect(result.budgetClamped).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.limitClamped).toBe(true);
    expect(queryOf(spy)).toEqual({ limit: "100" });
  });

  it("a zero-match short-page scan returns an empty matches array and no warnings", async () => {
    const queue = [messageEnvelope(descending(30, 28, () => "unrelated"))];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "needle", limit: 100 });
    const result = resultOf(outcome);

    expect(result.matched).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.endOfHistory).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("search_group_messages: match cap", () => {
  it("stops at maxMatches inside a full page and reports scanned as the rows examined, never the whole page", async () => {
    // limit 100, maxMatches 2; matching rows sit at offsets 0, 10 and 50 of a 100-row page.
    const page1 = descending(1000, 901, (offset) =>
      offset === 0 || offset === 10 || offset === 50 ? "hit" : "miss",
    );
    const queue = [messageEnvelope(page1)];
    const spy = queuedFetch(queue);

    const outcome = await call({ group_id: GROUP_ID, query: "hit", limit: 100, maxMatches: 2 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(1); // exactly one fetch: the cap stops before page 2
    expect(queue.length).toBe(0);
    expect(result.matched).toBe(2);
    expect(result.pagesFetched).toBe(1);
    expect(result.warnings).toContain("match_cap_reached");
    expect(result.warnings).not.toContain("budget_exhausted");
    expect(result.endOfHistory).toBe(false);
    // The cap fires on the 11th examined row (offsets 0..10), so 11 rows were scanned.
    expect(result.scanned).toBe(11);
    expect(result.matches.map((match) => match.id)).toEqual(["1000", "990"]);
    // Last examined row is offset 10 = id 990; no unexamined row is skipped by a continuation.
    expect(result.nextBeforeId).toBe("990");
    expect(result.nextBeforeId).toBe(result.matches[1]!.id);
  });
});

describe("search_group_messages: text matching", () => {
  it("is case-insensitive in both directions and never matches null-text or attachment-only rows", async () => {
    const page = [
      msg("9", "Hello World"),
      msg("8", "hello world"),
      msg("7", "HELLO"),
      msg("6", null, { attachments: [{ type: "image", url: "https://i.groupme.com/x.jpeg" }] }),
      msg("5", undefined, { attachments: [{ type: "location", lat: "40.7", lng: "-74.0", name: "hello" }] }),
      msg("4", "unrelated"),
    ];
    const queue = [messageEnvelope(page)];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "HeLLo", limit: 100 });
    const result = resultOf(outcome);

    expect(result.matches.map((match) => match.id)).toEqual(["9", "8", "7"]);
    expect(result.matched).toBe(3);
    expect(result.scanned).toBe(6);
    // Attachment-only rows survive projection with text absent/null but are not matches.
    expect(JSON.stringify(result.matches)).not.toContain('"id":"6"');
  });

  it("treats regex metacharacters as literal text, since no regex is built from caller input", async () => {
    const page = [msg("9", "a.c"), msg("8", "abc"), msg("7", "a(b")];
    const queue = [messageEnvelope(page)];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "a.c", limit: 100 });
    const result = resultOf(outcome);

    // If the needle were compiled as a regex, "abc" would match; it must not.
    expect(result.matches.map((match) => match.id)).toEqual(["9"]);
  });
});

describe("search_group_messages: clamps and defaults from raw args", () => {
  it("clamps budget 900 to 500 and limit 500 to 100, flags both, and accepts them in the schema", async () => {
    const args = { group_id: GROUP_ID, query: "x", budget: 900, limit: 500 };
    // The generated CLI parses the schema before the handler; prove the schema accepts them.
    expect(() => searchGroupMessagesInput.parse(args)).not.toThrow();

    const queue = [messageEnvelope([])];
    const spy = queuedFetch(queue);
    const outcome = await call(args);
    const result = resultOf(outcome);

    expect(queryOf(spy)).toEqual({ limit: "100" });
    expect(result.budget).toBe(500);
    expect(result.budgetClamped).toBe(true);
    expect(result.limit).toBe(100);
    expect(result.limitClamped).toBe(true);
    expect(result.maxMatches).toBe(25);
    expect(result.maxMatchesClamped).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("clamps maxMatches 500 to 100 and reports maxMatchesClamped", async () => {
    const queue = [messageEnvelope([])];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "x", maxMatches: 500 });
    const result = resultOf(outcome);

    expect(result.maxMatches).toBe(100);
    expect(result.maxMatchesClamped).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it.each([{ budget: 0 }, { budget: -5 }])(
    "defaults a raw budget of %o to 100 with a warning and no clamp flag",
    async ({ budget }) => {
      // The schema itself accepts an out-of-range integer (no .min/.max, D011); the handler
      // defaults it rather than letting the CLI's input.parse reject the call.
      expect(() => searchGroupMessagesInput.parse({ group_id: GROUP_ID, query: "x", budget })).not.toThrow();
      const queue = [messageEnvelope([])];
      const spy = queuedFetch(queue);
      const outcome = await call({ group_id: GROUP_ID, query: "x", budget });
      const result = resultOf(outcome);

      expect(result.budget).toBe(100);
      expect(result.budgetClamped).toBe(false);
      expect(result.warnings).toContain("budget_invalid_defaulted_100");
      // The effective limit still drives the request.
      expect(queryOf(spy)).toEqual({ limit: "20" });
    },
  );

  it("the schema rejects a non-integer budget before the handler, so it never reaches the clamp", async () => {
    // z.number().int() is part of the declared contract: the CLI's Number() flag conversion
    // can only produce an integer or NaN, and 2.5 is a caller bug, not a clamp candidate.
    expect(searchGroupMessagesInput.safeParse({ group_id: GROUP_ID, query: "x", budget: 2.5 }).success).toBe(false);
    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call({ group_id: GROUP_ID, query: "x", budget: 2.5 });
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).not.toBeInstanceOf(GroupMeError);
  });

  it("defaults an invalid limit to 20 with a warning", async () => {
    const queue = [messageEnvelope([])];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "x", limit: 0 });
    const result = resultOf(outcome);

    expect(result.limit).toBe(20);
    expect(result.limitClamped).toBe(false);
    expect(result.warnings).toContain("limit_invalid_defaulted_20");
    expect(queryOf(spy)).toEqual({ limit: "20" });
  });

  it("defaults an omitted budget to 100 with no warning", async () => {
    const queue = [messageEnvelope([])];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "x" });
    const result = resultOf(outcome);

    expect(result.budget).toBe(100);
    expect(result.budgetClamped).toBe(false);
    expect(result.maxMatches).toBe(25);
    expect(result.warnings).toEqual([]);
  });
});

describe("search_group_messages: progress guard", () => {
  it("trips when a page's oldest row does not move the cursor, with exactly two fetches", async () => {
    // Page 1 descends 100..91, so the next cursor is 91. Page 2 returns 91 as its oldest row:
    // the cursor did not advance, so the scan stops instead of looping.
    const queue = [
      messageEnvelope(descending(100, 91, () => "beta")),
      // Page 2's OLDEST row (its last element) is 91, the same cursor page 1 produced:
      // the cursor did not move, so the guard trips instead of requesting 91 forever.
      messageEnvelope(descending(100, 91, () => "beta")),
      // A third page exists only so a regression (a fetch after the guard tripped) is
      // visible as a call-count and queue-length failure, not as a network_error.
      messageEnvelope(descending(81, 72, () => "beta")),
    ];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 1000, limit: 10 });
    const result = resultOf(outcome);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(queue.length).toBe(1);
    expect(queryOf(spy, 1)).toEqual({ limit: "10", before_id: "91" });
    expect(result.progressGuardTripped).toBe(true);
    expect(result.warnings).toContain("progress_guard_tripped");
    expect(result.endOfHistory).toBe(false);
    expect(result.scanned).toBe(20);
    // Page 2 descends 100..91; its last examined row is 91, never past unexamined rows.
    expect(result.nextBeforeId).toBe("91");
  });
});

describe("search_group_messages: malformed upstream pages", () => {
  it("throws ONE redacted malformed_response when an element of the second page lacks an id", async () => {
    const page1 = descending(100, 91, () => "alpha");
    const brokenRow = { created_at: 1, name: "x", attachments: [] };
    const queue = [
      messageEnvelope(page1),
      messageEnvelope([msg("90", "alpha"), brokenRow]),
    ];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 1000, limit: 10 });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(outcome.error).toBeInstanceOf(GroupMeError);
    const error = outcome.error as GroupMeError;
    expect(error.code).toBe("malformed_response");
    expect(error.status).toBe(200);
    const serialized = tokenObservations[tokenObservations.length - 1]!;
    expect(serialized).not.toContain(TOKEN);
    // No zod issue text ever surfaces (it is upstream-derived).
    for (const wording of ["expected", "received", "path", "invalid_type"]) {
      expect(serialized).not.toContain(wording);
    }
  });

  it("throws malformed_response for a non-object envelope and for a non-array messages key", async () => {
    const nonObject = new Response(JSON.stringify({ meta: {}, response: null }), { status: 200 });
    const nonArray = new Response(JSON.stringify({ meta: {}, response: { count: 1, messages: {} } }), { status: 200 });

    for (const response of [nonObject, nonArray]) {
      const queue = [response];
      queuedFetch(queue);
      const outcome = await call({ group_id: GROUP_ID, query: "x" });
      expect(outcome.error).toBeInstanceOf(GroupMeError);
      expect((outcome.error as GroupMeError).code).toBe("malformed_response");
      expect(queue.length).toBe(0);
    }
  });

  it("passes an upstream 429 through as a redacted rate_limited error after the client's bounded retries", async () => {
    // The shared client retries 429 at most twice (D006); with no Retry-After header it
    // uses exponential backoff, so this case pays ~1.5s of real wait. The scan never loops
    // past the client: it sees ONE rate_limited error and returns it.
    const rateLimited = () => new Response(JSON.stringify({ meta: { code: 429, errors: [] } }), { status: 429 });
    const queue = [rateLimited(), rateLimited(), rateLimited()];
    const spy = queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "x" });

    expect(spy).toHaveBeenCalledTimes(3); // 1 attempt + 2 retries, then it gives up
    expect(queue.length).toBe(0);
    expect(outcome.error).toBeInstanceOf(GroupMeError);
    expect((outcome.error as GroupMeError).code).toBe("rate_limited");
    expect(tokenObservations[tokenObservations.length - 1]!).not.toContain(TOKEN);
  });
});

describe("search_group_messages: input contract", () => {
  it.each([
    { group_id: GROUP_ID, query: "" },
    { group_id: GROUP_ID, query: "   " },
    { query: "alpha" },
    { group_id: "abc", query: "alpha" },
  ])("input.parse rejects %o with zero fetches", async (args) => {
    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call(args);

    expect(spy).not.toHaveBeenCalled();
    // A schema rejection is local validation, never a GroupMe network error.
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(GroupMeError);
    expect((outcome.error as { name?: string }).name).toBe("ZodError");
    expect(searchGroupMessagesInput.safeParse(args).success).toBe(false);
    expect(tokenObservations[tokenObservations.length - 1]!).not.toContain(TOKEN);
  });

  it("trims the query before scanning and echoes the trimmed value", async () => {
    const queue = [messageEnvelope([msg("9", "alpha")])];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "  alpha  " });
    const result = resultOf(outcome);
    expect(result.query).toBe("alpha");
    expect(result.matched).toBe(1);
  });
});

describe("search_group_messages: auth, persistence and annotations", () => {
  it("missing_auth with zero fetches when the token is absent from config (MEM014)", async () => {
    delete process.env["GROUPME_ACCESS_TOKEN"];
    const spy = stubFetch(async () => messageEnvelope([]));
    const outcome = await call({ group_id: GROUP_ID, query: "x" }, {});

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).toBeInstanceOf(GroupMeError);
    expect((outcome.error as GroupMeError).code).toBe("missing_auth");
    expect(tokenObservations[tokenObservations.length - 1]!).not.toContain(TOKEN);
  });

  it("reads the token ONLY from ctx.config, never from process.env", async () => {
    process.env["GROUPME_ACCESS_TOKEN"] = TOKEN;
    try {
      const spy = stubFetch(async () => messageEnvelope([]));
      await call({ group_id: GROUP_ID, query: "x" }, {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env["GROUPME_ACCESS_TOKEN"];
    }
  });

  it("persists nothing: ctx.dataDir is untouched after a scan", async () => {
    const queue = [messageEnvelope(descending(100, 91, () => "alpha")), messageEnvelope(descending(91, 82, () => "alpha"))];
    queuedFetch(queue);
    const outcome = await call({ group_id: GROUP_ID, query: "alpha", budget: 20, limit: 10 });
    resultOf(outcome);
    expect(readdirSync(outcome.ctx.dataDir).length).toBe(0);
  });

  it("carries the read-only annotation contract and the net requirement", () => {
    expect(search!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(search!.requires).toEqual(["net"]);
    expect(search!.input).toBe(searchGroupMessagesInput);
    expect(search!.output).toBe(searchGroupMessagesOutput);
  });

  it("the canary token appears in no serialized result or error collected above", () => {
    expect(tokenObservations.length).toBeGreaterThan(0);
    for (const serialized of tokenObservations) {
      expect(serialized).not.toContain(TOKEN);
    }
  });
});
