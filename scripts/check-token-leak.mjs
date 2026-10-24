#!/usr/bin/env node
// Token-route leak check: the executable counterpart of the "vault-only token route" prose in
// the skill body, README ("Token setup (vault-only)") and AGENTS ("Token route (vault-only)").
//
// A grep alone cannot prove this: the token lives in src/ as the NAME GROUPME_ACCESS_TOKEN,
// which is legitimate. What must never happen is the token VALUE reaching a URL, a log line, an
// error message or an output. So this script proves three things:
//
//   1. STRUCTURE (static, src/**/*.ts): the token is read only as
//      `ctx.config["GROUPME_ACCESS_TOKEN"]`, and src/ contains no credential-shaped literal,
//      no Authorization/Bearer header construction against the GroupMe host, and no token value
//      passed outside the client's header. A new read site or a `?access_token=` URL fails here.
//
//   2. BEHAVIOUR, missing auth (built CLI, GROUPME_ACCESS_TOKEN scrubbed): every operation exits
//      1 with the parseable {"code":"missing_auth"} envelope and no credential noise — the token
//      cannot appear in an error because there was none. (scripts/smoke-missing-auth.mjs proves
//      the same on the built artifact; this repeats one case so the check is self-contained.)
//
//   3. BEHAVIOUR, present auth (handler layer, in-process): with a sentinel token configured,
//      a stubbed fetch that returns an upstream error envelope ECHOING the token, the resulting
//      GroupMeError message, its `errors` list and its attached cause all carry "[redacted]"
//      instead of the sentinel, and the stubbed request URL contains no token while the
//      X-Access-Token header does. That is the only route by which the value could leak.
//
// Hermetic: no network (fetch is stubbed), no credential, no writes. Exits 0 when every
// assertion holds; exits 1 with a FAIL per broken invariant otherwise.
//
// Usage: node scripts/check-token-leak.mjs   (run `npm run build` first for part 2)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

// The sentinel stands in for a real vault token: it must be distinctive enough that a leak is
// unambiguous and it must never be a real credential. Same literal the surface smokes scan for.
const SENTINEL = "TESTTOKEN_SHOULD_NEVER_LEAK";
const NOISE = ["X-Access-Token", "Authorization", "Bearer", "GROUPME_ACCESS_TOKEN"];

// ---------------------------------------------------------------- 1. static structure checks

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const srcDir = join(root, "src");
if (!existsSync(srcDir)) {
  console.error("check-token-leak: FAIL no src/ directory — run from the repository root");
  process.exit(1);
}
const srcFiles = walk(srcDir).filter((f) => f.endsWith(".ts"));
ok(`scanned ${srcFiles.length} TypeScript source files under src/`);

// Every read of the token must be the config lookup, never process.env, never a literal.
const readSites = [];
const tokenShaped = [];
for (const file of srcFiles) {
  const rel = relative(root, file).replaceAll("\\", "/");
  // The generated host-injection boundary (src/toolfactory/config.ts) is where the env var
  // legally becomes ctx.config; every other file must read the token from the context only.
  const isInjectionBoundary = rel === "src/toolfactory/config.ts";
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    if (/\bctx\.config\["GROUPME_ACCESS_TOKEN"\]|\bcontext\(\)\.config\["GROUPME_ACCESS_TOKEN"\]/.test(line)) {
      readSites.push(where);
    }
    // A read straight from process.env would bypass the host-injected config contract.
    if (!isInjectionBoundary && /process\.env(?:\.|\[)\s*["']?GROUPME_ACCESS_TOKEN/.test(line)) {
      fail(`${where}: reads the token from process.env instead of ctx.config (host injection contract)`);
    }
    // GroupMe access tokens are 32 hex characters. A literal of that shape with no
    // identifier context is a credential in source, not a name.
    const hex = line.match(/\b[a-f0-9]{32}\b/gi);
    if (hex) tokenShaped.push(`${where}: ${hex[0]}`);
  });
}

