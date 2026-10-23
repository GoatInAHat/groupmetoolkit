#!/usr/bin/env node
// search_group_messages CLI smoke: mirrors scripts/smoke-group-messages.mjs (a script, not
// vitest, because the CLI under test intentionally exits non-zero on some paths).
//
// Proves, against dist/toolfactory/cli.js with global fetch mocked by mock-fetch.mjs:
//   1. `search_group_messages --group_id 123 --query alpha --budget 105 --limit 100
//      --maxMatches 100` (searchPages fixture: a full 100-row page then a full 100-row page)
//      is budget-limited, not exhausted: exactly two fetches, scanned 105, pagesFetched 2,
//      endOfHistory false, budget_exhausted in warnings, nextBeforeId = oldest examined row
//      of page 2 (196), every match case-insensitively containing "alpha".
//   2. `--query alpha --budget 900 --limit 500` clamps through CLI numeric flag parsing:
//      budget 500 + budgetClamped, limit 100 + limitClamped (the schema must not reject).
//   3. searchShort (a 3-row page) is genuine end-of-history: endOfHistory true,
//      nextBeforeId null, no budget_exhausted.
//   4. searchEndOfHistory (full page then upstream 304) exits 0 with endOfHistory true and
//      nextBeforeId null: a 304 is success, never an error.
//   5. `--query alpha` with no budget is budget-limited at the default 100 on the full first
//      page: scanned 100, endOfHistory false, budget_exhausted, no budgetClamped.
// Every run asserts the canary token, X-Access-Token, Bearer and "?X-Access-Token" never
// appear in stdout/stderr, and that the output never carries a "query=" or "text=" request
// parameter (GroupMe has no server-side search: D003).
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

/** Shared credential-leak and no-server-search assertions for every run. */
function assertNoLeak(label, run) {
  const combined = `${run.stdout}${run.stderr}`;
  if (combined.includes(canary)) failures.push(`${label}: output leaked the canary token`);
  if (combined.includes("X-Access-Token")) failures.push(`${label}: output leaked the X-Access-Token header name`);
  if (combined.includes("Bearer")) failures.push(`${label}: output leaked an Authorization/Bearer header`);
  if (combined.includes("?X-Access-Token")) failures.push(`${label}: output contains a token in a query string`);
  // The scan is client-side: no request may carry a server-side search parameter.
  if (combined.includes("query=")) failures.push(`${label}: output contains a "query=" request parameter`);
  if (combined.includes("text=")) failures.push(`${label}: output contains a "text=" request parameter`);
  return combined;
}

/** Every match's text must contain the needle case-insensitively (null text never matches). */
function assertMatchesContain(label, result, needle) {
  const matches = result.matches ?? [];
  if (!Array.isArray(matches)) {
    failures.push(`${label}: matches is not an array: ${JSON.stringify(matches).slice(0, 200)}`);
    return;
  }
  for (const match of matches) {
    if (typeof match.text !== "string" || !match.text.toLowerCase().includes(needle)) {
      failures.push(`${label}: match ${JSON.stringify(match.id)} does not contain "${needle}": ${JSON.stringify(match.text)}`);
    }
  }
}

