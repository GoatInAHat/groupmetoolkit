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
  // chats happy path: one DM conversation. other_user.id is NUMERIC (as in the official
  // example) and must be normalized to the string "777"; last_message carries text:null
  // plus an image attachment and the upstream-only conversation keys (sender_id,
  // recipient_id, conversation_id) which projection must drop from the result.
  chats: {
    status: 200,
    body: {
      meta: { code: 200, errors: [] },
      response: [
        {
          id: "chat-abc",
          created_at: 1700000000,
          updated_at: 1700000500,
          other_user: { id: 777, name: "Dana", image_url: "https://i.groupme.com/avatars/d.jpeg" },
          last_message: {
            id: "msg-1",
            sender_id: "777",
            recipient_id: "111",
            conversation_id: "chat-abc",
            created_at: 1700000499,
            name: "Dana",
            text: null,
            attachments: [{ type: "image", url: "https://i.groupme.com/x.jpeg" }],
          },
        },
      ],
    },
  },
  // chats with no conversations: a bare empty array (no total anywhere in the payload).
  chatsEmpty: {
    status: 200,
    body: { meta: { code: 200, errors: [] }, response: [] },
  },
  // search_group_messages budget probe (MEM021): page 1 is a FULL page of 100 descending
  // rows (ids 300..201, alternating text alpha/beta). Page 2 is also FULL (ids 200..101,
  // all "alpha"), so a budget of 105 / limit 100 examines 100 + 5 rows and stops with 95
  // rows of page 2 unexamined: the scan is budget-limited, NOT exhausted, so endOfHistory
  // is false and warnings carry budget_exhausted. nextBeforeId is the oldest EXAMINED row
  // of page 2 (id 196), never a row the scan did not examine.
  searchPages: {
    pages: [
      { status: 200, body: searchPageBody(300, 201, (offset) => (offset % 2 === 0 ? "alpha" : "beta")) },
      { status: 200, body: searchPageBody(200, 101, () => "alpha") },
    ],
  },
  // search_group_messages: a single SHORT page (3 rows). The scan is genuinely exhausted
  // after the first page: endOfHistory true and nextBeforeId null.
  searchShort: {
    pages: [{ status: 200, body: searchPageBody(50, 48, () => "nothing here") }],
  },
  // search_group_messages: a FULL page followed by upstream 304. A short page would have
  // ended the scan on its own, so the first page must be full for the 304 to be reached
  // (limit 3 -> ids 60..58). The 304 proves end-of-history: endOfHistory true, no next page.
  searchEndOfHistory: {
    pages: [
      { status: 200, body: searchPageBody(60, 58, () => "gamma") },
      { status: 304, body: null },
    ],
  },
};

/** One official-shape /messages page: {meta:{count}, response:{count, messages}} descending. */
function searchPageBody(firstId, lastId, textForOffset) {
  const messages = [];
  for (let id = firstId, offset = 0; id >= lastId; id--, offset++) {
    messages.push({
      id: String(id),
      created_at: id * 10,
      name: offset % 2 === 0 ? "alice" : "bob",
      text: textForOffset(offset),
      attachments: [],
    });
  }
  return { meta: { count: messages.length, code: 200, errors: [] }, response: { count: messages.length, messages } };
}

if (process.env.SMOKE_GROUPME_FIXTURE) {
  const fixture = fixtures[process.env.SMOKE_GROUPME_FIXTURE];
  if (!fixture) {
    console.error(`mock-fetch: unknown SMOKE_GROUPME_FIXTURE ${process.env.SMOKE_GROUPME_FIXTURE}`);
    process.exit(1);
  }

  // A single-page fixture answers every fetch identically. A `pages` fixture is consumed in
  // call order by one bounded scan; past the end it answers 304 (no more history), the same
  // as GroupMe's documented before_id end-of-history response.
  const single = () => fixture;
  let pageIndex = 0;
  const sequence = () => {
    const page = fixture.pages[pageIndex];
    pageIndex += 1;
    return page ?? { status: 304, body: null };
  };
  const next = Array.isArray(fixture.pages) ? sequence : single;

  globalThis.fetch = async () => {
    const { status, body } = next();
    // A 304 must carry no body: Response(null) is the only status-legal construction.
    if (body === null) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}
