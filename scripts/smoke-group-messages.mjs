#!/usr/bin/env node
// group_messages CLI smoke: mirrors scripts/smoke-groups-group.mjs (a script, not vitest,
// because the CLI under test intentionally exits non-zero on the error path).
//
// Proves, against dist/toolfactory/cli.js with global fetch mocked by mock-fetch.mjs:
//   1. `group_messages --group_id 123 --before_id 56 --limit 500` clamps to 100 through the
//      CLI's numeric flag parsing (schema must not reject 500), keeps server order
//      (55, 54, 53), preserves the attachment-only row (location attachment, no text), and
//      reports the before_id short page as end-of-history with nextBeforeId 55
//      (messages[0], the oldest examined) and nextAfterId 53 (the last element).
//   2. `group_messages --group_id 123 --after_id 50` is direction "after": after_id proves
//      only "no newer messages", so endOfHistory is false and hasContinuation is true. The
//      cursor sits below the newest examined row (53), so the progress guard must not trip.
//   3. `group_messages --group_id 123 --before_id 99` against upstream 304 is SUCCESS (exit
//      0, never an error exit), an empty page, endOfHistory, nextBeforeId null.
//   4. `group_messages --group_id 123 --before_id 5 --after_id 9` is rejected locally with
//      exit 1 and names both cursors (the local rejection path reaches the CLI).
// Every run also asserts the canary token, "X-Access-Token" and "Bearer" never appear in
// stdout/stderr, and that the request cursor never leaks into a printed URL.
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

/** Parse stdout as JSON, or record a failure and return undefined. */
function parseJson(label, run) {
  try {
    return JSON.parse(run.stdout);
  } catch {
    failures.push(`${label}: stdout is not JSON: ${(run.stdout + run.stderr).slice(0, 500)}`);
    return undefined;
  }
}

/** Shared credential-leak assertions for every run. */
function assertNoLeak(label, run) {
  const combined = `${run.stdout}${run.stderr}`;
  if (combined.includes(canary)) failures.push(`${label}: output leaked the canary token`);
  if (combined.includes("X-Access-Token")) failures.push(`${label}: output leaked the X-Access-Token header name`);
  if (combined.includes("Bearer")) failures.push(`${label}: output leaked an Authorization/Bearer header`);
  if (combined.includes("before_id=56")) failures.push(`${label}: stdout/stderr contains a request URL with before_id=56`);
  if (combined.includes("after_id=50")) failures.push(`${label}: stdout/stderr contains a request URL with after_id=50`);
  if (combined.includes("?X-Access-Token")) failures.push(`${label}: output contains a token in a query string`);
  return combined;
}

// 1. before_id with an over-limit request: clamp survives CLI Number() flag parsing.
const beforeRun = runCli(["group_messages", "--group_id", "123", "--before_id", "56", "--limit", "500"], "messages");
const beforeCombined = assertNoLeak("before", beforeRun);
if (beforeRun.status !== 0) failures.push(`before: expected exit 0, got ${beforeRun.status}: ${beforeCombined.slice(0, 300)}`);
const before = parseJson("before", beforeRun);
if (before) {
  if (before.limit !== 100) failures.push(`before: expected limit 100 after clamp, got ${JSON.stringify(before.limit)}`);
  if (before.limitClamped !== true) failures.push("before: expected limitClamped true for --limit 500");
  if (before.group_id !== "123") failures.push(`before: expected group_id "123", got ${JSON.stringify(before.group_id)}`);

  const ids = (before.messages ?? []).map((message) => message.id);
  if (JSON.stringify(ids) !== JSON.stringify(["55", "54", "53"])) {
    failures.push(`before: expected server-order ids [55,54,53], got ${JSON.stringify(ids)}`);
  }

  const byId = new Map((before.messages ?? []).map((message) => [message.id, message]));
  const attachmentOnly = byId.get("53");
  if (!attachmentOnly) failures.push("before: missing attachment-only message id 53");
  else {
    if ("text" in attachmentOnly && attachmentOnly.text !== null && attachmentOnly.text !== undefined) {
      failures.push(`before: attachment-only message 53 carries text ${JSON.stringify(attachmentOnly.text)}`);
    }
    const attachments = attachmentOnly.attachments ?? [];
    const location = attachments.find((attachment) => attachment?.type === "location");
    if (!location) failures.push(`before: message 53 lost its location attachment: ${JSON.stringify(attachments)}`);
    else if (location.name !== "here" || location.lat !== "40.7" || location.lng !== "-74.0") {
      failures.push(`before: location attachment mutated: ${JSON.stringify(location)}`);
    }
  }

  const imageMessage = byId.get("54");
  if (!imageMessage) failures.push("before: missing image message id 54");
  else {
    if (imageMessage.name !== "bob") failures.push(`before: expected author "bob" on 54, got ${JSON.stringify(imageMessage.name)}`);
    if (!(imageMessage.attachments ?? []).some((attachment) => attachment?.type === "image")) {
      failures.push(`before: message 54 lost its image attachment: ${JSON.stringify(imageMessage.attachments)}`);
    }
  }

  if (before.pagination?.direction !== "before") {
    failures.push(`before: expected direction "before", got ${JSON.stringify(before.pagination?.direction)}`);
  }
  if (before.pagination?.endOfHistory !== true) {
    failures.push("before: 3-of-100 is a short page, so endOfHistory must be true");
  }
  // Server order (D012): messages[0] is the oldest examined -> nextBeforeId.
  // messages[last] is the newest examined -> nextAfterId. The fixture is descending, so
  // 55 is the first element and 53 the last.
  if (before.pagination?.nextBeforeId !== "55") {
    failures.push(`before: expected nextBeforeId "55" (messages[0], oldest examined), got ${JSON.stringify(before.pagination?.nextBeforeId)}`);
  }
  if (before.pagination?.nextAfterId !== "53") {
    failures.push(`before: expected nextAfterId "53" (messages[last], newest examined), got ${JSON.stringify(before.pagination?.nextAfterId)}`);
  }
  if (before.pagination?.progressGuardTripped !== false) {
    failures.push("before: progress guard must not trip when the cursor advanced from 56 to 55");
  }
}