// 1. Budget boundary on the two-full-page fixture: budget-limited, never exhausted.
const budgetRun = runCli(
  ["search_group_messages", "--group_id", "123", "--query", "alpha", "--budget", "105", "--limit", "100", "--maxMatches", "100"],
  "searchPages",
);
const budgetCombined = assertNoLeak("budget", budgetRun);
if (budgetRun.status !== 0) failures.push(`budget: expected exit 0, got ${budgetRun.status}: ${budgetCombined.slice(0, 300)}`);
const budget = parseJson("budget", budgetRun);
if (budget) {
  if (budget.group_id !== "123") failures.push(`budget: expected group_id "123", got ${JSON.stringify(budget.group_id)}`);
  if (budget.budget !== 105) failures.push(`budget: expected budget 105, got ${JSON.stringify(budget.budget)}`);
  if (budget.budgetClamped !== false) failures.push("budget: --budget 105 is in range, so budgetClamped must be false");
  if (budget.limit !== 100) failures.push(`budget: expected limit 100, got ${JSON.stringify(budget.limit)}`);
  if (budget.limitClamped !== false) failures.push("budget: limit 100 is the official max, so limitClamped must be false");
  if (budget.scanned !== 105) failures.push(`budget: expected scanned 105, got ${JSON.stringify(budget.scanned)}`);
  if (budget.pagesFetched !== 2) failures.push(`budget: expected pagesFetched 2, got ${JSON.stringify(budget.pagesFetched)}`);
  if (budget.matched !== 55) failures.push(`budget: expected matched 55 (50 + 5), got ${JSON.stringify(budget.matched)}`);
  if (budget.endOfHistory !== false) failures.push("budget: a budget stop on a full page must not claim endOfHistory");
  if (!(budget.warnings ?? []).includes("budget_exhausted")) {
    failures.push(`budget: expected budget_exhausted in warnings, got ${JSON.stringify(budget.warnings)}`);
  }
  if ((budget.warnings ?? []).includes("match_cap_reached")) failures.push("budget: maxMatches 100 was not reached; match_cap_reached must be absent");
  // Page 2 descends 200..101; the first 5 rows examined are 200..196, so 196 is the oldest.
  if (budget.nextBeforeId !== "196") failures.push(`budget: expected nextBeforeId "196" (oldest examined of page 2), got ${JSON.stringify(budget.nextBeforeId)}`);
  assertMatchesContain("budget", budget, "alpha");
}

// 2. Clamps survive the CLI's numeric flag parsing (the schema must accept 900/500).
const clampRun = runCli(
  ["search_group_messages", "--group_id", "123", "--query", "alpha", "--budget", "900", "--limit", "500"],
  "searchShort",
);
const clampCombined = assertNoLeak("clamp", clampRun);
if (clampRun.status !== 0) failures.push(`clamp: expected exit 0, got ${clampRun.status}: ${clampCombined.slice(0, 300)}`);
const clamp = parseJson("clamp", clampRun);
if (clamp) {
  if (clamp.budget !== 500) failures.push(`clamp: expected budget 500 after clamp, got ${JSON.stringify(clamp.budget)}`);
  if (clamp.budgetClamped !== true) failures.push("clamp: expected budgetClamped true for --budget 900");
  if (clamp.limit !== 100) failures.push(`clamp: expected limit 100 after clamp, got ${JSON.stringify(clamp.limit)}`);
  if (clamp.limitClamped !== true) failures.push("clamp: expected limitClamped true for --limit 500");
}

// 3. A short page genuinely exhausts the scan.
// The short fixture's rows read "nothing here", so query "nothing" DOES match all 3: use a
// needle that matches none of them to prove a zero-match scan is still end-of-history.
const shortRun = runCli(["search_group_messages", "--group_id", "123", "--query", "absent", "--limit", "100"], "searchShort");
const shortCombined = assertNoLeak("short", shortRun);
if (shortRun.status !== 0) failures.push(`short: expected exit 0, got ${shortRun.status}: ${shortCombined.slice(0, 300)}`);
const short = parseJson("short", shortRun);
if (short) {
  if (short.endOfHistory !== true) failures.push("short: a 3-of-100 page is a short page, so endOfHistory must be true");
  if (short.nextBeforeId !== null) failures.push(`short: expected nextBeforeId null, got ${JSON.stringify(short.nextBeforeId)}`);
  if ((short.warnings ?? []).includes("budget_exhausted")) failures.push("short: an exhausted scan must not warn budget_exhausted");
  if (short.scanned !== 3) failures.push(`short: expected scanned 3, got ${JSON.stringify(short.scanned)}`);
  if (short.matched !== 0) failures.push(`short: expected matched 0 for a non-matching query, got ${JSON.stringify(short.matched)}`);
}

