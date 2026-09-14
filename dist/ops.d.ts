import { z } from "zod";
/**
 * groupmetoolkit operations: pure functions of (arguments, context.config, filesystem).
 * All GroupMe access goes through the shared client in src/groupme/client.ts; the token is
 * read only from context().config["GROUPME_ACCESS_TOKEN"] (D002) and only ever reaches the
 * client's X-Access-Token header.
 */
export declare const operations: import("./toolfactory/types.js").Operation<z.ZodObject<{}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    image_url: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    created_at: z.ZodNumber;
    updated_at: z.ZodNumber;
}, z.core.$strip>>[];
