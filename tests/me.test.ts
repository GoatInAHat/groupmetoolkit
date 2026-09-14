// Mock-tier tests for the `me` operation (src/ops.ts). Zero real network: the
// handler's global fetch is stubbed with a spy; the fixture token must never
// appear in any result or error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import { operations } from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";
const PHONE = "+1 5550100";
const EMAIL = "test@example.com";

const me = operations.find((op) => op.name === "me");
if (!me || !me.output) throw new Error("me operation missing from operations");

const PROFILE = {
  id: "1234567890",
  name: "Test User",
  image_url: "https://i.groupme.com/avatars/test.jpeg",
  created_at: 1600000000,
  updated_at: 1700000000,
  phone_number: PHONE,
  email: EMAIL,
};

function envelope(profile: unknown): Response {
  return new Response(JSON.stringify({ meta: {}, response: profile }), { status: 200 });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("me: mocked 200 profile read", () => {
  it("projects exactly id, name, image_url, created_at, updated_at and drops PII (D009)", async () => {
    const spy = stubFetch(async () => envelope(PROFILE));
    const result = await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    me.output!.parse(result);
    expect(result).toEqual({
      id: "1234567890",
      name: "Test User",
      image_url: "https://i.groupme.com/avatars/test.jpeg",
      created_at: 1600000000,
      updated_at: 1700000000,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(TOKEN);
    // The upstream call went to /users/me with the token in the header only.
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groupme.com/v3/users/me");
    expect((init.headers as Record<string, string>)["X-Access-Token"]).toBe(TOKEN);
    expect(url).not.toContain(TOKEN);
  });

  it("allows a null image_url", async () => {
    stubFetch(async () => envelope({ ...PROFILE, image_url: null }));
    const result = await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    expect(result.image_url).toBeNull();
  });
});

describe("me: missing_auth with no token", () => {
  const cases: Array<[string, Record<string, string | undefined>]> = [
    ["absent", {}],
    ["empty string", { GROUPME_ACCESS_TOKEN: "" }],
  ];
  for (const [label, config] of cases) {
    it(`raises missing_auth with zero network calls when the token is ${label}`, async () => {
      const spy = stubFetch(async () => envelope(PROFILE));
      let error: unknown;
      try {
        await me.handler({}, makeContext(config));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GroupMeError);
      expect((error as GroupMeError).code).toBe("missing_auth");
      expect(spy).not.toHaveBeenCalled();
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    });
  }
});

describe("me: error taxonomy through the operation", () => {
  it("surfaces the client's redacted auth_error for a 401", async () => {
    stubFetch(async () => new Response("{}", { status: 401 }));
    let error: unknown;
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("auth_error");
  });

  it("treats a 304 as malformed_response for /users/me (end-of-history is meaningless here)", async () => {
    stubFetch(async () => new Response(null, { status: 304 }));
    let error: unknown;
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      error = caught;
    }
    expect((error as GroupMeError).code).toBe("malformed_response");
  });
});

describe("me: output validation (T05 regressions)", () => {
  it("rejects a 200 whose id is a nested object instead of a string", async () => {
    stubFetch(async () => envelope({ ...PROFILE, id: { email: "fake@example.invalid" } }));
    let error: unknown;
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("malformed_response");
    expect(JSON.stringify(error)).not.toContain("fake@example.invalid");
  });

  it("rejects wrong field types (numeric name, string timestamps)", async () => {
    stubFetch(async () =>
      envelope({ ...PROFILE, name: 42, created_at: "1600000000", updated_at: "1700000000" }),
    );
    let error: unknown;
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      error = caught;
    }
    expect((error as GroupMeError).code).toBe("malformed_response");
  });

  it("rejects a payload missing required fields", async () => {
    stubFetch(async () => envelope({ id: "1" }));
    let error: unknown;
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      error = caught;
    }
    expect((error as GroupMeError).code).toBe("malformed_response");
  });

  it("rejects an array or null inner response", async () => {
    for (const inner of [[PROFILE], null]) {
      stubFetch(async () => envelope(inner));
      let error: unknown;
      try {
        await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
      } catch (caught) {
        error = caught;
      }
      expect((error as GroupMeError).code).toBe("malformed_response");
    }
  });

  it("preserves the valid profile shape and PII omission through validation", async () => {
    stubFetch(async () => envelope(PROFILE));
    const result = await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    me.output!.parse(result);
    expect(result).toEqual({
      id: "1234567890",
      name: "Test User",
      image_url: "https://i.groupme.com/avatars/test.jpeg",
      created_at: 1600000000,
      updated_at: 1700000000,
    });
    expect(JSON.stringify(result)).not.toContain(PHONE);
    expect(JSON.stringify(result)).not.toContain(EMAIL);
  });
});

describe("me: non-disclosure across every scenario", () => {
  it("the fixture token appears in no serialized result or error", async () => {
    const observations: string[] = [];
    const spy = stubFetch(async () => envelope(PROFILE));
    try {
      observations.push(JSON.stringify(await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }))));
    } catch (caught) {
      observations.push(JSON.stringify(caught));
    }
    spy.mockImplementation(async () => new Response("{}", { status: 403 }));
    try {
      await me.handler({}, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN }));
    } catch (caught) {
      observations.push(JSON.stringify(caught));
    }
    for (const serialized of observations) {
      expect(serialized).not.toContain(TOKEN);
    }
  });
});
