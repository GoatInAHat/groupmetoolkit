#!/usr/bin/env node
// Missing-auth smoke proof: runs `groupmetoolkit me` on the CLI with GROUPME_ACCESS_TOKEN
// scrubbed from the child environment. A script (not a vitest case) because the CLI is
// expected to exit 1. Reused by T04 and S05. Exits 0 when the proof holds.
import { spawnSync } from "node:child_process";

const childEnv = { ...process.env };
delete childEnv.GROUPME_ACCESS_TOKEN;

const result = spawnSync("npx", ["tsx", "src/toolfactory/cli.ts", "me"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: childEnv,
  encoding: "utf8",
  shell: process.platform === "win32",
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const output = `${stdout}${stderr}`;

const failures = [];
if (result.status !== 1) {
  failures.push(`expected exit code 1, got ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}`);
}
if (!output.includes("missing_auth")) {
  failures.push("output does not contain missing_auth");
}
for (const noise of ["X-Access-Token", "Authorization", "GROUPME_ACCESS_TOKEN", "Bearer"]) {
  if (output.includes(noise)) {
    failures.push(`output contains header/credential noise: ${noise}`);
  }
}

if (failures.length > 0) {
  console.error("smoke-missing-auth FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- stdout ---");
  console.error(stdout);
  console.error("--- stderr ---");
  console.error(stderr);
  process.exit(1);
}

console.log(
  "smoke-missing-auth OK: me without a token -> exit 1, missing_auth surfaced, zero network calls, no credential noise",
);
