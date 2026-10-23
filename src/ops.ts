import { z } from "zod";
import { groupmeFetch, GroupMeError } from "./groupme/client.js";
import { operation } from "./toolfactory/types.js";

/**
 * groupmetoolkit operations: pure functions of (arguments, context.config, filesystem).
 * All GroupMe access goes through the shared client in src/groupme/client.ts; the token is
 * read only from context().config["GROUPME_ACCESS_TOKEN"] (D002) and only ever reaches the
 * client's X-Access-Token header.
 */

const meOutput = z.object({
  id: z.string(),
  name: z.string(),
  image_url: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const groupIdSchema = z.string().regex(/^\d+$/);

const groupMemberShape = z.object({
  user_id: z.string(),
  nickname: z.string(),
  muted: z.boolean(),
  image_url: z.string().nullable().optional(),
});

export const groupShape = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["private", "public"]),
  description: z.string().nullable(),
  image_url: z.string().nullable(),
  share_url: z.string().nullable(),
  creator_user_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  members: z.array(groupMemberShape).nullable(),
  messages: z.object({
    count: z.number(),
    last_message_id: z.string(),
    last_message_created_at: z.number(),
    preview: z.object({
      nickname: z.string(),
      text: z.string().nullable(),
      image_url: z.string().nullable(),
      attachments: z.array(z.unknown()),
    }),
  }),
});

/**
 * A GroupMe message projected to the requirement-named subset (R003). Exported for S04's
 * search reuse. Plain z.object (not strict) so extra upstream fields (sender_id,
 * conversation_id, fwd_count, ...) are dropped by projection, matching groupShape.
 * `name` is the author display name (GroupMe's own field name); `text` is absent or null
 * for attachment-only messages; `attachments` is polymorphic (image/location/split/emoji)
 * and passes through unvalidated.
 */
export const messageShape = z.object({
  id: z.string(),
  created_at: z.number(),
  name: z.string(),
  text: z.string().nullable().optional(),
  attachments: z.array(z.unknown()),
});

const CURSOR_KEYS = ["before_id", "after_id", "since_id"] as const;
type CursorKey = (typeof CURSOR_KEYS)[number];
type Direction = "before" | "after" | "since" | "latest";

/** The input schema the generated CLI/MCP surfaces parse; exported so tests can import it. */
export const groupMessagesInput = z.object({
  group_id: groupIdSchema,
  before_id: z.string().min(1).optional(),
  after_id: z.string().min(1).optional(),
  since_id: z.string().min(1).optional(),
  // Deliberately no .max(): the generated CLI parses this schema BEFORE the handler, so a
  // .max(100) would REJECT instead of clamp. The clamp (D011) happens in the handler.
  limit: z.number().int().optional(),
});

export const groupMessagesOutput = z.object({
  group_id: z.string(),
  messages: z.array(messageShape),
  /** Effective requested page size after the official max-100 clamp. */
  limit: z.number().int().positive(),
  /** True only when an explicit limit above 100 was clamped to 100. */
  limitClamped: z.boolean(),
  pagination: z.object({
    direction: z.enum(["before", "after", "since", "latest"]),
    hasContinuation: z.boolean(),
    endOfHistory: z.boolean(),
    nextBeforeId: z.string().nullable(),
    nextAfterId: z.string().nullable(),
    progressGuardTripped: z.boolean(),
    upstreamCount: z.number().nullable(),
  }),
  warnings: z.array(z.string()),
});

const OFFICIAL_MESSAGES_MAX_LIMIT = 100;
const OFFICIAL_MESSAGES_DEFAULT_LIMIT = 20;

/** Numeric comparison for GroupMe ids, which are decimal strings wider than Number can hold. */
function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const trimmedA = a.replace(/^0+(?=\d)/, "");
    const trimmedB = b.replace(/^0+(?=\d)/, "");
    if (trimmedA.length !== trimmedB.length) return trimmedA.length < trimmedB.length ? -1 : 1;
    return trimmedA === trimmedB ? 0 : trimmedA < trimmedB ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

