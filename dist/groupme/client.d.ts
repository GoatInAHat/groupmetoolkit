/**
 * Shared GroupMe v3 client — pure: a function of (fetchImpl, token, request descriptor).
 * No host services, no globals; hosts and operations inject `fetch`.
 *
 * Rules (D001/D005/D008):
 * - GET only; URL is exactly https://api.groupme.com/v3 + path + URL-encoded query params.
 * - The token travels ONLY in the X-Access-Token header — never the query string,
 *   never an Authorization header.
 * - Every attempt is bounded by AbortSignal.timeout(15s).
 * - At most 2 retries after the initial attempt, exponential backoff, for 429/5xx/network
 *   errors; a 429 honors Retry-After seconds when the header parses.
 * - Redirects fail closed: fetch runs with redirect:"manual" and any real 3xx status or a
 *   type "opaqueredirect" response maps to redirect_blocked — never followed.
 * - 304 is end-of-history: a distinct success-shaped marker result, NOT an error (S03 maps
 *   it without reworking this client). 304 is intentionally classified before the generic
 *   3xx redirect check because it is a conditional-cache status, not a redirect.
 * - A 2xx must parse as JSON with a top-level "response" key (GroupMe v3 envelope), else
 *   malformed_response; the inner "response" payload is what the caller receives.
 * - missing_auth is raised BEFORE any fetch when the token is absent/empty/non-string.
 * - GroupMeError.message is the redacted JSON string {"code":...} so CLI (prints
 *   error.message, exit 1), MCP (errored tool result), and OpenClaw native (rethrow) all
 *   surface identical structured text. The token never appears anywhere, and upstream
 *   bodies surface only as redacted meta.errors strings (strings only, capped).
 */
export type GroupMeErrorCode = "missing_auth" | "auth_error" | "not_found" | "rate_limited" | "upstream_error" | "network_error" | "redirect_blocked" | "malformed_response";
export interface GroupMeErrorFields {
    code: GroupMeErrorCode;
    /** HTTP status when the error came from a response; omitted for opaqueredirect. */
    status?: number;
    /** Retry-After seconds parsed from a 429 response. */
    retryAfterSeconds?: number;
    /** Redacted string entries from the upstream envelope's meta.errors. */
    upstreamErrors?: string[];
    /** Original failure (e.g. fetch TypeError) attached for diagnostics, never stringified into message. */
    cause?: unknown;
}
/** Stable-code error whose message is the redacted JSON every surface prints verbatim. */
export declare class GroupMeError extends Error {
    readonly code: GroupMeErrorCode;
    readonly status?: number;
    readonly retryAfterSeconds?: number;
    readonly upstreamErrors?: string[];
    constructor(fields: GroupMeErrorFields);
}
export interface GroupMeFetchRequest {
    fetchImpl: typeof fetch;
    token: string | undefined;
    /** Path under the v3 base URL, e.g. "/users/me". */
    path: string;
    /** Optional query params; values are stringified and URL-encoded, undefined values dropped. */
    query?: Record<string, string | number | boolean | undefined>;
}
export interface GroupMeFetchOptions {
    timeoutMs?: number;
    maxRetries?: number;
    /** Injectable wait so tests never sleep; defaults to real setTimeout. */
    delayMs?: (ms: number) => Promise<void>;
}
export interface GroupMeSuccess {
    status: number;
    /** The inner `response` payload of the GroupMe v3 envelope. */
    response: unknown;
    endOfHistory: false;
}
export interface GroupMeEndOfHistory {
    status: 304;
    response: undefined;
    endOfHistory: true;
}
export type GroupMeResult = GroupMeSuccess | GroupMeEndOfHistory;
/**
 * Perform one GroupMe v3 GET, retrying 429/5xx/network failures at most
 * `maxRetries` (default 2) times, and never following redirects.
 */
export declare function groupmeFetch(request: GroupMeFetchRequest, options?: GroupMeFetchOptions): Promise<GroupMeResult>;
