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
const REDACTED_ERRORS_MAX_ENTRIES = 10;
const REDACTED_ERRORS_MAX_LENGTH = 200;
/** Stable-code error whose message is the redacted JSON every surface prints verbatim. */
export class GroupMeError extends Error {
    code;
    status;
    retryAfterSeconds;
    upstreamErrors;
    constructor(fields) {
        const message = { code: fields.code };
        if (fields.status !== undefined)
            message.status = fields.status;
        if (fields.retryAfterSeconds !== undefined)
            message.retryAfterSeconds = fields.retryAfterSeconds;
        if (fields.upstreamErrors !== undefined)
            message.errors = fields.upstreamErrors;
        super(JSON.stringify(message), fields.cause === undefined ? undefined : { cause: fields.cause });
        this.name = "GroupMeError";
        this.code = fields.code;
        this.status = fields.status;
        this.retryAfterSeconds = fields.retryAfterSeconds;
        this.upstreamErrors = fields.upstreamErrors;
    }
}
const BASE_URL = "https://api.groupme.com/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
function defaultDelay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRetryable(error) {
    return (error.code === "rate_limited" || error.code === "upstream_error" || error.code === "network_error");
}
/** Exponential backoff; a 429's parsed Retry-After seconds take precedence. */
function retryDelayMs(error, attempt) {
    if (error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
        return error.retryAfterSeconds * 1000;
    }
    return BACKOFF_BASE_MS * 2 ** attempt;
}
function parseRetryAfter(header) {
    if (header === null)
        return undefined;
    const seconds = Number.parseInt(header, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
function statusToCode(status) {
    if (status === 401 || status === 403)
        return "auth_error";
    if (status === 404)
        return "not_found";
    if (status === 429)
        return "rate_limited";
    return "upstream_error"; // 5xx and any other unexpected status (400, 409, ...)
}
/** Only string entries of meta.errors survive, capped — never the raw body. */
function redactUpstreamErrors(body) {
    if (body === null || typeof body !== "object")
        return undefined;
    const meta = body["meta"];
    if (meta === null || typeof meta !== "object")
        return undefined;
    const errors = meta["errors"];
    if (!Array.isArray(errors))
        return undefined;
    const strings = errors
        .filter((entry) => typeof entry === "string")
        .slice(0, REDACTED_ERRORS_MAX_ENTRIES)
        .map((entry) => (entry.length > REDACTED_ERRORS_MAX_LENGTH ? entry.slice(0, REDACTED_ERRORS_MAX_LENGTH) : entry));
    return strings.length > 0 ? strings : undefined;
}
async function safeJsonBody(response) {
    try {
        return await response.json();
    }
    catch {
        return undefined;
    }
}
function buildUrl(path, query) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(BASE_URL + normalizedPath);
    if (query !== undefined) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined)
                params.set(key, String(value));
        }
        const encoded = params.toString();
        if (encoded.length > 0)
            url.search = encoded;
    }
    return url.toString();
}
async function attemptOnce(fetchImpl, url, token, timeoutMs) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json", "X-Access-Token": token },
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (error) {
        throw new GroupMeError({ code: "network_error", cause: error });
    }
    return classifyResponse(response);
}
async function classifyResponse(response) {
    // Fail closed on redirects before anything else; opaqueredirect carries status 0.
    if (response.type === "opaqueredirect") {
        throw new GroupMeError({ code: "redirect_blocked" });
    }
    if (response.status === 304) {
        return { status: 304, response: undefined, endOfHistory: true };
    }
    if (response.status >= 300 && response.status < 400) {
        throw new GroupMeError({ code: "redirect_blocked", status: response.status });
    }
    if (response.status >= 200 && response.status < 300) {
        let parsed;
        try {
            parsed = await response.json();
        }
        catch (error) {
            throw new GroupMeError({ code: "malformed_response", status: response.status, cause: error });
        }
        if (parsed === null || typeof parsed !== "object" || !("response" in parsed)) {
            throw new GroupMeError({ code: "malformed_response", status: response.status });
        }
        return {
            status: response.status,
            response: parsed["response"],
            endOfHistory: false,
        };
    }
    // Error statuses: read the body best-effort; only meta.errors strings survive.
    const upstreamErrors = redactUpstreamErrors(await safeJsonBody(response));
    const retryAfterSeconds = response.status === 429 ? parseRetryAfter(response.headers.get("Retry-After")) : undefined;
    throw new GroupMeError({
        code: statusToCode(response.status),
        status: response.status,
        retryAfterSeconds,
        upstreamErrors,
    });
}
/**
 * Perform one GroupMe v3 GET, retrying 429/5xx/network failures at most
 * `maxRetries` (default 2) times, and never following redirects.
 */
export async function groupmeFetch(request, options = {}) {
    const { fetchImpl, token, path, query } = request;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const delayMs = options.delayMs ?? defaultDelay;
    // missing_auth is decided BEFORE any fetch: absent, empty, or non-string token
    // (a non-string also catches a raw unresolved SecretRef object — fail closed).
    if (typeof token !== "string" || token.length === 0) {
        throw new GroupMeError({ code: "missing_auth" });
    }
    const url = buildUrl(path, query);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let error;
        try {
            return await attemptOnce(fetchImpl, url, token, timeoutMs);
        }
        catch (caught) {
            error =
                caught instanceof GroupMeError
                    ? caught
                    : new GroupMeError({ code: "network_error", cause: caught });
        }
        if (!isRetryable(error) || attempt === maxRetries)
            throw error;
        await delayMs(retryDelayMs(error, attempt));
    }
    // Unreachable: the loop returns or throws on every path.
    throw new GroupMeError({ code: "network_error" });
}
