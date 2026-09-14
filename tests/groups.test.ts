// Mock-tier tests for the `groups` and `group` operations (src/ops.ts). Zero real
// network: the handler's global fetch is stubbed with a spy; the fixture token
// TESTTOKEN_SHOULD_NEVER_LEAK must never appear in any result or error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupMeError } from "../src/groupme/client.js";
import { operations } from "../src/ops.js";
import type { Context } from "../src/toolfactory/types.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";

const groups = operations.find((op) => op.name === "groups");
const group = operations.find((op) => op.name === "group");
if (!groups || !groups.output) throw new Error("groups operation missing from operations");
if (!group || !group.output) throw new Error("group operation missing from operations");

const MEMBER = {
  user_id: "1111111",
  nickname: "Tester",
  muted: false,
  image_url: "https://i.groupme.com/avatars/t.jpeg",
};

const GROUP = {
  id: "9876543210",
  name: "Test Group",
  type: "private",
  description: "A test group",
  image_url: "https://i.groupme.com/groups/g.jpeg",
  share_url: "https://groupme.com/join_group/9876543210/abc",
  creator_user_id: "1111111",
  created_at: 1600000000,
  updated_at: 1700000000,
  members: [MEMBER],
  messages: {
    count: 2,
    last_message_id: "5555555555",
    last_message_created_at: 1690000000,
    preview: {
      nickname: "Tester",
      text: "hello",
      image_url: null,
      attachments: [],
    },
  },
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

async function callOrError(
  op: { handler: (args: unknown, ctx: Context) => Promise<unknown> },
  args: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  try {
    return { result: await op.handler(args, makeContext({ GROUPME_ACCESS_TOKEN: TOKEN })) };
  } catch (caught) {
    return { error: caught };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("groups: mocked index read", () => {
  it("projects groups and accepts members present as null with omit=memberships", async () => {
    const spy = stubFetch(async () => envelope([{ ...GROUP, members: null }]));
    const { result, error } = await callOrError(groups, { omit: "memberships" });
    expect(error).toBeUndefined();
    const data = result as { count: number; groups: Array<{ members: unknown }> };
    expect(data.count).toBe(1);
    expect(data.groups[0].members).toBeNull();
    groups.output!.parse(result);
    // omit=memberships was sent as a query param; the token went in the header only.
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groupme.com/v3/groups?omit=memberships");
    expect((init.headers as Record<string, string>)["X-Access-Token"]).toBe(TOKEN);
    expect(url).not.toContain(TOKEN);
  });

  it("echoes page/per_page and never emits total or hasMore", async () => {
    stubFetch(async () => envelope([GROUP]));
    const { result, error } = await callOrError(groups, { page: 2, per_page: 25 });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ page: 2, perPage: 25, count: 1 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("\"total\"");
    expect(serialized).not.toContain("hasMore");
    groups.output!.parse(result);
  });

  it("maps a non-array inner response to malformed_response", async () => {
    stubFetch(async () => envelope({ groups: [] }));
    const { error } = await callOrError(groups, {});
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("malformed_response");
  });

  it("rejects omit values other than the enum's single member without a network call", async () => {
    const spy = stubFetch(async () => envelope([GROUP]));
    let thrown: unknown;
    try {
      groups.input!.parse({ omit: "members" });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a group element failing the shape to malformed_response", async () => {
    stubFetch(async () => envelope([{ ...GROUP, name: 42 }]));
    const { error } = await callOrError(groups, {});
    expect((error as GroupMeError).code).toBe("malformed_response");
  });
});

describe("group: mocked detail read", () => {
  it("returns the projected group shape", async () => {
    const spy = stubFetch(async () => envelope(GROUP));
    const { result, error } = await callOrError(group, { id: "9876543210" });
    expect(error).toBeUndefined();
    group.output!.parse(result);
    expect(result).toEqual(GROUP);
    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groupme.com/v3/groups/9876543210");
  });

  it("maps an unknown id (404) to a redacted not_found with no token", async () => {
    stubFetch(async () => new Response("{}", { status: 404 }));
    const { error } = await callOrError(group, { id: "1" });
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("not_found");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("rejects a non-numeric id with zero network calls", async () => {
    const spy = stubFetch(async () => envelope(GROUP));
    let thrown: unknown;
    try {
      group.input!.parse({ id: "abc; drop" });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a non-object inner response to malformed_response", async () => {
    stubFetch(async () => envelope([GROUP]));
    const { error } = await callOrError(group, { id: "9876543210" });
    expect((error as GroupMeError).code).toBe("malformed_response");
  });

  it("maps a 304 to malformed_response (end-of-history is meaningless for a detail read)", async () => {
    stubFetch(async () => new Response(null, { status: 304 }));
    const { error } = await callOrError(group, { id: "9876543210" });
    expect((error as GroupMeError).code).toBe("malformed_response");
  });
});

describe("token non-disclosure and config-driven auth", () => {
  it("the fixture token never appears in any serialized result or error", async () => {
    const observations: string[] = [];
    stubFetch(async () => envelope([GROUP]));
    const groupsOutcome = await callOrError(groups, { page: 1, per_page: 10 });
    observations.push(JSON.stringify(groupsOutcome.result ?? groupsOutcome.error));
    stubFetch(async () => envelope(GROUP));
    const groupOutcome = await callOrError(group, { id: "9876543210" });
    observations.push(JSON.stringify(groupOutcome.result ?? groupOutcome.error));
    stubFetch(async () => new Response("{}", { status: 404 }));
    const notFound = await callOrError(group, { id: "42" });
    observations.push(JSON.stringify(notFound.error));
    for (const serialized of observations) {
      expect(serialized).not.toContain(TOKEN);
    }
  });

  it("missing_auth with zero network calls when the token is absent from config (MEM014)", async () => {
    delete process.env["GROUPME_ACCESS_TOKEN"];
    const spy = stubFetch(async () => envelope([GROUP]));
    let error: unknown;
    try {
      await groups.handler({}, makeContext({}));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GroupMeError);
    expect((error as GroupMeError).code).toBe("missing_auth");
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});