/** The at-most-one-cursor rule: the official semantics of combined cursors are undocumented. */
function singleCursor(args: Record<string, unknown>): { key: CursorKey; value: string } | null {
  const present = CURSOR_KEYS.filter((key) => args[key] !== undefined);
  if (present.length === 0) return null;
  if (present.length > 1) {
    // Local validation, before any fetch. The message names every conflicting key so a
    // caller can correct the request without guessing.
    // A local validation error, not a GroupMeError: the client's closed code union describes
    // upstream fetch outcomes, and this never reaches the network. The message is the same
    // redacted JSON envelope shape every surface prints verbatim, plus the conflicting keys.
    throw new Error(
      JSON.stringify({
        code: "invalid_input",
        detail: `conflicting cursors: ${present.join(", ")}; supply at most one of before_id, after_id, since_id`,
      }),
    );
  }
  const key = present[0];
  return { key, value: String(args[key]) };
}

const groupsInput = z.object({
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().optional(),
  omit: z.enum(["memberships"]).optional(),
});

const groupOutput = z.object({
  page: z.number().int().positive(),
  perPage: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  groups: z.array(groupShape),
});

function expectArrayResponse(inner: unknown, status: number): unknown[] {
  if (status === 304 || !Array.isArray(inner)) {
    throw new GroupMeError({ code: "malformed_response", status });
  }
  return inner;
}

function projectGroup(inner: unknown, status: number): z.infer<typeof groupShape> {
  if (status === 304 || inner === null || typeof inner !== "object") {
    throw new GroupMeError({ code: "malformed_response", status });
  }
  // Project to the declared subset, then validate — a 200 whose payload fails the
  // shape is malformed_response, never a successful object with holes. Zod issue
  // text is upstream-derived, so only the redacted envelope is surfaced.
  const projection = groupShape.safeParse(inner);
  if (!projection.success) {
    throw new GroupMeError({ code: "malformed_response", status });
  }
  return projection.data;
}

