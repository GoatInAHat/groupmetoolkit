#!/usr/bin/env node
// Regeneration-safety check: `npx toolfactory build` must not clobber
// author-owned files (.gitignore, AGENTS.md, .agents/mcp/servers.json).
// Exit non-zero if any of the three changes hash across the build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const FILES = [".gitignore", "AGENTS.md", ".agents/mcp/servers.json"];

const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const before = Object.fromEntries(FILES.map((f) => [f, hash(f)]));

const build = spawnSync("npx", ["toolfactory", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  console.error("check-regen-safety: toolfactory build failed");
  process.exit(build.status ?? 1);
}

const changed = FILES.filter((f) => hash(f) !== before[f]);
if (changed.length === 0) {
  console.log("check-regen-safety: OK — no author-owned file drifted");
  process.exit(0);
}
for (const f of changed) {
  console.error(`check-regen-safety: DRIFT ${f} changed during build`);
}
process.exit(1);