// ops.ts is the only place operations read the token; groupme/config.ts is the generated
// host-injection boundary (it maps the env var into context().config, nothing else).
const ALLOWED_READ_FILES = new Set(["src/ops.ts", "src/toolfactory/config.ts"]);
for (const site of readSites) {
  const file = site.split(":")[0];
  if (!ALLOWED_READ_FILES.has(file)) fail(`${site}: unexpected token read site (allowed: ${[...ALLOWED_READ_FILES].join(", ")})`);
}
if (readSites.length === 0) fail("src/: no ctx.config[\"GROUPME_ACCESS_TOKEN\"] read site found — is the route still wired?");
else ok(`${readSites.length} token read site(s), all through ctx.config`);

// The generated config.ts is the only file allowed to touch the env var (that IS injection).
const envReaders = srcFiles.filter((f) =>
  /process\.env(?:\.|\[)\s*["']?GROUPME_ACCESS_TOKEN/.test(readFileSync(f, "utf8")),
);
for (const file of envReaders) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (rel !== "src/toolfactory/config.ts") fail(`${rel}: reads GROUPME_ACCESS_TOKEN from the environment outside the generated config boundary`);
}

// A token value must never reach a URL: no ?access_token= / &token= built in source, and the
// client must assemble query strings only from caller-supplied query params.
const urlLeaks = [];
for (const file of srcFiles) {
  const rel = relative(root, file).replaceAll("\\", "/");
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/[?&](?:access_token|token)=/.test(line)) urlLeaks.push(`${rel}:${i + 1}`);
  });
}
if (urlLeaks.length > 0) for (const l of urlLeaks) fail(`${l}: token-shaped query parameter in source — the token travels only in X-Access-Token`);
else ok("no ?access_token= / ?token= query parameter anywhere in src/");

