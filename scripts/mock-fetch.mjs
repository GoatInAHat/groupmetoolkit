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
  // group_messages happy path: 3 rows in server order (55 oldest -> 53 newest).
  // 3 rows is a SHORT page for any limit > 3, so a before_id request truthfully reaches
  // end-of-history (D012). Id 53 is attachment-only (no text key, location attachment),
  // id 54 is image attachment with text:null.
  messages: {
    status: 200,
    body: {
      meta: { count: 3, code: 200, errors: [] },
      response: {
        count: 3,
        messages: [
          { id: "55", created_at: 1700000099, name: "alice", text: "hi", attachments: [] },
          {
            id: "54",
            created_at: 1700000098,
            name: "bob",
            text: null,
            attachments: [{ type: "image", url: "https://i.groupme.com/x.jpeg" }],
          },
          {
            id: "53",
            created_at: 1700000097,
            name: "carol",
            attachments: [{ type: "location", lat: "40.7", lng: "-74.0", name: "here" }],
          },
        ],
      },
    },
  },
  // group_messages end of history: upstream 304 with no body. The client maps this to a
  // success-shaped endOfHistory result before reading any body, never an error.
  messagesEndOfHistory: {
    status: 304,
    body: null,
  },
};

if (process.env.SMOKE_GROUPME_FIXTURE) {
  const fixture = fixtures[process.env.SMOKE_GROUPME_FIXTURE];
  if (!fixture) {
    console.error(`mock-fetch: unknown SMOKE_GROUPME_FIXTURE ${process.env.SMOKE_GROUPME_FIXTURE}`);
    process.exit(1);
  }
  globalThis.fetch = async () => {
    // A 304 must carry no body: Response(null) is the only status-legal construction.
    if (fixture.body === null) return new Response(null, { status: fixture.status });
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: { "content-type": "application/json" },
    });
  };
}