export const operations = [
  operation({
    name: "me",
    description:
      "Return the authenticated GroupMe profile: id, name, avatar URL, and timestamps. Phone number and email are never returned.",
    input: z.object({}),
    output: meOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    requires: ["net"],
    handler: async (_args, ctx) => {
      const result = await groupmeFetch({
        fetchImpl: fetch,
        token: ctx.config["GROUPME_ACCESS_TOKEN"],
        path: "/users/me",
      });
      if (result.endOfHistory) {
        // 304 is meaningful for message queries (S03), never for /users/me.
        throw new GroupMeError({ code: "malformed_response", status: 304 });
      }
      if (result.response === null || typeof result.response !== "object") {
        throw new GroupMeError({ code: "malformed_response", status: result.status });
      }
      const profile = result.response as Record<string, unknown>;
      // Project to the declared subset: phone_number/email (PII) are dropped here, then the
      // projection is validated against the declared output schema — a 200 whose payload is
      // missing required fields or carries wrong types is a malformed_response, never a
      // successful object with holes. Zod's issue text is upstream-derived, so the failure
      // is redacted: only the redacted JSON envelope is surfaced.
      const projection = meOutput.safeParse({
        id: profile["id"],
        name: profile["name"],
        image_url: profile["image_url"],
        created_at: profile["created_at"],
        updated_at: profile["updated_at"],
      });
      if (!projection.success) {
        throw new GroupMeError({ code: "malformed_response", status: result.status });
      }
      return projection.data;
    },
  }),
  operation({
    name: "groups",
    description:
      "List the authenticated user's GroupMe groups with pagination. Returns the validated page/per-page echo, a count, and the projected groups. Deliberately no total or hasMore: a bare-array index has no total, and a full page only implies an unknown next page, never a confirmed one.",
    input: groupsInput,
    output: groupOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    requires: ["net"],
    handler: async (args, ctx) => {
      const input = groupsInput.parse(args);
      const result = await groupmeFetch({
        fetchImpl: fetch,
        token: ctx.config["GROUPME_ACCESS_TOKEN"],
        path: "/groups",
        query: { page: input.page, per_page: input.per_page, omit: input.omit },
      });
      const inner = expectArrayResponse(result.response, result.status);
      const groups = inner.map((element) => projectGroup(element, result.status));
      // Truthful metadata only: the validated echo and the actual count. Never total
      // or hasMore — we cannot know either from a bare array.
      // Official GET /groups default per_page is 10 (dev.groupme.com/docs/v3#groups_index);
      // the omitted-input page size is that constant, never the observed row count.
      return {
        page: input.page ?? 1,
        perPage: input.per_page ?? 10,
        count: groups.length,
        groups,
      };
    },
  }),
  operation({
    name: "group",
    description:
      "Return one GroupMe group by numeric id. An unknown id surfaces a redacted not_found error; the payload is projected to the declared group shape.",
    input: z.object({ id: groupIdSchema }),
    output: groupShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    requires: ["net"],
    handler: async (args, ctx) => {
      const input = z.object({ id: groupIdSchema }).parse(args);
      const result = await groupmeFetch({
        fetchImpl: fetch,
        token: ctx.config["GROUPME_ACCESS_TOKEN"],
        path: `/groups/${input.id}`,
      });
      // A 404 from the client is already a redacted not_found GroupMeError.
      return projectGroup(result.response, result.status);
    },
  }),
  operation({
    name: "group_messages",
    description:
      "Read one page of a GroupMe group's message history: projected message ids, timestamps, author names, text and attachments. Supply at most one cursor (before_id = older history, after_id = immediate newer, since_id = newest only); limit is clamped to the official max of 100 (default 20). Pagination metadata is direction-scoped: endOfHistory is only claimed for before_id/latest pages on upstream 304 or a short page, and a non-advancing cursor stops with progressGuardTripped. Nothing is persisted.",
    input: groupMessagesInput,
    output: groupMessagesOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    requires: ["net"],
    handler: async (args, ctx) => {
      const input = groupMessagesInput.parse(args);
      // The cursor-conflict rejection runs BEFORE any fetch: the official semantics of
      // combined cursors are undocumented, so inventing a precedence is forbidden.
      const cursor = singleCursor(args as Record<string, unknown>);
      const direction: Direction = cursor === null ? "latest" : cursor.key === "before_id" ? "before" : cursor.key === "after_id" ? "after" : "since";

      // Limit clamp (D011), derived from the RAW handler arguments: the generated CLI runs
      // op.input.parse before the handler, so the schema deliberately has no .max(100).
      const warnings: string[] = [];
      const rawLimitValue = (args as Record<string, unknown>)["limit"];
      const rawLimit = Number(rawLimitValue);
      const rawLimitValid = Number.isInteger(rawLimit) && rawLimit > 0;
      const effectiveLimit = rawLimitValid ? Math.min(rawLimit, OFFICIAL_MESSAGES_MAX_LIMIT) : OFFICIAL_MESSAGES_DEFAULT_LIMIT;
      const limitClamped = rawLimitValid && effectiveLimit !== rawLimit;
      if (rawLimitValue !== undefined && !rawLimitValid) warnings.push("limit_invalid_defaulted_20");

      const result = await groupmeFetch({
        fetchImpl: fetch,
        token: ctx.config["GROUPME_ACCESS_TOKEN"],
        path: `/groups/${input.group_id}/messages`,
        query: { before_id: cursor?.key === "before_id" ? cursor.value : undefined, after_id: cursor?.key === "after_id" ? cursor.value : undefined, since_id: cursor?.key === "since_id" ? cursor.value : undefined, limit: effectiveLimit },
      });

      const base = {
        group_id: input.group_id,
        limit: effectiveLimit,
        limitClamped,
        warnings,
      };

      // 304 is end-of-history, never an error (D005). For after_id/since_id it only means
      // "no newer messages" — it proves nothing about the beginning of history (D012).
      if (result.endOfHistory) {
        const exhausted = direction === "before" || direction === "latest";
        return {
          ...base,
          messages: [],
          pagination: {
            direction,
            hasContinuation: !exhausted,
            endOfHistory: exhausted,
            nextBeforeId: null,
            nextAfterId: null,
            progressGuardTripped: false,
            upstreamCount: null,
          },
        };
      }

      const inner = result.response;
      if (inner === null || typeof inner !== "object") {
        throw new GroupMeError({ code: "malformed_response", status: result.status });
      }
      const envelope = inner as Record<string, unknown>;
      const rawMessages = envelope["messages"];
      if (!Array.isArray(rawMessages)) {
        throw new GroupMeError({ code: "malformed_response", status: result.status });
      }
      // Project to the declared subset, then validate — a page with any failing element is
      // malformed_response, never a successful page with holes. Zod issue text is
      // upstream-derived, so only the redacted envelope is surfaced.
      const messages: Array<z.infer<typeof messageShape>> = [];
      for (const element of rawMessages) {
        const projection = messageShape.safeParse(element);
        if (!projection.success) {
          throw new GroupMeError({ code: "malformed_response", status: result.status });
        }
        messages.push(projection.data);
      }

      const rawCount = envelope["count"];
      const upstreamCount = typeof rawCount === "number" && Number.isFinite(rawCount) ? rawCount : null;
      if (upstreamCount !== null && upstreamCount !== messages.length) warnings.push("meta_count_mismatch");

      // Server order is preserved: GroupMe returns descending for before_id and ascending
      // for after_id/since_id, so the first element is the oldest examined and the last is
      // the newest examined.
      const oldest = messages.length > 0 ? messages[0].id : null;
      const newest = messages.length > 0 ? messages[messages.length - 1].id : null;

      // Progress guard: a request-supplied cursor must have moved. Only one fetch happens,
      // so tripping the guard stops the page rather than looping.
      let progressGuardTripped = false;
      if (cursor !== null && messages.length > 0 && oldest !== null && newest !== null) {
        if (cursor.key === "before_id") {
          progressGuardTripped = compareIds(oldest, cursor.value) >= 0;
        } else if (cursor.key === "after_id") {
          progressGuardTripped = compareIds(newest, cursor.value) <= 0;
        } else {
          // since_id returns newest-only ascending messages; any returned id older than or
          // equal to the cursor means the window did not advance.
          progressGuardTripped = compareIds(newest, cursor.value) <= 0 || compareIds(oldest, cursor.value) <= 0;
        }
      }

      let endOfHistory = false;
      let hasContinuation = false;
      if (progressGuardTripped) {
        endOfHistory = false;
        hasContinuation = false;
      } else if (direction === "before" || direction === "latest") {
        // Exhausted at the oldest end: an empty page (no messages at all) or a short page.
        const exhausted = messages.length === 0 || messages.length < effectiveLimit;
        endOfHistory = exhausted;
        hasContinuation = !exhausted;
      } else {
        // after_id / since_id prove only "no newer messages": always continuable.
        endOfHistory = false;
        hasContinuation = true;
        if (direction === "since" && messages.length === effectiveLimit) {
          warnings.push("since_id_gap_unproven");
        }
      }

      return {
        ...base,
        messages,
        pagination: {
          direction,
          hasContinuation,
          endOfHistory,
          nextBeforeId: messages.length === 0 || progressGuardTripped ? null : oldest,
          nextAfterId: messages.length === 0 || progressGuardTripped ? null : newest,
          progressGuardTripped,
          upstreamCount,
        },
      };
    },
  }),
];
