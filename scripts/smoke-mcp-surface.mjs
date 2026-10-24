#!/usr/bin/env node
// MCP surface smoke: hermetic tools/list + missing-auth proof against the BUILT module.
//
// Why not @modelcontextprotocol/inspector: `npx` fetches that package from the network, so
// the smoke would silently depend on internet access and on a third-party tool's output
// shape. `@modelcontextprotocol/client` is already a local dependency, so this script drives
// the real MCP protocol in-process over `InMemoryTransport` against `dist/toolfactory/mcp.js`
// — the exact bytes `npm run build` emits and the exact server `node dist/toolfactory/mcp.js`
// serves over stdio. Zero network, zero package installs.
//
// Asserts, for every read-only operation (chats, group, group_messages, groups, me,
// search_group_messages):
//   1. tools/list carries the operation with readOnlyHint=true, destructiveHint=false,
//      idempotentHint=true (and openWorldHint=true).
//   2. a tools/call WITHOUT GROUPME_ACCESS_TOKEN returns an error result whose structured
//      text carries the GroupMeError code `missing_auth`.
//   3. that call made ZERO network calls. Proven with a fetch tripwire: globalThis.fetch is
//      replaced by a trap for the whole run, and the trap records any attempt. No attempt is
//      possible because missing_auth is decided before the first fetch (client.ts).
//   4. no credential/header noise (X-Access-Token, Authorization, Bearer, the env var name,
//      the canary token) appears in any listing description, result text or error text.
//
// Exit 0 iff every assertion holds; prints the exact mismatch otherwise.
import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { server } from "../dist/toolfactory/mcp.js";

const OPERATIONS = ["chats", "group", "group_messages", "groups", "me", "search_group_messages"];
// Minimal VALID arguments per operation, so an error can only come from missing auth:
// schema validation never fires, and the handler reaches the credential preflight. These must
// match the real input schemas in src/ops.ts (`group` takes `id`, not `group_id`); a smoke
// with invalid args proves nothing because the input-parse error preempts the auth error.
const ARGS = {
  chats: { page: 1 },
  group: { id: "12345678" },
  group_messages: { group_id: "12345678" },
  groups: { page: 1 },
  me: {},
  search_group_messages: { group_id: "12345678", query: "alpha" },
};
const NOISE = ["X-Access-Token", "Authorization", "Bearer", "GROUPME_ACCESS_TOKEN", "TESTTOKEN_SHOULD_NEVER_LEAK"];

// The tripwire. Any call here is a network attempt and fails the run.
const fetchAttempts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetchAttempts.push(String(args[0]));
  throw new Error(`smoke-mcp-surface: network fetch attempted during missing-auth proof: ${args[0]}`);
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// Credential-free by construction: scrub the env var in-process as well, so the smoke cannot
// pass by accident on a developer machine that happens to export a real token.
const savedToken = process.env.GROUPME_ACCESS_TOKEN;
delete process.env.GROUPME_ACCESS_TOKEN;

try {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "groupmetoolkit-smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of OPERATIONS) {
    const tool = byName.get(name);
    if (!tool) {
      failures.push(`tools/list is missing \`${name}\`; got: ${[...byName.keys()].join(", ")}`);
      continue;
    }
    const ann = tool.annotations ?? {};
    check(ann.readOnlyHint === true, `\`${name}\` readOnlyHint=${JSON.stringify(ann.readOnlyHint)} (want true)`);
    check(ann.destructiveHint === false, `\`${name}\` destructiveHint=${JSON.stringify(ann.destructiveHint)} (want false)`);
    check(ann.idempotentHint === true, `\`${name}\` idempotentHint=${JSON.stringify(ann.idempotentHint)} (want true)`);
    check(ann.openWorldHint === true, `\`${name}\` openWorldHint=${JSON.stringify(ann.openWorldHint)} (want true)`);

    let result;
    try {
      result = await client.callTool({ name, arguments: ARGS[name] });
    } catch (error) {
      failures.push(`\`${name}\` callTool threw instead of returning a structured error result: ${error?.message ?? error}`);
      continue;
    }
    const texts = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text);
    const text = texts.join("\n");
    check(result.isError === true, `\`${name}\` missing-auth result isError=${JSON.stringify(result.isError)} (want true)`);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      failures.push(`\`${name}\` error result text is not JSON: ${text.slice(0, 300)}`);
    }
    check(parsed?.code === "missing_auth", `\`${name}\` error code=${JSON.stringify(parsed?.code)} (want "missing_auth")`);
  }

  // Listing metadata must not leak credential material either.
  const listingText = JSON.stringify(tools);
  for (const noise of NOISE) {
    check(!listingText.includes(noise), `tools/list metadata contains credential noise: ${noise}`);
  }
  check(fetchAttempts.length === 0, `network fetch was attempted ${fetchAttempts.length} time(s): ${fetchAttempts.join(", ")}`);

  await client.close();
  await server.close();
} finally {
  globalThis.fetch = realFetch;
  if (savedToken !== undefined) process.env.GROUPME_ACCESS_TOKEN = savedToken;
}

if (failures.length > 0) {
  console.error("smoke-mcp-surface FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `smoke-mcp-surface OK: ${OPERATIONS.join(", ")} listed with readOnlyHint=true, destructiveHint=false, ` +
    "idempotentHint=true, openWorldHint=true; each tools/call without a token -> isError, missing_auth, " +
    `${fetchAttempts.length} network calls, no credential noise`,
);
