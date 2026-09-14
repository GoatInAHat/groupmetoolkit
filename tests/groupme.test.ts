// Mock-tier contract tests for the shared GroupMe client (src/groupme/client.ts).
// Zero real network: every case runs on an injected fetch spy; the live tier
// (tests/live.test.ts) is the only lane that may reach api.groupme.com.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GroupMeError,
  groupmeFetch,
  type GroupMeResult,
} from "../src/groupme/client.js";

const TOKEN = "TESTTOKEN_SHOULD_NEVER_LEAK";
const BASE = "https://api.groupme.com/v3";

type FetchSpy = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function okEnvelope(response: unknown): Response {
  return jsonResponse(200, { meta: {}, response });
}

function makeError(result: Promise<GroupMeResult>): Promise<GroupMeError> {
  return result.then(
    () => {
      throw new Error("expected groupmeFetch to throw");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GroupMeError);
      return error as GroupMeError;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("groupmeFetch: request shape", () => {
  it("sends GET to the exact v3 URL with the token only in X-Access-Token", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => okEnvelope({ id: "1" }));
    await groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/users/me" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toBe(`${BASE}/users/me`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Access-Token"]).toBe(TOKEN);
    expect(headers["Authorization"]).toBeUndefined();
    expect(url).not.toContain(TOKEN);
  });

  it("URL-encodes query params, drops undefined values, and never puts the token in the URL", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => okEnvelope({}));
    await groupmeFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: TOKEN,
      path: "/groups",
      query: { page: 2, q: "a b&c=d", skip: undefined },
    });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/groups?page=2&q=a+b%26c%3Dd`);
    expect(url).not.toContain(TOKEN);
  });
});

describe("groupmeFetch: missing_auth", () => {
  const cases: Array<[string, string | undefined]> = [
    ["absent token", undefined],
    ["empty-string token", ""],
    ["non-string token (raw object)", {} as unknown as string],
  ];
  for (const [label, token] of cases) {
    it(`raises missing_auth with 0 fetch calls for ${label}`, async () => {
      const fetchImpl: FetchSpy = vi.fn();
      const error = await makeError(
        groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token, path: "/users/me" }),
      );
      expect(error.code).toBe("missing_auth");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(error.message).not.toContain(TOKEN);
    });
  }
});

describe("groupmeFetch: status mapping", () => {
  const cases: Array<[number, string, Record<string, string>?]> = [
    [401, "auth_error"],
    [403, "auth_error"],
    [404, "not_found"],
    [500, "upstream_error"],
    [503, "upstream_error"],
    [400, "upstream_error"],
  ];
  for (const [status, code] of cases) {
    it(`maps ${status} to ${code}`, async () => {
      const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(status, { meta: {} }));
      const error = await makeError(
        groupmeFetch({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          token: TOKEN,
          path: "/x",
        },
        { maxRetries: 0 }, // single attempt per status-mapping case
      ),
    );
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    });
  }

  it("maps 429 to rate_limited carrying Retry-After seconds", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "7" }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      },
      { maxRetries: 0 },
    ),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
  });

  it("surfaces only redacted meta.errors strings, never the raw body", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(403, { meta: { errors: ["Invalid access token"] }, phone_number: "+1 5550100" }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      },
      { maxRetries: 0 },
    ),
    );
    expect(error.upstreamErrors).toEqual(["Invalid access token"]);
    expect(error.message).not.toContain("phone_number");
    expect(error.message).not.toContain("+1 5550100");
  });
});

describe("groupmeFetch: retries", () => {
  it("retries at most 2 times on 5xx then surfaces the error (3 calls total)", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(503, { meta: {} }));
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, {
        delayMs: async (ms) => {
          delays.push(ms);
        },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]); // exponential backoff 500ms * 2^attempt
    expect(error.code).toBe("upstream_error");
  });

  it("honors Retry-After seconds on a retried 429", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "3" }),
    );
    await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, {
        delayMs: async (ms) => {
          delays.push(ms);
        },
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([3000, 3000]);
  });

  it("does not retry non-retryable errors (404 surfaces immediately)", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(404, { meta: {} }));
    await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the success response as soon as a retry succeeds", async () => {
    const fetchImpl: FetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { meta: {} }))
      .mockResolvedValueOnce(okEnvelope({ ok: true }));
    const result = await groupmeFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: TOKEN,
      path: "/x",
    }, { delayMs: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.endOfHistory).toBe(false);
    expect(result).toEqual({ status: 200, response: { ok: true }, endOfHistory: false });
  });
});

describe("groupmeFetch: network failures", () => {
  it("maps a rejected fetch to network_error", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(error.code).toBe("network_error");
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("maps a timeout (AbortError) to network_error", async () => {
    const abort = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetchImpl: FetchSpy = vi.fn(async () => {
      throw abort;
    });
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(error.code).toBe("network_error");
  });

  it("applies the per-attempt timeout to the request signal", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => okEnvelope({}));
    await groupmeFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: TOKEN,
      path: "/x",
    }, { timeoutMs: 1234 });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("groupmeFetch: redirects fail closed (D008)", () => {
  it("blocks a 301 redirect and never requests the Location", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(301, "", { Location: "https://evil.example/steal" }));
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }),
    );
    expect(error.code).toBe("redirect_blocked");
    expect(error.status).toBe(301);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never followed, never retried
  });

  it("blocks a 302 redirect", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(302, "", { Location: "http://other/" }));
    const error = await makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
    expect(error.code).toBe("redirect_blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks an opaqueredirect-type response", async () => {
    const opaque = { type: "opaqueredirect", status: 0 } as unknown as Response;
    const fetchImpl: FetchSpy = vi.fn(async () => opaque);
    const error = await makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
    expect(error.code).toBe("redirect_blocked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends every attempt with redirect:'manual'", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => okEnvelope({}));
    await groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" });
    expect((fetchImpl.mock.calls[0][1] as RequestInit).redirect).toBe("manual");
  });
});

describe("groupmeFetch: malformed_response", () => {
  it("rejects a 200 with a non-JSON body", async () => {
    const fetchImpl: FetchSpy = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    );
    const error = await makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
    expect(error.code).toBe("malformed_response");
  });

  it("rejects a 200 JSON body without the top-level 'response' key", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(200, { meta: {}, nope: {} }));
    const error = await makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
    expect(error.code).toBe("malformed_response");
  });

  it("does not retry malformed_response", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(200, {}));
    await makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("groupmeFetch: 304 end-of-history", () => {
  it("returns the distinct end-of-history marker — not an error, not a throw", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => new Response(null, { status: 304 }));
    const result = await groupmeFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: TOKEN,
      path: "/x",
    });
    expect(result).toEqual({ status: 304, response: undefined, endOfHistory: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("groupmeFetch: success envelope", () => {
  it("returns { status, response } with the parsed inner payload", async () => {
    const payload = { id: "1234567890", name: "Test User" };
    const fetchImpl: FetchSpy = vi.fn(async () => okEnvelope(payload));
    const result = await groupmeFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      token: TOKEN,
      path: "/users/me",
    });
    expect(result.endOfHistory).toBe(false);
    if (result.endOfHistory) throw new Error("unreachable");
    expect(result.status).toBe(200);
    expect(result.response).toEqual(payload);
  });
});

describe("groupmeFetch: token redaction (T05 regressions)", () => {
  it("scrubs the request token echoed in a 401's meta.errors", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(401, {
        meta: { errors: [`Invalid token: ${TOKEN}`, `prefix ${TOKEN} suffix`] },
      }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { maxRetries: 0 }),
    );
    expect(error.code).toBe("auth_error");
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error.upstreamErrors).toEqual([
      "Invalid token: [redacted]",
      "prefix [redacted] suffix",
    ]);
  });

  it("scrubs the token from a fetch-failure cause's message", async () => {
    const fetchImpl: FetchSpy = vi.fn(async () => {
      throw new TypeError(`fetch of ${TOKEN} failed`);
    });
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(error.code).toBe("network_error");
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    const cause = error.cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).not.toContain(TOKEN);
    expect(cause.message).toContain("[redacted]");
  });

  it("scrubs the token from a body-read failure and classifies it", async () => {
    const bodyFails = (thrown: unknown, status = 200): Response =>
      ({
        status,
        type: "default",
        headers: new Headers(),
        json: async () => {
          throw thrown;
        },
      }) as unknown as Response;

    // JSON syntax failure -> malformed_response, non-retryable, token scrubbed.
    const syntaxFetch: FetchSpy = vi.fn(async () =>
      bodyFails(new SyntaxError(`Unexpected token in ${TOKEN}`)),
    );
    const syntaxError = await makeError(
      groupmeFetch({
        fetchImpl: syntaxFetch as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }),
    );
    expect(syntaxError.code).toBe("malformed_response");
    expect(syntaxError.message).not.toContain(TOKEN);
    expect((syntaxError.cause as Error).message).not.toContain(TOKEN);
    expect(syntaxFetch).toHaveBeenCalledTimes(1);

    // Abort/timeout during body read -> network_error, retryable, deadline covers body.
    const abortFetch: FetchSpy = vi.fn(async () =>
      bodyFails(new DOMException("The operation was aborted", "TimeoutError")),
    );
    const abortError = await makeError(
      groupmeFetch({
        fetchImpl: abortFetch as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(abortError.code).toBe("network_error");
    expect(abortError.message).not.toContain(TOKEN);
    expect(abortFetch).toHaveBeenCalledTimes(3); // initial + 2 bounded retries
  });
});

describe("groupmeFetch: retryability is restricted to 429/5xx/network (T05)", () => {
  for (const status of [400, 409]) {
    it(`makes exactly one request for unexpected ${status}`, async () => {
      const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(status, { meta: {} }));
      const error = await makeError(
        groupmeFetch({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          token: TOKEN,
          path: "/x",
        }, { delayMs: async () => {} }),
      );
      expect(error.code).toBe("upstream_error");
      expect(error.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps the bounded retry count for 500 and network failures", async () => {
    const fiveHundred: FetchSpy = vi.fn(async () => jsonResponse(500, { meta: {} }));
    await makeError(
      groupmeFetch({
        fetchImpl: fiveHundred as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(fiveHundred).toHaveBeenCalledTimes(3);

    const network: FetchSpy = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await makeError(
      groupmeFetch({
        fetchImpl: network as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async () => {} }),
    );
    expect(network).toHaveBeenCalledTimes(3);
  });
});

describe("groupmeFetch: Retry-After is bounded (T05)", () => {
  it("honors a normal Retry-After delay via the injected clock", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "3" }),
    );
    await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async (ms) => { delays.push(ms); } }),
    );
    expect(delays).toEqual([3000, 3000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops immediately with rate_limited + retryAfterSeconds for a day-long window", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "86400" }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async (ms) => { delays.push(ms); } }),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(86400);
    expect(delays).toEqual([]); // no automatic waiting
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no early retry either
  });

  it("falls back to bounded backoff for malformed Retry-After values", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "soonish" }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async (ms) => { delays.push(ms); } }),
    );
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(delays).toEqual([500, 1000]); // exponential backoff, never server-directed
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats a timer-overflow Retry-After as unusable and falls back to bounded backoff", async () => {
    const delays: number[] = [];
    const fetchImpl: FetchSpy = vi.fn(async () =>
      jsonResponse(429, { meta: {} }, { "Retry-After": "99999999999999999999" }),
    );
    const error = await makeError(
      groupmeFetch({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: TOKEN,
        path: "/x",
      }, { delayMs: async (ms) => { delays.push(ms); } }),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBeUndefined(); // overflow value is not a usable window
    // A strictly-validated overflow is not a server-directed window: never sleep for it and
    // never let a setTimeout overflow fire early — bounded exponential backoff applies.
    expect(delays).toEqual([500, 1000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("groupmeFetch: redaction across every failing scenario", () => {
  const failing = async (): Promise<GroupMeError> => {
    // A representative failure: upstream body plus the fixture token in play.
    const fetchImpl: FetchSpy = vi.fn(async () => jsonResponse(500, { meta: { errors: ["boom"] } }));
    return makeError(
      groupmeFetch({ fetchImpl: fetchImpl as unknown as typeof fetch, token: TOKEN, path: "/x" }),
    );
  };

  it("never leaks the fixture token in the serialized error", async () => {
    const error = await failing();
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN);
    expect(String(error.cause ?? "")).not.toContain(TOKEN);
  });
});
