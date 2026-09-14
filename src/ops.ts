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
];
