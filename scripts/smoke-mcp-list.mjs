#!/usr/bin/env node
// MCP surface smoke: tools/list via @modelcontextprotocol/inspector --cli.
// Asserts every read-only operation (me, groups, group, group_messages) is listed with readOnlyHint=true,
// destructiveHint=false, idempotentHint=true. Exit non-zero otherwise.
import { spawnSync } from "node:child_process";

const res = spawnSync(
  "npx",
  [
    "@modelcontextprotocol/inspector",
    "--cli",
    "--config",
    "dev.toolfactory/inspector.json",
    "--server",
    "groupmetoolkit",
    "--method",
    "tools/list",
  ],
  { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
);

if (res.error) {
  console.error("smoke-mcp-list: failed to spawn inspector:", res.error.message);
  process.exit(1);
}
if (res.status !== 0) {
  console.error("smoke-mcp-list: inspector exited", res.status);
  console.error(res.stderr?.slice(-2000));
  process.exit(res.status ?? 1);
}

let parsed;
try {
  parsed = JSON.parse(res.stdout);
} catch {
  console.error("smoke-mcp-list: stdout is not JSON:\n" + res.stdout.slice(-2000));
  process.exit(1);
}

const tools = parsed?.tools ?? (Array.isArray(parsed) ? parsed : null);
if (!Array.isArray(tools)) {
  console.error("smoke-mcp-list: no tools array in response:\n" + JSON.stringify(parsed).slice(0, 1000));
  process.exit(1);
}

const operations = ["me", "groups", "group", "group_messages"];
const problems = [];
for (const name of operations) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    problems.push(`tool \`${name}\` not listed; got: ${tools.map((t) => t.name)}`);
    continue;
  }
  const ann = tool.annotations ?? {};
  if (ann.readOnlyHint !== true) problems.push(`\`${name}\` readOnlyHint=${JSON.stringify(ann.readOnlyHint)} (want true)`);
  if (ann.destructiveHint !== false) problems.push(`\`${name}\` destructiveHint=${JSON.stringify(ann.destructiveHint)} (want false)`);
  if (ann.idempotentHint !== true) problems.push(`\`${name}\` idempotentHint=${JSON.stringify(ann.idempotentHint)} (want true)`);
}

if (problems.length) {
  console.error("smoke-mcp-list: annotation/listing mismatches:\n  " + problems.join("\n  "));
  console.error("annotations:", JSON.stringify(Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]))));
  process.exit(1);
}

console.log(
  `smoke-mcp-list: OK — ${operations.join(", ")} listed with readOnlyHint=true, destructiveHint=false, idempotentHint=true`,
);