// 2. after_id direction: never claims the beginning of history. The cursor (50) sits below
// the newest examined row (53), so the page ADVANCES and the progress guard must not trip;
// a cursor at/above 53 would correctly trip the guard (covered by T02's vitest cases).
const afterRun = runCli(["group_messages", "--group_id", "123", "--after_id", "50"], "messages");
const afterCombined = assertNoLeak("after", afterRun);
if (afterRun.status !== 0) failures.push(`after: expected exit 0, got ${afterRun.status}: ${afterCombined.slice(0, 300)}`);
const after = parseJson("after", afterRun);
if (after) {
  if (after.pagination?.direction !== "after") {
    failures.push(`after: expected direction "after", got ${JSON.stringify(after.pagination?.direction)}`);
  }
  if (after.pagination?.endOfHistory !== false) {
    failures.push("after: after_id must never claim endOfHistory (it proves nothing about the oldest end)");
  }
  if (after.pagination?.hasContinuation !== true) {
    failures.push("after: after_id pages must be continuable (hasContinuation true)");
  }
  if (after.pagination?.nextAfterId !== "53") {
    failures.push(`after: expected nextAfterId "53" (server order last element), got ${JSON.stringify(after.pagination?.nextAfterId)}`);
  }
  if (after.pagination?.progressGuardTripped !== false) {
    failures.push("after: progress guard must not trip for an advancing cursor (50 below newest 53)");
  }
}

// 3. Upstream 304 is a success-shaped end-of-history, not an error exit.
const eohRun = runCli(["group_messages", "--group_id", "123", "--before_id", "99"], "messagesEndOfHistory");
const eohCombined = assertNoLeak("304", eohRun);
if (eohRun.status !== 0) failures.push(`304: expected exit 0 (304 is success), got ${eohRun.status}: ${eohCombined.slice(0, 300)}`);
const eoh = parseJson("304", eohRun);
if (eoh) {
  if (!Array.isArray(eoh.messages) || eoh.messages.length !== 0) {
    failures.push(`304: expected empty messages array, got ${JSON.stringify(eoh.messages)?.slice(0, 200)}`);
  }
  if (eoh.pagination?.endOfHistory !== true) failures.push("304: before_id 304 must report endOfHistory true");
  if (eoh.pagination?.nextBeforeId !== null) failures.push(`304: expected nextBeforeId null, got ${JSON.stringify(eoh.pagination?.nextBeforeId)}`);
  if (eoh.pagination?.direction !== "before") failures.push(`304: expected direction "before", got ${JSON.stringify(eoh.pagination?.direction)}`);
}

// 4. Conflicting cursors: local rejection reaches the CLI with exit 1, naming both keys.
const conflictRun = runCli(["group_messages", "--group_id", "123", "--before_id", "5", "--after_id", "9"], "messages");
const conflictCombined = assertNoLeak("conflict", conflictRun);
if (conflictRun.status !== 1) failures.push(`conflict: expected exit 1, got ${conflictRun.status}`);
for (const key of ["before_id", "after_id"]) {
  if (!conflictCombined.includes(key)) failures.push(`conflict: rejection message does not name ${key}: ${conflictCombined.slice(0, 300)}`);
}
if (!conflictCombined.includes("invalid_input")) {
  failures.push(`conflict: rejection missing invalid_input envelope: ${conflictCombined.slice(0, 300)}`);
}

if (failures.length > 0) {
  console.error("smoke-group-messages FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- before stdout ---");
  console.error(beforeRun.stdout);
  console.error("--- after stdout ---");
  console.error(afterRun.stdout);
  console.error("--- 304 stdout/stderr ---");
  console.error(`${eohRun.stdout}${eohRun.stderr}`);
  console.error("--- conflict stdout/stderr ---");
  console.error(conflictCombined);
  process.exit(1);
}

console.log(
  "smoke-group-messages OK: --limit 500 clamps to 100 (limitClamped) with server-order ids 55,54,53 and the location attachment intact; before_id short page is endOfHistory with nextBeforeId 55 (messages[0]) and nextAfterId 53 (last element); after_id 50 is continuable, not endOfHistory, nextAfterId 53, guard untripped; upstream 304 exits 0 with an empty endOfHistory page; conflicting cursors exit 1 naming before_id and after_id; token never appears in output",
);
