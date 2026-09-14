#!/usr/bin/env node
// groups/group CLI smoke: mirrors scripts/smoke-missing-auth.mjs (a script, not vitest,
// because the CLI under test intentionally exits non-zero on the error path).
//
// Proves, against dist/toolfactory/cli.js with global fetch mocked by mock-fetch.mjs:
//   1. `groups --page 2 --per-page 25 --omit memberships` prints a result whose keys are
//      exactly page/perPage/count/groups — never total or hasMore — and whose group keeps
//      members:null from the omit=memberships fixture.
//   2. `group --id 999999` against an upstream 404 prints the redacted not_found envelope,
//      and neither stdout nor stderr ever contains the fixture token.
// Exits non-zero when any assertion fails.
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const canary = "TESTTOKEN_SHOULD_NEVER_LEAK";
const mockArg = `--import ${root}scripts/mock-fetch.mjs`;

function runCli(args, fixture) {
  const env = {
    ...process.env,
    GROUPME_ACCESS_TOKEN: canary,
    SMOKE_GROUPME_FIXTURE: fixture,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, mockArg].filter(Boolean).join(" "),
  };
  return spawnSync(process.execPath, ["dist/toolfactory/cli.js", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

const failures = [];

// 1. groups happy path with pagination echo and omit=memberships (members:null).
const groupsRun = runCli(["groups", "--page", "2", "--per_page", "25", "--omit", "memberships"], "groups");
let groupsResult;
try {
  groupsResult = JSON.parse(groupsRun.stdout);
} catch {
  failures.push(`groups: stdout is not JSON: ${(groupsRun.stdout + groupsRun.stderr).slice(0, 500)}`);
}
if (groupsResult) {
  const keys = Object.keys(groupsResult).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["count", "groups", "page", "perPage"])) {
    failures.push(`groups: unexpected result keys ${keys} (total/hasMore must never appear)`);
  }
  if (groupsResult.page !== 2 || groupsResult.perPage !== 25 || groupsResult.count !== 1) {
    failures.push(`groups: pagination echo mismatch: ${JSON.stringify(groupsResult).slice(0, 200)}`);
  }
  if (groupsResult.groups?.[0]?.members !== null) {
    failures.push(`groups: expected members:null with omit=memberships, got ${JSON.stringify(groupsResult.groups?.[0]?.members)}`);
  }
}
if (groupsRun.status !== 0) failures.push(`groups: expected exit 0, got ${groupsRun.status}`);

// 2. Unknown group id -> redacted not_found, token never in output.
const groupRun = runCli(["group", "--id", "999999"], "groupNotFound");
const combined = `${groupRun.stdout}${groupRun.stderr}`;
if (!combined.includes("not_found")) {
  failures.push(`group: output lacks not_found: ${combined.slice(0, 300)}`);
}
if (combined.includes(canary) || combined.includes("X-Access-Token") || combined.includes("Bearer")) {
  failures.push("group: output leaked token or credential noise");
}
if (groupRun.status !== 1) failures.push(`group: expected exit 1, got ${groupRun.status}`);

if (failures.length > 0) {
  console.error("smoke-groups-group FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- groups stdout ---");
  console.error(groupsRun.stdout);
  console.error("--- group stdout/stderr ---");
  console.error(combined);
  process.exit(1);
}

console.log(
  "smoke-groups-group OK: groups echoes page/perPage/count (no total/hasMore) with members:null; unknown group id -> redacted not_found; token never appears in output",
);
