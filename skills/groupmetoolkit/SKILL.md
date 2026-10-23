---
name: groupmetoolkit
description: Read-only GroupMe account tools usable from OpenClaw without a
  connected MacBook.
---

# groupmetoolkit

Explain here when an agent should reach for this tool and how to combine its operations.

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
