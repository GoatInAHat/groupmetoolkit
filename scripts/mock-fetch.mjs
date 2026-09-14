#!/usr/bin/env node
// Test-only fetch mock (loaded via NODE_OPTIONS="--import .../mock-fetch.mjs") for CLI
// smoke runs. Never imported by src/. When SMOKE_GROUPME_FIXTURE is set, replaces
// globalThis.fetch with a canned GroupMe v3 responder; otherwise leaves fetch untouched.
// Fixtures use the canary token TESTTOKEN_SHOULD_NEVER_LEAK so smokes can assert it never
// reaches any output.

const canary = "TESTTOKEN_SHOULD_NEVER_LEAK";

const fixtures = {
  // groups happy path with omit=memberships: the members key is present but null.
  groups: {
    status: 200,
    body: {
      meta: { code: 200, errors: [] },
      response: [
        {
          id: "1111",
          name: "Smoke Group",
          type: "private",
          description: null,
          image_url: null,
          share_url: null,
          creator_user_id: "777",
          created_at: 1700000000,
          updated_at: 1700000100,
          members: null,
          messages: {
            count: 3,
            last_message_id: "55",
            last_message_created_at: 1700000099,
            preview: { nickname: "alice", text: "hi", image_url: null, attachments: [] },
          },
        },
      ],
    },
  },
  // Unknown group id: upstream 404, redacted by the client into not_found.
  groupNotFound: {
    status: 404,
    body: { meta: { code: 404, errors: [`group ${canary} not found`] } },
  },
};

if (process.env.SMOKE_GROUPME_FIXTURE) {
  const fixture = fixtures[process.env.SMOKE_GROUPME_FIXTURE];
  if (!fixture) {
    console.error(`mock-fetch: unknown SMOKE_GROUPME_FIXTURE ${process.env.SMOKE_GROUPME_FIXTURE}`);
    process.exit(1);
  }
  globalThis.fetch = async () =>
    new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    });
}
