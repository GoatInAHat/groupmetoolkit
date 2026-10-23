#!/usr/bin/env node
// chats CLI smoke: mirrors scripts/smoke-groups-group.mjs (a script, not vitest, because the
// error path intentionally exits non-zero).
//
// Proves, against dist/toolfactory/cli.js with global fetch mocked by mock-fetch.mjs:
//   1. `chats --page 2 --per_page 25` prints a result whose keys are exactly
//      page/perPage/count/chats — never total/hasMore/nextPage — echoing page 2 and
//      perPage 25, with other_user.id normalized to the string "777", last_message.text
//      null preserved, the image attachment intact, and the upstream-only conversation
//      keys (sender_id/recipient_id/conversation_id) dropped.
//   2. `chats` with no flags against an empty page echoes page 1 and perPage 0 (the
//      documented index has no default per_page, so nothing is guessed), count 0.
// Every run asserts the canary token, "X-Access-Token", "Bearer" and "?X-Access-Token"
// never appear in stdout/stderr. Exits non-zero when any assertion fails.
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

function parseJson(label, run) {
  try {
    return JSON.parse(run.stdout);
  } catch {
    failures.push(`${label}: stdout is not JSON: ${(run.stdout + run.stderr).slice(0, 500)}`);
    return undefined;
  }
}

function assertNoLeak(label, run) {
  const combined = `${run.stdout}${run.stderr}`;
  if (combined.includes(canary)) failures.push(`${label}: output leaked the canary token`);
  if (combined.includes("X-Access-Token")) failures.push(`${label}: output leaked the X-Access-Token header name`);
  if (combined.includes("Bearer")) failures.push(`${label}: output leaked an Authorization/Bearer header`);
  if (combined.includes("?X-Access-Token")) failures.push(`${label}: output leaked the token into a query string`);
}

// 1. chats happy path with pagination echo and projection.
const pageRun = runCli(["chats", "--page", "2", "--per_page", "25"], "chats");
const page = parseJson("chats --page 2", pageRun);
if (page) {
  const keys = Object.keys(page).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["chats", "count", "page", "perPage"])) {
    failures.push(`chats --page 2: unexpected result keys ${keys} (total/hasMore/nextPage must never appear)`);
  }
  if (page.page !== 2 || page.perPage !== 25 || page.count !== 1) {
    failures.push(`chats --page 2: pagination echo mismatch: ${JSON.stringify(page).slice(0, 300)}`);
  }
  const chat = page.chats?.[0];
  if (chat?.other_user?.id !== "777") {
    failures.push(`chats --page 2: other_user.id should be the string "777", got ${JSON.stringify(chat?.other_user?.id)}`);
  }
  if (!("text" in (chat?.last_message ?? {})) || chat.last_message.text !== null) {
    failures.push(`chats --page 2: last_message.text must be preserved as null, got ${JSON.stringify(chat?.last_message?.text)}`);
  }
  if (chat?.last_message?.attachments?.[0]?.type !== "image") {
    failures.push(`chats --page 2: image attachment missing from last_message`);
  }
  const serialized = JSON.stringify(page);
  for (const dropped of ["sender_id", "recipient_id", "conversation_id"]) {
    if (serialized.includes(`"${dropped}"`)) failures.push(`chats --page 2: upstream-only key "${dropped}" was not dropped`);
  }
}
if (pageRun.status !== 0) failures.push(`chats --page 2: expected exit 0, got ${pageRun.status}`);
assertNoLeak("chats --page 2", pageRun);

// 2. chats with no flags against an empty page: page 1, perPage 0, count 0.
const emptyRun = runCli(["chats"], "chatsEmpty");
const empty = parseJson("chats (no flags)", emptyRun);
if (empty) {
  if (empty.page !== 1 || empty.perPage !== 0 || empty.count !== 0) {
    failures.push(`chats (no flags): expected page 1 / perPage 0 / count 0, got ${JSON.stringify(empty)}`);
  }
  if (!Array.isArray(empty.chats) || empty.chats.length !== 0) {
    failures.push(`chats (no flags): expected an empty chats array, got ${JSON.stringify(empty.chats)}`);
  }
  const keys = Object.keys(empty).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["chats", "count", "page", "perPage"])) {
    failures.push(`chats (no flags): unexpected result keys ${keys}`);
  }
}
if (emptyRun.status !== 0) failures.push(`chats (no flags): expected exit 0, got ${emptyRun.status}`);
assertNoLeak("chats (no flags)", emptyRun);

if (failures.length > 0) {
  console.error("smoke-chats FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- chats --page 2 stdout ---");
  console.error(pageRun.stdout);
  console.error("--- chats (no flags) stdout ---");
  console.error(emptyRun.stdout);
  process.exit(1);
}

console.log(
  "smoke-chats OK: chats echoes page/perPage/count (no total/hasMore) with other_user.id \"777\" and null last_message text, drops upstream-only conversation keys; omitted input echoes page 1 / perPage 0; token never appears in output",
);
