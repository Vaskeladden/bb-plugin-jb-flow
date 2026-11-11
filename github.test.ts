import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createGitHub, createQuota, pausedText, QUOTA_FLOOR, QuotaPausedError, RateLimitedError, type Runner } from "./github.ts";

// One owner: only github.ts may start gh or talk to the GitHub API.
test("no file but github.ts starts gh or calls the GitHub API", () => {
  const forbidden = [/\/bin\/gh\b/, /execFile\(\s*["'`]gh["'`]/, /spawn\(\s*["'`]gh["'`]/, /api\.github\.com/, /["'`]api["'`],\s*["'`]graphql["'`]/, /\bghBin\b|\bghPath\b/];
  const files = readdirSync(".").filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "github.ts");
  const offenders = files.flatMap((name) => {
    const text = readFileSync(name, "utf8");
    return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${name}: ${pattern}`);
  });
  assert.deepEqual(offenders, []);
});

test("each resetAt is its own counter, and the lowest live one decides", () => {
  let now = Date.parse("2026-11-11T11:30:00Z");
  const quota = createQuota(() => now);
  quota.record(4000, Date.parse("2026-11-11T12:21:08Z"));
  quota.record(QUOTA_FLOOR - 1, Date.parse("2026-11-11T11:33:25Z"));
  const state = quota.state();
  assert.equal(state.paused, true);
  assert.equal(state.paused && state.resumesAt, Date.parse("2026-11-11T11:33:25Z"));
  assert.match(pausedText(state) ?? "", /^Paused: GitHub quota low, resumes \d\d:\d\d$/);
  // That counter resets: reading resumes, the other counter is still fine.
  now = Date.parse("2026-11-11T11:33:30Z");
  assert.deepEqual(quota.state(), { paused: false });
  assert.equal(quota.readings().length, 1);
});

test("a newer reading of the same counter only lowers remaining", () => {
  const now = Date.parse("2026-11-11T11:30:00Z");
  const quota = createQuota(() => now);
  const reset = Date.parse("2026-11-11T12:00:00Z");
  quota.record(900, reset);
  quota.record(4000, reset); // an answer from another node, older or rounder: not trusted upwards
  assert.equal(quota.state().paused, true);
});

test("a rate-limit refusal pauses every read and is not retried", async () => {
  let calls = 0;
  const runner: Runner = async (args) => {
    calls += 1;
    if (args[1] === "rate_limit") return { stdout: "[1794400000, 1794401000]", stderr: "", error: null };
    return { stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1.", error: Object.assign(new Error("exit 1"), { code: 1 }) };
  };
  const github = createGitHub(createQuota(), runner);
  await assert.rejects(github.graphql("query { rateLimit { remaining resetAt } }", "PRs"), RateLimitedError);
  assert.equal(calls, 2); // the query once, then the free GET /rate_limit for the reset time
  await assert.rejects(github.graphql("query { viewer { login } }", "PRs"), QuotaPausedError);
  await assert.rejects(github.gh(["api", "user"], "the user"), QuotaPausedError);
  assert.equal(calls, 2);
  assert.equal(github.quota.state().paused, true);
});

test("a GraphQL answer below the floor pauses the next read", async () => {
  const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
  let calls = 0;
  const runner: Runner = async () => {
    calls += 1;
    return { stdout: JSON.stringify({ data: { rateLimit: { remaining: 400, resetAt } } }), stderr: "", error: null };
  };
  const github = createGitHub(createQuota(), runner);
  await github.graphql("query { rateLimit { remaining resetAt } }", "PRs");
  await assert.rejects(github.graphql("query { rateLimit { remaining resetAt } }", "PRs"), QuotaPausedError);
  assert.equal(calls, 1);
});

test("partial GraphQL answers keep their data", async () => {
  const runner: Runner = async () => ({
    stdout: JSON.stringify({ data: { r0: { p1: null, p2: { number: 2 } } }, errors: [{ message: "Could not resolve to a PullRequest with the number of 1." }] }),
    stderr: "",
    error: Object.assign(new Error("exit 1"), { code: 1 }),
  });
  const { data, errors } = await createGitHub(createQuota(), runner).graphql<{ r0: Record<string, unknown> }>("query { x }", "PRs");
  assert.deepEqual(data.r0.p2, { number: 2 });
  assert.equal(errors.length, 1);
});
