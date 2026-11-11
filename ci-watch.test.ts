import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_TIMEOUT_MS, logTargetOf, NO_CHECKS_AFTER_MS, stepCiWatch, type CiWatch } from "./ci-watch.ts";
import type { PrLight, Verdict } from "./hub-model.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const watch = (over: Partial<CiWatch> = {}): CiWatch => ({ threadId: "t1", repo: "acme/web-app", pr: 12, watchFor: "both", since: NOW - 60_000, headSha: "abc1234def", ...over });
const pr = (over: Partial<PrLight> = {}): PrLight => ({
  repo: "acme/web-app",
  number: 12,
  title: "Fix",
  url: "https://github.com/acme/web-app/pull/12",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  base: "main",
  head: "fix",
  headSha: "abc1234def",
  mergedAt: null,
  counts: { total: 10, pending: 0, failed: 0, passed: 10 },
  feedback: { reviews: [], comments: [] },
  readAt: NOW,
  ...over,
});
const green: Verdict = { kind: "green", required: [], passed: 10, total: 10, optionalFailed: [], pending: 0 };
const pending: Verdict = { kind: "pending", pending: 3, waitingFor: "required Merge Gate (queued or running)" };
const lint = { name: "Lint", conclusion: "failure", url: "https://github.com/acme/web-app/actions/runs/77/job/1" };
const failed: Verdict = { kind: "failed", blocking: [lint], more: 0, pending: 40 };

test("C7/C8: green on a 'both' watch reports and keeps a quiet reviews watch", () => {
  const step = stepCiWatch(watch(), pr(), green, "sam", NOW);
  assert.deepEqual(step.notes, ["✅ CI is green on web-app#12 (abc1234): 10 checks passed."]);
  assert.equal(step.done, false);
  assert.equal(step.report, true);
  assert.equal(step.watch.watchFor, "reviews");
  assert.equal(step.watch.quiet, true);
  assert.equal(step.watch.reviewsSince, NOW);
});

test("C7: a blocking failure ends a checks watch at once, with its log", () => {
  const step = stepCiWatch(watch({ watchFor: "checks" }), pr({ counts: { total: 50, pending: 40, failed: 1, passed: 9 } }), failed, "sam", NOW);
  assert.equal(step.done, true);
  assert.match(step.notes[0]!, /^❌ CI failed on web-app#12 \(abc1234\): Lint\. 40 checks still running/);
  assert.equal(step.logOf, lint);
  assert.deepEqual(logTargetOf(step.logOf!.url), { runId: 77, jobId: 1 });
  assert.deepEqual(logTargetOf("https://github.com/acme/web-app/actions/runs/77"), { runId: 77, jobId: null });
  assert.equal(logTargetOf("https://ci.example.com/build/3"), null);
});

test("pending: nothing to say", () => {
  const step = stepCiWatch(watch(), pr({ counts: { total: 10, pending: 3, failed: 0, passed: 7 } }), pending, "sam", NOW);
  assert.equal(step.report, false);
  assert.deepEqual(step.notes, []);
});

test("C9: no checks after 10 minutes", () => {
  const none: Verdict = { kind: "none" };
  assert.equal(stepCiWatch(watch(), pr({ counts: null }), none, "sam", NOW).report, false);
  const late = stepCiWatch(watch({ watchFor: "checks", since: NOW - NO_CHECKS_AFTER_MS - 1 }), pr({ counts: null }), none, "sam", NOW);
  assert.deepEqual(late.notes, ["web-app#12 has no CI checks after 10 minutes; nothing to wait for."]);
  assert.equal(late.done, true);
});

test("C11: merged or closed ends the watch", () => {
  const step = stepCiWatch(watch(), pr({ state: "MERGED" }), green, "sam", NOW);
  assert.deepEqual(step.notes, ["PR web-app#12 is now merged."]);
  assert.equal(step.done, true);
});

test("C6: a new head restarts the clock", () => {
  const step = stepCiWatch(watch({ since: NOW - CI_TIMEOUT_MS + 1000 }), pr({ headSha: "fff0000aaa" }), pending, "sam", NOW);
  assert.equal(step.watch.since, NOW);
  assert.equal(step.watch.headSha, "fff0000aaa");
});

test("C10: human reviews and comments after the cutoff; not mine, not bots", () => {
  const feedback = {
    reviews: [
      { author: "alex", state: "CHANGES_REQUESTED", body: "Please rename", at: NOW - 1000 },
      { author: "alex", state: "COMMENTED", body: "old", at: NOW - 120_000 },
      { author: "sam", state: "COMMENTED", body: "mine", at: NOW - 1000 },
    ],
    comments: [
      { author: "vercel", body: "Preview ready", at: NOW - 1000 },
      { author: "ci-helper[bot]", body: "x", at: NOW - 1000 },
      { author: "kim", body: "[vc]: preview", at: NOW - 1000 },
      { author: "kim", body: "Looks good", at: NOW - 1000 },
    ],
  };
  const step = stepCiWatch(watch({ watchFor: "reviews" }), pr({ feedback }), pending, "sam", NOW);
  assert.deepEqual(step.notes.slice(0, 2), ["Review from alex: CHANGES_REQUESTED — Please rename", "Comment from kim: Looks good"]);
  assert.match(step.notes[2]!, /^Full comments:/);
  assert.equal(step.done, true);
  // "both": report reviews, keep watching checks.
  const both = stepCiWatch(watch(), pr({ feedback }), pending, "sam", NOW);
  assert.equal(both.done, false);
  assert.equal(both.report, true);
  assert.equal(both.watch.reviewsSince, NOW);
  // "checks": reviews are not its business.
  assert.equal(stepCiWatch(watch({ watchFor: "checks" }), pr({ feedback }), pending, "sam", NOW).report, false);
});

test("C12: three hours without news ends the watch; a quiet one ends silently", () => {
  const old = NOW - CI_TIMEOUT_MS - 1;
  const loud = stepCiWatch(watch({ since: old }), pr(), pending, "sam", NOW);
  assert.deepEqual(loud.notes, ["Still waiting on web-app#12 after 3 hours (waiting for required Merge Gate (queued or running)); stopped watching. https://github.com/acme/web-app/pull/12"]);
  const quiet = stepCiWatch(watch({ since: old, watchFor: "reviews", quiet: true }), pr(), pending, "sam", NOW);
  assert.deepEqual(quiet.notes, []);
  assert.equal(quiet.done, true);
  assert.equal(quiet.report, true);
});
