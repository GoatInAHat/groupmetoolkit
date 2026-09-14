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
 *   malformed_response; the inner "response" payload is what the caller receives. A JSON
 *   syntax failure in the body is malformed_response, while a body read that fails from
 *   timeout/abort/connectivity is network_error and stays retryable — the request deadline
 *   covers body consumption, not just headers.
 * - missing_auth is raised BEFORE any fetch when the token is absent/empty/non-string.
 * - GroupMeError.message is the redacted JSON string {"code":...} so CLI (prints
 *   error.message, exit 1), MCP (errored tool result), and OpenClaw native (rethrow) all
 *   surface identical structured text. The token never appears anywhere: upstream
 *   meta.errors strings are scrubbed of the request token (and capped), and diagnostic
 *   causes have the token scrubbed from their messages before attachment, so hosts that
 *   serialize error causes can never leak it either.
 */

export type GroupMeErrorCode =
  | "missing_auth"
  | "auth_error"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "network_error"
  | "redirect_blocked"
  | "malformed_response";

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

const REDACTED_ERRORS_MAX_ENTRIES = 10;
const REDACTED_ERRORS_MAX_LENGTH = 200;
/**
 * Upper bound on ONE automatic retry wait. A server-requested Retry-After beyond this
 * is never honored by sleeping — the caller gets rate_limited + retryAfterSeconds and
 * can schedule its own retry. 60s keeps automatic backpressure well inside any host's
 * tool-call timeout while still honoring normal short Retry-After windows.
 */
const MAX_RETRY_WAIT_MS = 60_000;

/** Stable-code error whose message is the redacted JSON every surface prints verbatim. */
export class GroupMeError extends Error {
  readonly code: GroupMeErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly upstreamErrors?: string[];

  constructor(fields: GroupMeErrorFields) {
    const message: Record<string, unknown> = { code: fields.code };
    if (fields.status !== undefined) message.status = fields.status;
    if (fields.retryAfterSeconds !== undefined) message.retryAfterSeconds = fields.retryAfterSeconds;
    if (fields.upstreamErrors !== undefined) message.errors = fields.upstreamErrors;
    super(JSON.stringify(message), fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = "GroupMeError";
    this.code = fields.code;
    this.status = fields.status;
    this.retryAfterSeconds = fields.retryAfterSeconds;
    this.upstreamErrors = fields.upstreamErrors;
  }
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

const BASE_URL = "https://api.groupme.com/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: GroupMeError): boolean {
  if (error.code === "rate_limited" || error.code === "network_error") return true;
  // Only 5xx (and 429 above) are retryable upstream conditions; unexpected 4xx such as
  // 400/409 are deterministic request problems — mapped to upstream_error but never retried.
  return error.code === "upstream_error" && error.status !== undefined && error.status >= 500;
}

/** Exponential backoff; a 429's parsed Retry-After seconds take precedence. */
function retryDelayMs(error: GroupMeError, attempt: number): number {
  if (error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
    return error.retryAfterSeconds * 1000;
  }
  return BACKOFF_BASE_MS * 2 ** attempt;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  // Strictly digits-only integer seconds; anything else (HTTP-date, float, signed,
  // timer-overflow garbage) falls through to plain exponential backoff.
  if (!/^\d+$/.test(header)) return undefined;
  const seconds = Number(header);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return seconds;
}

function statusToCode(status: number): GroupMeErrorCode {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "upstream_error"; // 5xx and any other unexpected status (400, 409, ...)
}

/** Replace every occurrence of the request token with a placeholder. */
function scrubToken(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("[redacted]") : text;
}

/** Cap length and entries, scrub the request token; only meta.errors strings survive. */
function redactUpstreamErrors(body: unknown, token: string): string[] | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const meta = (body as Record<string, unknown>)["meta"];
  if (meta === null || typeof meta !== "object") return undefined;
  const errors = (meta as Record<string, unknown>)["errors"];
  if (!Array.isArray(errors)) return undefined;
  const strings = errors
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => scrubToken(entry, token))
    .slice(0, REDACTED_ERRORS_MAX_ENTRIES)
    .map((entry) => (entry.length > REDACTED_ERRORS_MAX_LENGTH ? entry.slice(0, REDACTED_ERRORS_MAX_LENGTH) : entry));
  return strings.length > 0 ? strings : undefined;
}

