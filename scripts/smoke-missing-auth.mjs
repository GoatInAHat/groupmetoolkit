#!/usr/bin/env node
// Missing-auth smoke proof: runs EVERY read-only operation on the BUILT CLI with
// GROUPME_ACCESS_TOKEN scrubbed from the child environment. A script (not a vitest case)
// because the CLI is expected to exit 1.
//
// This is the per-surface complement to T05's missing_auth unit tests: it proves the built
// artifact — not the source — fails closed. `src/toolfactory/cli.ts` is generated, so a
// regeneration that broke the error path would show up here and nowhere else.
//
// Asserts, per operation:
//   - exit code is exactly 1 (never 0, never a crash signal),
//   - the printed error carries the structured code `missing_auth` (client.ts throws
//     GroupMeError whose message IS the redacted JSON envelope),
//   - the output contains no credential/header noise,
//   - no network call happened (mock-fetch.mjs is NOT loaded and no fixture is set, so any
//     fetch would be a real request; missing_auth is decided before the first fetch).
//
// Exits 0 when the proof holds for every operation.
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

const childEnv = { ...process.env };
delete childEnv.GROUPME_ACCESS_TOKEN;
// No fixture: if anything reached fetch it would hit the real GroupMe API.
delete childEnv.SMOKE_GROUPME_FIXTURE;

// One case per operation, with arguments that PASS the input schema, so the only possible
// error is the credential preflight. `group` takes `id`; the message operations take
// `group_id` (src/ops.ts).
const cases = [
  { operation: "me", args: [] },
  { operation: "groups", args: ["--page", "1"] },
  { operation: "group", args: ["--id", "12345678"] },
  { operation: "group_messages", args: ["--group_id", "12345678"] },
  { operation: "chats", args: ["--page", "1"] },
  { operation: "search_group_messages", args: ["--group_id", "12345678", "--query", "alpha"] },
];

const NOISE = ["X-Access-Token", "Authorization", "GROUPME_ACCESS_TOKEN", "Bearer", "TESTTOKEN_SHOULD_NEVER_LEAK"];
const failures = [];

for (const { operation, args } of cases) {
  const label = `${operation}${args.length ? ` ${args.join(" ")}` : ""}`;
  const result = spawnSync(process.execPath, ["dist/toolfactory/cli.js", operation, ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;
  const problems = [];

  if (result.error) problems.push(`spawn failed: ${result.error.message} (run \`npm run build\` first)`);
  if (result.status !== 1) {
    problems.push(
      `expected exit code 1, got ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}`,
    );
  }
  if (!output.includes("missing_auth")) problems.push("output does not contain missing_auth");
  // The structured envelope must be parseable JSON, not prose: hosts switch on `code`.
  // The generated CLI's catch handler writes `error.message` (the redacted envelope) to
  // STDERR and exits 1, so stderr is where the machine-readable error lives.
  const json = stderr.trim();
  try {
    const envelope = JSON.parse(json);
    if (envelope?.code !== "missing_auth") problems.push(`stderr JSON code=${JSON.stringify(envelope?.code)} (want missing_auth)`);
  } catch {
    problems.push(`stderr is not a JSON envelope: ${json.slice(0, 200)}`);
  }
  for (const noise of NOISE) {
    if (output.includes(noise)) problems.push(`output contains header/credential noise: ${noise}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) failures.push(`${label}: ${problem}`);
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
  `smoke-missing-auth OK: ${cases.map((c) => c.operation).join(", ")} without a token -> exit 1, ` +
    "structured missing_auth JSON envelope, zero network calls, no credential noise",
);
