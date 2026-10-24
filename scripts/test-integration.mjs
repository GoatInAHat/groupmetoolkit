#!/usr/bin/env node
// Explicit native-host test lane: `npm run test:integration`.
//
// Root `npm test` discovers only tests/**/*.test.ts so the portable Node 22 CI lane
// needs no native host dependencies. That separation must not silently drop the
// native host metadata tests, so this wrapper runs the real host suite.
//
// Node 24 only, by design and stated explicitly: the OpenClaw native CLI used for
// `plugins validate` requires Node 24 upstream. On Node 22 the lane prints why it is
// skipped and exits 0; on Node 24, missing setup or a failing host suite fails.
//
// Preconditions on Node 24 (fail loudly, never skip):
//   1. root build exists (dist/toolfactory/cli.js) — run `npm run build` first
//   2. the `file:../..` dependency is materialised in hosts/<id>/node_modules
//   3. host devDependencies are installed (vitest, typescript, openclaw)
// Each precondition that is missing exits non-zero with the exact command to run.
// Nothing here reads GROUPME_ACCESS_TOKEN or calls GroupMe: the host suite asserts
// metadata only, and the credential is scrubbed from the child environment.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const HOST = "hosts/openclaw";
const HOST_DIR = join(ROOT, HOST);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) {
  console.log(
    `test:integration: skipping native host suite on Node ${process.versions.node}. ` +
      "The OpenClaw native CLI requires Node 24; the portable core suite (`npm test`) " +
      "provides complete coverage on Node 22 without native host dependencies.",
  );
  process.exit(0);
}

const problems = [];
if (!existsSync(join(ROOT, "dist", "toolfactory", "cli.js"))) {
  problems.push("root build missing: run `npm run build`");
}
if (!existsSync(join(HOST_DIR, "node_modules", "groupmetoolkit", "dist", "ops.js"))) {
  problems.push(
    `materialised file:../.. dependency missing: run \`npm install --prefix ${HOST}\` (install-links=true materialises it)`,
  );
}
if (!existsSync(join(HOST_DIR, "node_modules", "vitest"))) {
  problems.push(`host devDependencies missing: run \`npm install --prefix ${HOST}\``);
}
if (problems.length > 0) {
  console.error("test:integration FAILED: Node 24 native host setup incomplete.");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// Credential-free by construction: the host suite is metadata-only.
const childEnv = { ...process.env };
delete childEnv.GROUPME_ACCESS_TOKEN;

console.log(`test:integration: running ${HOST} host suite on Node ${process.versions.node}`);
const result = spawnSync("npm", ["--prefix", HOST, "test"], {
  cwd: ROOT,
  env: childEnv,
  stdio: "inherit",
});

if (result.error) {
  console.error("test:integration FAILED: could not spawn npm:", result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`test:integration FAILED: host suite exited ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log("test:integration OK: native host suite passed on Node 24");