/**
 * Diagnostic cause with the request token scrubbed from its message (and any string
 * property surfaces we attach), so hosts that serialize causes can never leak the token.
 */
function redactCause(error: unknown, token: string): Error {
  const redacted = new Error(
    error instanceof Error ? scrubToken(error.message, token) : scrubToken(String(error), token),
  );
  redacted.name = error instanceof Error ? error.name : "UnknownError";
  return redacted;
}

/**
 * Classify a failed body read. A JSON syntax failure means the server sent garbage —
 * malformed_response. An aborted/timed-out/failed body read after headers arrived is a
 * connectivity problem — network_error (retryable; the signal covers body consumption).
 */
function classifyBodyReadError(error: unknown): "malformed_response" | "network_error" {
  if (error instanceof SyntaxError) return "malformed_response";
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "network_error" : "network_error";
}

async function safeJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function buildUrl(path: string, query: GroupMeFetchRequest["query"] | undefined): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(BASE_URL + normalizedPath);
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const encoded = params.toString();
    if (encoded.length > 0) url.search = encoded;
  }
  return url.toString();
}

async function attemptOnce(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<GroupMeResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Access-Token": token },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new GroupMeError({ code: "network_error", cause: redactCause(error, token) });
  }
  return classifyResponse(response, token);
}

async function classifyResponse(response: Response, token: string): Promise<GroupMeResult> {
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
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      const code = classifyBodyReadError(error);
      throw new GroupMeError({ code, status: response.status, cause: redactCause(error, token) });
    }
    if (parsed === null || typeof parsed !== "object" || !("response" in parsed)) {
      throw new GroupMeError({ code: "malformed_response", status: response.status });
    }
    return {
      status: response.status,
      response: (parsed as Record<string, unknown>)["response"],
      endOfHistory: false,
    };
  }
  // Error statuses: read the body best-effort; only meta.errors strings survive.
  const upstreamErrors = redactUpstreamErrors(await safeJsonBody(response), token);
  const retryAfterSeconds =
    response.status === 429 ? parseRetryAfter(response.headers.get("Retry-After")) : undefined;
  throw new GroupMeError({
    code: statusToCode(response.status),
    status: response.status,
    retryAfterSeconds,
    upstreamErrors,
  });
}

/**
 * Perform one GroupMe v3 GET, retrying 429/5xx/network failures at most
 * `maxRetries` (default 2) times, and never following redirects. A single automatic
 * wait never exceeds MAX_RETRY_WAIT_MS: a Retry-After beyond the budget stops the
 * automatic loop immediately with the rate_limited error (carrying retryAfterSeconds)
 * instead of sleeping — retrying early would violate the server's window, and waiting
 * hours inside one tool call would hit every host timeout.
 */
export async function groupmeFetch(
  request: GroupMeFetchRequest,
  options: GroupMeFetchOptions = {},
): Promise<GroupMeResult> {
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
    let error: GroupMeError;
    try {
      return await attemptOnce(fetchImpl, url, token, timeoutMs);
    } catch (caught) {
      error =
        caught instanceof GroupMeError
          ? caught
          : new GroupMeError({ code: "network_error", cause: redactCause(caught, token) });
    }
    if (!isRetryable(error) || attempt === maxRetries) throw error;
    const waitMs = retryDelayMs(error, attempt);
    if (waitMs > MAX_RETRY_WAIT_MS) {
      // Server asked us to back off longer than we may automatically wait: surface the
      // rate limit (with retryAfterSeconds) now rather than sleeping or retrying early.
      throw error;
    }
    await delayMs(waitMs);
  }
  // Unreachable: the loop returns or throws on every path.
  throw new GroupMeError({ code: "network_error" });
}
