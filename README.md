# groupmetoolkit

Read-only GroupMe account tools usable from OpenClaw without a connected MacBook.

Six read-only operations — `me`, `groups`, `group`, `chats`, `group_messages` and
`search_group_messages` — over one GroupMe access token. Nothing is persisted: every call
returns redacted, structured metadata and writes no message history to disk.

All operations authenticate with `GROUPME_ACCESS_TOKEN` (vault-backed, hosts inject the
value): the token is sent only in the `X-Access-Token` header, consumed via
`context().config`, and never appears in URLs, logs, errors, fixtures, or outputs. Missing
auth surfaces a structured `auth_error` with no network call.

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

## Token setup (vault-only)

`GROUPME_ACCESS_TOKEN` is a **sensitive** Tool Factory config input. Hosts inject its value
from their vault; core reads it as `context().config["GROUPME_ACCESS_TOKEN"]` and sends it
only in the `X-Access-Token` header to the fixed official API host (`https://api.groupme.com`).

Do not put the token in a chat message, a committed `.env`, a GitHub Actions secret, a
fixture, a log line or an error payload. A token typed into a conversation is already
disclosed; treat one shared that way as compromised and rotate it. `.env` is gitignored and
exists only for the author-owned `npm run test:live` opt-in — the mock and CI tiers never read
it, never acquire a real credential and never call GroupMe.

With no token configured (the default for `npm test` and CI), every operation fails fast with
a structured `auth_error` and makes no network call.

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
`me` with no `GROUPME_ACCESS_TOKEN` returns the structured `auth_error` and makes no network
call, so a real-account round trip cannot be performed here. Do not supply a credential as
part of a portable check.

Last offline evidence (mocked suite, no credential): `npm test` 151 passed / 1 skipped (the
credential-gated `live` case), `npm run test:integration` host suite passed on Node 24, and
every Tool Factory gate green. The checkout's manifest declares all six tools.

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
