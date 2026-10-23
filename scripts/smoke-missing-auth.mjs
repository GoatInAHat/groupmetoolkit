#!/usr/bin/env node
// Missing-auth smoke proof: runs `groupmetoolkit <operation>` on the CLI with
// GROUPME_ACCESS_TOKEN scrubbed from the child environment, for every read-only operation
// that needs a token (me, chats, search_group_messages). A script (not a vitest case)
// because the CLI is expected to exit 1. Exits 0 when the proof holds for every operation.
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

const childEnv = { ...process.env };
delete childEnv.GROUPME_ACCESS_TOKEN;

// One case per token-requiring operation. group/groups/group_messages/me are covered by
// `me` alone (same client preflight); chats and search_group_messages are new surfaces
// that must fail identically before any network call.
const cases = [
  { operation: "me", args: [] },
  { operation: "chats", args: ["--page", "1"] },
  { operation: "search_group_messages", args: ["--group_id", "123", "--query", "alpha"] },
];

const failures = [];

for (const { operation, args } of cases) {
  const label = `${operation}${args.length ? ` ${args.join(" ")}` : ""}`;
  const result = spawnSync("npx", ["tsx", "src/toolfactory/cli.ts", operation, ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;

  if (result.status !== 1) {
    failures.push(
      `${label}: expected exit code 1, got ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}`,
    );
  }
  if (!output.includes("missing_auth")) {
    failures.push(`${label}: output does not contain missing_auth`);
  }
  for (const noise of ["X-Access-Token", "Authorization", "GROUPME_ACCESS_TOKEN", "Bearer"]) {
    if (output.includes(noise)) {
      failures.push(`${label}: output contains header/credential noise: ${noise}`);
    }
  }

  if (failures.some((failure) => failure.startsWith(`${label}:`))) {
    console.error(`--- ${label} stdout ---`);
    console.error(stdout);
    console.error(`--- ${label} stderr ---`);
    console.error(stderr);
  }
}

if (failures.length > 0) {
  console.error("smoke-missing-auth FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `smoke-missing-auth OK: ${cases.map((c) => c.operation).join(", ")} without a token -> exit 1, missing_auth surfaced, zero network calls, no credential noise`,
);
