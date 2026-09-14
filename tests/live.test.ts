// Author-owned live test (D006): runs only when GROUPME_ACCESS_TOKEN is present in the
// environment (`npm run test:live` loads .env when it exists). Silently skipped otherwise,
// so the mock tier (`npm test`) never talks to the real GroupMe API.
import { describe, expect, it } from "vitest";
import { operations } from "../src/ops.js";
import { context } from "../src/toolfactory/config.js";

const token = process.env.GROUPME_ACCESS_TOKEN;

describe.skipIf(!token)("live: me against the real GroupMe API", () => {
  it("returns the authenticated profile without leaking the token", async () => {
    const me = operations.find((op) => op.name === "me");
    if (!me || !me.output) throw new Error("me operation missing from operations");
    const result = await me.handler({}, context());
    // The declared output contract must hold against the real payload.
    me.output.parse(result);
    expect(result.id).toBeTruthy();
    expect(typeof result.name).toBe("string");
    expect(typeof result.created_at).toBe("number");
    expect(typeof result.updated_at).toBe("number");
    // Non-disclosure: the token must not survive into the returned profile.
    expect(JSON.stringify(result)).not.toContain(token!);
  });
});