// 4. Upstream 304 on a later page is a success-shaped end-of-history.
const eohRun = runCli(
  ["search_group_messages", "--group_id", "123", "--query", "gamma", "--budget", "300", "--limit", "3"],
  "searchEndOfHistory",
);
const eohCombined = assertNoLeak("304", eohRun);
if (eohRun.status !== 0) failures.push(`304: expected exit 0 (304 is success), got ${eohRun.status}: ${eohCombined.slice(0, 300)}`);
const eoh = parseJson("304", eohRun);
if (eoh) {
  if (eoh.pagesFetched !== 2) failures.push(`304: expected pagesFetched 2 (full page then 304), got ${JSON.stringify(eoh.pagesFetched)}`);
  if (eoh.endOfHistory !== true) failures.push("304: expected endOfHistory true");
  if (eoh.nextBeforeId !== null) failures.push(`304: expected nextBeforeId null, got ${JSON.stringify(eoh.nextBeforeId)}`);
  if (eoh.matched !== 3) failures.push(`304: expected matched 3 (all gamma rows), got ${JSON.stringify(eoh.matched)}`);
  assertMatchesContain("304", eoh, "gamma");
}

// 5. Omitted budget defaults to 100, which is budget-limited on a full first page (no clamp).
// limit defaults to 20, so one full 20-row page examines exactly 100 rows: page 1 is a FULL
// page and 100 rows remain unexamined, so the scan is budget-limited, not exhausted.
// --maxMatches 100 keeps the default 25-match cap from stopping page 1 first (the fixture
// alternates alpha/beta, so a 20-row page yields 10 matches and would hit 25 after 49 rows).
const defaultRun = runCli(
  ["search_group_messages", "--group_id", "123", "--query", "alpha", "--maxMatches", "100"],
  "searchPages",
);
const defaultCombined = assertNoLeak("default", defaultRun);
if (defaultRun.status !== 0) failures.push(`default: expected exit 0, got ${defaultRun.status}: ${defaultCombined.slice(0, 300)}`);
const defaults = parseJson("default", defaultRun);
if (defaults) {
  if (defaults.budget !== 100) failures.push(`default: expected default budget 100, got ${JSON.stringify(defaults.budget)}`);
  if (defaults.budgetClamped !== false) failures.push("default: an omitted budget is not clamped, so budgetClamped must be false");
  if (defaults.limit !== 20) failures.push(`default: expected default limit 20, got ${JSON.stringify(defaults.limit)}`);
  if (defaults.scanned !== 100) failures.push(`default: expected scanned 100 (one full page), got ${JSON.stringify(defaults.scanned)}`);
  if (defaults.pagesFetched !== 1) failures.push(`default: expected pagesFetched 1, got ${JSON.stringify(defaults.pagesFetched)}`);
  if (defaults.endOfHistory !== false) failures.push("default: a budget stop on a full page must not claim endOfHistory");
  if (!(defaults.warnings ?? []).includes("budget_exhausted")) failures.push("default: expected budget_exhausted in warnings");
  if ((defaults.warnings ?? []).some((warning) => warning.endsWith("_invalid_defaulted_100") || warning.endsWith("_invalid_defaulted_20"))) {
    failures.push(`default: omitted values must not warn invalid_defaulted, got ${JSON.stringify(defaults.warnings)}`);
  }
  assertMatchesContain("default", defaults, "alpha");
}

if (failures.length > 0) {
  console.error("smoke-search-group-messages FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("--- budget stdout/stderr ---");
  console.error(`${budgetRun.stdout}${budgetRun.stderr}`);
  console.error("--- clamp stdout/stderr ---");
  console.error(`${clampRun.stdout}${clampRun.stderr}`);
  console.error("--- short stdout/stderr ---");
  console.error(`${shortRun.stdout}${shortRun.stderr}`);
  console.error("--- 304 stdout/stderr ---");
  console.error(`${eohRun.stdout}${eohRun.stderr}`);
  console.error("--- default stdout/stderr ---");
  console.error(`${defaultRun.stdout}${defaultRun.stderr}`);
  process.exit(1);
}

console.log(
  "smoke-search-group-messages OK: budget 105/limit 100 over two full pages fetches twice, scans 105, stays endOfHistory-false with budget_exhausted and nextBeforeId 196 (oldest examined); --budget 900/--limit 500 clamp to 500/100 with both clamp flags; a short page is endOfHistory with nextBeforeId null; an upstream 304 exits 0 as end-of-history; an omitted budget defaults to 100 and is budget-limited, not clamped; case-insensitive matches only; no query=/text= parameter and the token never appears in output",
);
