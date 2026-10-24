---
name: groupmetoolkit
description: Read-only GroupMe account tools usable from OpenClaw without a
  connected MacBook.
---

# groupmetoolkit

Read GroupMe account data — the authenticated profile, the group list, one group, direct-message
conversations, a group's message history, and a bounded search over that history — without
mutating anything. Every operation is read-only and returns redacted, structured metadata;
nothing is persisted. Reach for these operations when a question is answered by "what does this
GroupMe account contain right now", not by "change it": there is no create, update, delete, post
or send operation here. Combine them by resolving an id with `groups` or `chats` first, then
reading with `group`, `group_messages` or `search_group_messages`.

## Authentication: the vault-only token route

All operations authenticate with `GROUPME_ACCESS_TOKEN`. That value is a **sensitive** Tool
Factory config input and it is **vault-only**: hosts inject it from their vault, never from a
chat message, a prompt, a committed `.env`, a GitHub Actions secret, a fixture, a log line or an
error payload. Core never acquires a credential by itself.

- Consumed through exactly one mechanism: `context().config["GROUPME_ACCESS_TOKEN"]` inside the
  operations — never from `process.env`, a file, an argument or a literal. Each operation
  passes that value straight to the client, so the token crosses no other boundary.
- Sent at exactly one place: the single `X-Access-Token` request header built in
  `src/groupme/client.ts` for a GET to the fixed official host `https://api.groupme.com` —
  never in a URL or query string, never as an `Authorization` header, never as `Bearer`.
- Never appears in URLs, logs, errors, fixtures or outputs. Errors are redacted structured
  envelopes: `GroupMeError.message` IS the JSON `{"code":...}` text, upstream `meta.errors`
  entries are scrubbed of the request token, and diagnostic causes have the token scrubbed
  before attachment, so a host that serializes causes cannot leak it either.
- With no token configured, every operation fails closed with the structured code
  `missing_auth` — decided **before the first fetch**, so there is no network call at all.
  Every other failure mode is a distinct redacted code (`auth_error`, `not_found`,
  `rate_limited`, `upstream_error`, `network_error`, `redirect_blocked`,
  `malformed_response`).

An agent must never ask a user to paste a token into a conversation: a token typed in chat is
already disclosed. If one is shared that way, treat it as compromised and rotate it. Configure it
through the host's vault-backed config instead, and let the host inject it.

One-time setup is vault-only, either of:

- the native masked OpenClaw secret collection (prompted entry, never echoed), or
- a local no-echo terminal prompt piped directly into the store:

  ```sh
  read -rs GROUPME_ACCESS_TOKEN
  printf '%s' "$GROUPME_ACCESS_TOKEN" | openclaw secrets store set GROUPME_ACCESS_TOKEN --kind secret --allow-host api.groupme.com --value-file -
  ```

A token is never typed into chat and never written to a file, and `toolfactory bootstrap-repo`
is never used for secrets.

The route is enforced, not just documented: `npm run test:token-route`
(`scripts/check-token-leak.mjs`, run `npm run build` first) asserts that every read of the token
is the `ctx.config` lookup (allowing only `src/ops.ts` and the generated host-injection
boundary `src/toolfactory/config.ts`), the single send site, that no token-shaped query
parameter exists in `src/`, and that every upstream
error surface — message, `errors` list and attached cause — is scrubbed of a sentinel token when
`fetch` is stubbed to echo it. If you are changing how a request is built or how an error is
formed, run it: it fails when a token value could reach a URL, a log, an error or an output.

<!-- tf:operations -->
## Operations

### chats

List the authenticated user's direct-message conversations from the documented GroupMe /chats index, with pagination. Returns page, perPage, a count and the projected chats (other_user and last_message). perPage echoes only a caller-supplied per_page and is 0 when omitted: the API documents no default and no total, so no effective value is guessed. Deliberately no total, hasMore or nextPage.

Arguments: `page`, `per_page`.

`groupmetoolkit chats --json '<arguments>'` prints a JSON result. MCP tool `chats` on server `groupmetoolkit` returns the same result as `structuredContent`.

### group

Return one GroupMe group by numeric id. An unknown id surfaces a redacted not_found error; the payload is projected to the declared group shape.

Arguments: `id`.

`groupmetoolkit group --json '<arguments>'` prints a JSON result. MCP tool `group` on server `groupmetoolkit` returns the same result as `structuredContent`.

### group_messages

Read one page of a GroupMe group's message history: projected message ids, timestamps, author names, text and attachments. Supply at most one cursor (before_id = older history, after_id = immediate newer, since_id = newest only); limit is clamped to the official max of 100 (default 20). Pagination metadata is direction-scoped: endOfHistory is only claimed for before_id/latest pages on upstream 304 or a short page, and a non-advancing cursor stops with progressGuardTripped. Nothing is persisted.

Arguments: `group_id`, `before_id`, `after_id`, `since_id`, `limit`.

`groupmetoolkit group_messages --json '<arguments>'` prints a JSON result. MCP tool `group_messages` on server `groupmetoolkit` returns the same result as `structuredContent`.

### groups

List the authenticated user's GroupMe groups with pagination. Returns the validated page/per-page echo, a count, and the projected groups. Deliberately no total or hasMore: a bare-array index has no total, and a full page only implies an unknown next page, never a confirmed one.

Arguments: `page`, `per_page`, `omit`.

`groupmetoolkit groups --json '<arguments>'` prints a JSON result. MCP tool `groups` on server `groupmetoolkit` returns the same result as `structuredContent`.

### me

Return the authenticated GroupMe profile: id, name, avatar URL, and timestamps. Phone number and email are never returned.

`groupmetoolkit me --json '<arguments>'` prints a JSON result. MCP tool `me` on server `groupmetoolkit` returns the same result as `structuredContent`.

### search_group_messages

Search one GroupMe group's message history for a case-insensitive text substring. GroupMe v3 has no server-side search, so this is a client-side bounded scan: it pages backward with before_id, examines at most `budget` messages (clamped to 500, default 100) in pages of `limit` (clamped to 100, default 20), and stops when it has `maxMatches` matches (clamped to 100, default 25). Returns scanned/matched/pagesFetched with truthful metadata: endOfHistory is true only on upstream 304, an empty page or a short page, never when the budget or match cap stopped the scan; warnings names exactly why it stopped (budget_exhausted, match_cap_reached, progress_guard_tripped) and nextBeforeId is the last examined message id, so a continuation never skips unexamined messages. Matches only message text; attachment-only messages never match. Nothing is persisted.

Arguments: `group_id`, `query`, `before_id`, `limit`, `budget`, `maxMatches`.

`groupmetoolkit search_group_messages --json '<arguments>'` prints a JSON result. MCP tool `search_group_messages` on server `groupmetoolkit` returns the same result as `structuredContent`.

<!-- /tf:operations -->
