# groupmetoolkit

Read-only GroupMe account tools usable from OpenClaw without a connected MacBook.

Six read-only operations — `me`, `groups`, `group`, `chats`, `group_messages` and
`search_group_messages` — over one GroupMe access token. Nothing is persisted: every call
returns redacted, structured metadata and writes no message history to disk.

All operations authenticate with `GROUPME_ACCESS_TOKEN` (vault-backed, hosts inject the
value): the token is sent only in the `X-Access-Token` header, consumed via
`context().config`, and never appears in URLs, logs, errors, fixtures, or outputs. Missing
auth surfaces a structured `missing_auth` with no network call.

The same route is documented for agents in the skill body, `skills/groupmetoolkit/SKILL.md`
(section "Authentication: the vault-only token route"): one read mechanism
(`context().config["GROUPME_ACCESS_TOKEN"]`, never `process.env`, a file, an argument or a
literal), one send site (the single `X-Access-Token` header of GETs to
`https://api.groupme.com` in `src/groupme/client.ts`), and no token anywhere else.

## Status

Standalone installation from npm is **not currently available**. The package is unpublished:
there is no published tarball, no tag and no release, and the npm install commands below
would fail today. Until a release exists, use this checkout — the supported route is the
checkout-local build described in [Bootstrap from a clean checkout](#bootstrap-from-a-clean-checkout).

## Node version

Native development (building and testing the OpenClaw host plugin) requires **Node 24**:
the OpenClaw native CLI needs it. The portable core package and its test suite run on Node
**22** and later (`engines.node` is `>=22.12`), and the generated CI lane checks both.

## Bootstrap from a clean checkout

Run these in order from the repository root. Steps 1–2 are prerequisites for everything
after: Tool Factory validation and native host use both read a built `dist/`.

```bash
# 1. Node 24 (native development), then install locked dependencies
npm ci

# 2. Build the core package — dist/ is generated and never committed
npm run build

# 3. Tool Factory gates (these need the build from step 2)
npx toolfactory check
npx toolfactory validate

# 4. Tests, split by lane
npm test             # portable core suite: tests/**/*.test.ts, no host deps, Node 22+
npm run test:integration   # native OpenClaw host suite, Node 24 only
npm run test:surface       # built CLI/MCP listing + missing-auth smokes, no credential
npm run test:token-route   # token-route leak check: read/send sites, URL and redaction
```

`npm test` deliberately discovers only `tests/**/*.test.ts`. The native host tests live under
`hosts/openclaw/` and run through `npm run test:integration`, so the portable lane never needs
host dependencies and never picks up a stale built `hosts/*/dist/*.test.js`. On Node 24 that
lane fails — it does not skip — when the root build is missing, the `file:../..` dependency is
not materialised, host devDependencies are absent, or the host suite fails. On Node 22 it
prints why it is skipped and the portable suite still covers the core completely.

### Run from the checkout without installing

Both surfaces run straight from this checkout's build:

```bash
node dist/toolfactory/cli.js --help
node dist/toolfactory/cli.js me --json '{}'
node dist/toolfactory/mcp.js     # MCP stdio server
```

`node dist/toolfactory/cli.js --help` lists every operation and exits 0 without a credential.

### Surface smokes

`npm run test:surface` proves the **built** artifact (run `npm run build` first) on both
surfaces, credential-free and offline:

- `scripts/smoke-cli-list.mjs` — `node dist/toolfactory/cli.js --help` lists all six
  operations plus the `mcp` subcommand, and `group_messages --help` exposes the
  schema-derived flags.
- `scripts/smoke-mcp-surface.mjs` — drives the real MCP protocol in-process over
  `InMemoryTransport` against `dist/toolfactory/mcp.js` with `@modelcontextprotocol/client`
  (already a local dependency; no `npx` fetch). Asserts all six tools in `tools/list` with
  `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`;
  then each `tools/call` without a token returns an **error** result carrying
  `missing_auth` while a `fetch` tripwire records **zero** network attempts.
- `scripts/smoke-missing-auth.mjs` — every operation on the built CLI without a token exits
  exactly `1`, prints the structured `{"code":"missing_auth"}` envelope on stderr, makes no
  network call and leaks no credential/header noise.

### Token-route leak check

`npm run test:token-route` (run `npm run build` first) is the executable counterpart of this
section's prose. A grep for `GROUPME_ACCESS_TOKEN` cannot prove the route — the name appears
legitimately in `src/`. What must never appear is the token *value*, so the check asserts three
things:

- **Static structure.** Every read of the token is the `ctx.config["GROUPME_ACCESS_TOKEN"]`
lookup: the check allows only `src/ops.ts` (the operations, one lookup per operation) and the
generated `src/toolfactory/config.ts` (the single env-injection boundary), and fails on any other
read site or on a direct `process.env` read; no `?access_token=` or `?token=` query parameter
exists anywhere in `src/`; `src/groupme/client.ts` builds exactly one `X-Access-Token` header on
a `GET` and keeps `scrubToken`/`redactUpstreamErrors`/`redactCause` wired; no 32-hex
credential-shaped literal sits in source.
- **Missing auth, on the built CLI.** `me` with the token scrubbed exits `1` with the parseable
`{"code":"missing_auth"}` envelope and no credential noise.
- **Present auth, at the handler layer.** With a sentinel token configured and `fetch` stubbed to
return an upstream error envelope that echoes the token, every operation's `GroupMeError`
message, `errors` list and attached cause carry `[redacted]` instead of the sentinel, the
request URL never contains it, and the `X-Access-Token` header does. That is the only route by
which the value could leak.

The check is hermetic: no network, no credential, no writes. Both halves were verified to fail
on a broken route (a `?access_token=` URL failed the static half; an unscrubbed error leaked
the sentinel and failed the behavioural half).

## Token setup (vault-only)

`GROUPME_ACCESS_TOKEN` is a **sensitive** Tool Factory config input. Hosts inject its value
from their vault; core reads it as `context().config["GROUPME_ACCESS_TOKEN"]` and sends it
only in the `X-Access-Token` header to the fixed official API host (`https://api.groupme.com`).

Do not put the token in a chat message, a committed `.env`, a GitHub Actions secret, a
fixture, a log line or an error payload. A token typed into a conversation is already
disclosed; treat one shared that way as compromised and rotate it. `.env` is gitignored and
exists only for the author-owned `npm run test:live` opt-in — the mock and CI tiers never read
it, never acquire a real credential and never call GroupMe.

With no token configured (the default for `npm test`, `npm run test:surface` and CI), every
operation fails fast with a structured `missing_auth` error and makes no network call. That
holds for all six operations on both surfaces, and `tests/surface-contract.test.ts` plus the two
smokes above keep it true for any operation added later.

## What is not available yet

The package is **unpublished**: there is no npm tarball, no tag and no release. The generated
install routes below (Agent Skill, `npx -y groupmetoolkit mcp`) are recorded for when a release
exists and fail today from a clean machine — use the checkout-local build instead. The
OpenClaw plugin route links this checkout, so it needs steps 1–2 above first.

## Offline checks vs. real-account proof

The gates above are credential-free and hermetic: mocked fixtures only, `GROUPME_ACCESS_TOKEN`
unset, zero GroupMe traffic. They prove the tool's shape — operation listing, annotations,
pagination semantics, redaction and error paths.

Proving the tool against a live GroupMe account is **externally blocked and overseer-owned**:
it needs the vault-backed token, which an automated checkout must never acquire. Calling
`me` with no `GROUPME_ACCESS_TOKEN` returns the structured `missing_auth` error and makes no
network call, so a real-account round trip cannot be performed here. Do not supply a credential as
part of a portable check.

Last offline evidence (mocked suite, no credential): `npm test` 166 passed / 1 skipped (the
credential-gated `live` case), `npm run test:surface` green on the built CLI and MCP surfaces,
`npm run test:integration` host suite passed on Node 24, and every Tool Factory gate green.
The checkout's manifest declares all six tools.

Runtime surface acceptance is separate and can be inspected without a credential. The installed
plugin has loaded and declares all six operations:

```bash
openclaw plugins inspect groupmetoolkit --runtime --json
# status: loaded, toolNames: chats, group, group_messages, groups, me, search_group_messages
```

That inspection proves the runtime accepted the current manifest; it says nothing about live
GroupMe data, which still requires the overseer's token and a real-account call.

<!-- tf:install -->
## Install

[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/groupmetoolkit)

- **Agent Skill** — `npx skills add GoatInAHat/groupmetoolkit`
- **MCP server** — `npx -y groupmetoolkit mcp`
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout

<!-- /tf:install -->
