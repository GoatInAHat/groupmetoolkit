---
name: groupmetoolkit
description: Read-only GroupMe account tools usable from OpenClaw without a
  connected MacBook.
---

# groupmetoolkit

Explain here when an agent should reach for this tool and how to combine its operations.

<!-- tf:operations -->
## Operations

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

<!-- /tf:operations -->
