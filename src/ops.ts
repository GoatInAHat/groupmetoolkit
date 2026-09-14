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
];