const clientSrc = readFileSync(join(root, "src/groupme/client.ts"), "utf8");
// The send site must be the header, exactly once, on a GET.
const headerSites = clientSrc.split("\n").filter((l) => /["']X-Access-Token["']\s*:/.test(l));
if (headerSites.length !== 1) fail(`src/groupme/client.ts: expected exactly one X-Access-Token header construction, found ${headerSites.length}`);
else ok("src/groupme/client.ts sends the token in exactly one X-Access-Token header");
if (!/method:\s*"GET"/.test(clientSrc)) fail("src/groupme/client.ts: no GET-only request construction found");
// The scrubbing helpers are what make the redaction real; assert they still exist.
for (const helper of ["scrubToken", "redactUpstreamErrors", "redactCause"]) {
  if (!clientSrc.includes(`function ${helper}`)) fail(`src/groupme/client.ts: redaction helper ${helper}() is missing`);
}
if (!/scrubToken\(/.test(clientSrc)) fail("src/groupme/client.ts: scrubToken() is never called");
else ok("src/groupme/client.ts keeps scrubToken/redactUpstreamErrors/redactCause wired");

if (tokenShaped.length > 0) {
  for (const hit of tokenShaped) fail(`${hit}: credential-shaped literal (32 hex chars) in src/`);
} else {
  ok("no 32-hex credential-shaped literal in src/");
}

// ------------------------------------------------------- 2. built CLI, absent token (behaviour)

const cli = join(root, "dist/toolfactory/cli.js");
if (!existsSync(cli)) {
  fail("dist/toolfactory/cli.js is missing — run `npm run build` first (this check exercises the built artifact)");
} else {
  const childEnv = { ...process.env };
  delete childEnv.GROUPME_ACCESS_TOKEN;
  delete childEnv.SMOKE_GROUPME_FIXTURE;
  const run = spawnSync(process.execPath, ["dist/toolfactory/cli.js", "me"], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.error) fail(`built CLI me: spawn failed: ${run.error.message}`);
  if (run.status !== 1) fail(`built CLI me without a token: expected exit 1, got ${run.status}${run.signal ? ` (signal ${run.signal})` : ""}`);
  let envelope;
  try {
    envelope = JSON.parse((run.stderr ?? "").trim());
  } catch {
    fail(`built CLI me without a token: stderr is not a JSON envelope: ${(run.stderr ?? "").slice(0, 200)}`);
  }
  if (envelope && envelope.code !== "missing_auth") fail(`built CLI me without a token: envelope code=${JSON.stringify(envelope.code)} (want missing_auth)`);
  for (const noise of NOISE) {
    if (output.includes(noise)) fail(`built CLI me without a token: output contains credential noise ${noise}`);
  }
  if (!failures.some((f) => f.startsWith("built CLI me"))) {
    ok("built CLI without a token: exit 1, structured missing_auth envelope, no credential noise");
  }
}

// ------------------------------------------------ 3. handler layer, token present (behaviour)

if (!existsSync(join(root, "dist/ops.js"))) {
  fail("dist/ops.js is missing — run `npm run build` first (this check exercises the built artifact)");
} else {
  const { operations } = await import(new URL("dist/ops.js", `file://${root}/`).href);
  const { GroupMeError } = await import(new URL("dist/groupme/client.js", `file://${root}/`).href);

  const VALID_ARGS = {
    chats: { page: 1 },
    group: { id: "12345678" },
    group_messages: { group_id: "12345678" },
    groups: { page: 1 },
    me: {},
    search_group_messages: { group_id: "12345678", query: "alpha" },
  };

  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    // Worst case: the upstream error envelope echoes the token AND the cause carries it.
    return new Response(JSON.stringify({ meta: { code: 500, errors: [`bad token ${SENTINEL}`] }, response: null }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    for (const op of operations) {
      const args = op.input.parse(VALID_ARGS[op.name] ?? {});
      // Never retry with a real delay; the stub returns 500 (retryable) so inject a no-op wait.
      const ctx = { config: { GROUPME_ACCESS_TOKEN: SENTINEL }, dataDir: join(root, "dist", ".token-leak-check") };
      const caught = await op.handler(args, ctx).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      if (caught.ok) {
        fail(`${op.name}: handler resolved with a token configured; the stub returned 500 so this should be an error`);
        continue;
      }
      const error = caught.error;
      if (!(error instanceof GroupMeError)) {
        fail(`${op.name}: handler threw a non-GroupMeError (${error?.constructor?.name})`);
        continue;
      }
      const surfaces = {
        message: String(error.message),
        errors: JSON.stringify(error.upstreamErrors ?? []),
        cause: error.cause instanceof Error ? error.cause.message : String(error.cause ?? ""),
      };
      for (const [name, text] of Object.entries(surfaces)) {
        if (text.includes(SENTINEL)) fail(`${op.name}: token leaked into GroupMeError.${name}`);
      }
      if (!surfaces.errors.includes("[redacted]")) fail(`${op.name}: upstream meta.errors were not scrubbed to [redacted]`);
      // The envelope is still parseable JSON for hosts that switch on `code`.
      try {
        JSON.parse(surfaces.message);
      } catch {
        fail(`${op.name}: GroupMeError.message is not a JSON envelope: ${surfaces.message.slice(0, 120)}`);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  for (const { url, headers } of seen) {
    if (url.includes(SENTINEL)) fail(`request URL contains the token: ${url}`);
    const headerValue = typeof headers === "object" ? headers["X-Access-Token"] : undefined;
    if (headerValue !== SENTINEL) fail(`request to ${url} did not carry the token in X-Access-Token (got ${JSON.stringify(headerValue)})`);
    if (headers.Authorization !== undefined || headers.authorization !== undefined) fail(`request to ${url} carried an Authorization header`);
  }
  if (seen.length === 0) fail("no fetch attempt was recorded with a token configured — the handlers never reached the client");
  else ok(`${seen.length} stubbed request(s): token only in X-Access-Token, never in the URL, never in Authorization`);
  if (!failures.some((f) => /token leaked into|not scrubbed/.test(f))) {
    ok("every upstream error surface (message, errors, cause) is scrubbed of the token");
  }
}

// ---------------------------------------------------------------------------- verdict

if (failures.length > 0) {
  console.error(`\ncheck-token-leak FAILED: ${failures.length} invariant(s) broken`);
  process.exit(1);
}
console.log("\ncheck-token-leak OK: read site, send site, URL cleanliness, redaction and the built surface all hold");
