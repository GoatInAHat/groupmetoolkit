#!/usr/bin/env node
// CLI surface smoke: proves the BUILT CLI lists every read-only operation.
//
// Runs `node dist/toolfactory/cli.js --help` and, for each operation, asserts it is listed
// as a top-level command (`<operation> [options]`) together with the `--json <arguments>`
// escape hatch and its documented description. Also asserts the `mcp` subcommand exists,
// because that is the only route a host has to the MCP surface from the CLI.
//
// No credential is read and no network is touched: `--help` exits before any action runs.
// Exit 0 iff every operation is listed; prints the exact mismatch otherwise.
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const CLI = "dist/toolfactory/cli.js";

const result = spawnSync(process.execPath, [CLI, "--help"], { cwd: ROOT, encoding: "utf8" });
if (result.error) {
  console.error(`smoke-cli-list: could not run ${CLI}: ${result.error.message} (run \`npm run build\` first)`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`smoke-cli-list: --help exited ${result.status}`);
  console.error(result.stderr?.slice(-2000));
  process.exit(result.status ?? 1);
}

const help = result.stdout ?? "";
const failures = [];
const OPERATIONS = ["chats", "group", "group_messages", "groups", "me", "search_group_messages"];

for (const name of OPERATIONS) {
  // commander renders top-level commands as `  <name> [options]  <description>`.
  const listed = new RegExp(`^\\s{2}${name}\\s+\\[options\\]`, "m").test(help);
  if (!listed) failures.push(`operation \`${name}\` is not listed in --help`);
  if (!new RegExp(`^\\s{2}${name}\\s+\\[options\\].*\\S`, "m").test(help)) {
    failures.push(`operation \`${name}\` is listed without a description`);
  }
}

if (!/^\s{2}mcp\s+\[options\]/m.test(help)) failures.push("`mcp` subcommand is not listed in --help");

// Per-operation help must expose the schema-derived flags AND the --json escape hatch, so a
// host can call it either way. --json is deliberately per-command (commander does not hoist
// subcommand options into the top-level help), so it is asserted here, not above. One
// representative operation proves the flag-generation path for all of them.
const detail = spawnSync(process.execPath, [CLI, "group_messages", "--help"], { cwd: ROOT, encoding: "utf8" });
if (detail.status !== 0) {
  failures.push(`\`group_messages --help\` exited ${detail.status}`);
} else {
  for (const flag of ["--group_id", "--limit", "--before_id", "--after_id", "--json"]) {
    if (!detail.stdout.includes(flag)) failures.push(`\`group_messages --help\` is missing ${flag}`);
  }
}

if (failures.length > 0) {
  console.error("smoke-cli-list FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- --help ---");
  console.error(help);
  process.exit(1);
}

console.log(
  `smoke-cli-list OK: ${OPERATIONS.join(", ")} + mcp listed by \`node ${CLI} --help\`; ` +
    "group_messages --help exposes the schema-derived flags",
);
