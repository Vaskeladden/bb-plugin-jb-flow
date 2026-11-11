import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionOf,
  checksVerdict,
  countsOf,
  detailNeeded,
  detailQuery,
  lightBatches,
  lightQuery,
  readDetail,
  readLight,
  REQUIRED_RECHECK_MS,
  requiredStates,
  verdictText,
  type PrDetail,
  type PrLight,
} from "./hub-model.ts";

const REQUIRED = ["Build", "Merge Gate"];
const NOW = Date.parse("2026-11-11T12:00:00Z");
const DONE = { total: 552, pending: 0, failed: 0, passed: 552 };

function light(over: Partial<PrLight> = {}): PrLight {
  return {
    repo: "acme/web-app",
    number: 12,
    title: "Fix login",
    url: "https://github.com/acme/web-app/pull/12",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    base: "main",
    head: "fix-login",
    headSha: "abc1234def",
    mergedAt: null,
    counts: DONE,
    feedback: null,
    readAt: NOW,
    ...over,
  };
}

const passed = (name: string, startedAt = NOW - 60_000) => ({ name, state: "passed" as const, startedAt, url: null });

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    headSha: "abc1234def",
    counts: DONE,
    suites: [{ id: 1, failed: [], failedMore: 0, required: REQUIRED.map((name) => passed(name)) }],
    statuses: [],
    incomplete: false,
    lightCounts: DONE,
    readAt: NOW,
    ...over,
  };
}

test("counts by state: failures, pending and the rest", () => {
  assert.deepEqual(
    countsOf([
      { state: "SUCCESS", count: 445 },
      { state: "SKIPPED", count: 106 },
      { state: "FAILURE", count: 1 },
      { state: "IN_PROGRESS", count: 3 },
      { state: "QUEUED", count: 2 },
      { state: "ERROR", count: 1 },
      { state: "EXPECTED", count: 1 },
    ]),
    { total: 559, pending: 6, failed: 2, passed: 551 },
  );
});

test("green and failed lines", () => {
  const counts = { total: 552, pending: 4, failed: 1, passed: 547 };
  const read = detail({ counts, suites: [{ id: 1, failed: [], failedMore: 0, required: REQUIRED.map((name) => passed(name)) }, { id: 2, failed: [{ name: "Docs Preview", conclusion: "failure", url: null }], failedMore: 0, required: [] }] });
  const green = checksVerdict(light({ counts }), read, REQUIRED);
  assert.equal(green.kind, "green");
  assert.equal(
    verdictText(light(), green as Extract<typeof green, { kind: "green" }>),
    "✅ CI is green on web-app#12 (abc1234): required checks passed (Build, Merge Gate); 547 of 552 checks passed. Optional checks failed (not required): Docs Preview. 4 optional checks still running.",
  );
  const failing = { total: 552, pending: 300, failed: 12, passed: 240 };
  const gateRunning = detail({
    counts: failing,
    suites: [{ id: 1, failed: [{ name: "Lint", conclusion: "failure", url: "u" }], failedMore: 11, required: [passed("Build"), { name: "Merge Gate", state: "pending", startedAt: NOW - 1000, url: null }] }],
  });
  const failed = checksVerdict(light({ counts: failing }), gateRunning, REQUIRED);
  assert.equal(
    verdictText(light(), failed as Extract<typeof failed, { kind: "failed" }>),
    "❌ CI failed on web-app#12 (abc1234): Lint and 11 more. 300 checks still running; this is the first failure.",
  );
});

test("pending says what it waits for", () => {
  const notRead = checksVerdict(light(), undefined, REQUIRED);
  assert.deepEqual(notRead, { kind: "pending", pending: 0, waitingFor: "check details not read this cycle" });
  const unknown = checksVerdict(light(), detail(), null);
  assert.match(unknown.kind === "pending" ? unknown.waitingFor : "", /required checks \(could not read them\)/);
  const queued = checksVerdict(light(), detail({ suites: [{ id: 1, failed: [], failedMore: 0, required: [passed("Build"), { name: "Merge Gate", state: "pending", startedAt: null, url: null }] }] }), REQUIRED);
  assert.match(queued.kind === "pending" ? queued.waitingFor : "", /^required Merge Gate \(queued or running\)$/);
  assert.equal(checksVerdict(light({ counts: null }), undefined, REQUIRED).kind, "none");
});

test("a required check reported as a commit status counts when no check run has its name", () => {
  const read = detail({ suites: [{ id: 1, failed: [], failedMore: 0, required: [passed("Build")] }], statuses: [{ name: "Merge Gate", state: "failed", url: "s" }] });
  assert.deepEqual(requiredStates(read, REQUIRED).map((state) => [state.name, state.state]), [["Build", "passed"], ["Merge Gate", "failed"]]);
  assert.equal(checksVerdict(light(), read, REQUIRED).kind, "failed");
});

test("a detail read of another head is not used", () => {
  const answer = { commits: { nodes: [{ commit: { oid: "other", statusCheckRollup: null, status: null, checkSuites: { totalCount: 0, nodes: [] } } }] } };
  assert.equal(readDetail(answer, REQUIRED, light(), NOW), null);
  assert.equal(checksVerdict(light(), detail({ headSha: "other" }), REQUIRED).kind, "pending");
});

test("detail reads only when they can change the answer", () => {
  // A new failure: explain it, once per head and failure count (sidebar too).
  const failing = light({ counts: { total: 552, pending: 100, failed: 1, passed: 451 } });
  assert.equal(detailNeeded(failing, undefined, false, NOW), true);
  assert.equal(detailNeeded(failing, detail({ lightCounts: failing.counts! }), false, NOW), false);
  // Nobody waits and nothing failed: no detail.
  const running = light({ counts: { total: 552, pending: 100, failed: 0, passed: 452 } });
  assert.equal(detailNeeded(running, undefined, false, NOW), false);
  // Watched: first read at once; then when everything finished, else at most every five minutes.
  assert.equal(detailNeeded(running, undefined, true, NOW), true);
  const earlier = { total: 552, pending: 120, failed: 0, passed: 432 };
  assert.equal(detailNeeded(running, detail({ lightCounts: earlier, readAt: NOW - 60_000 }), true, NOW), false);
  assert.equal(detailNeeded(running, detail({ lightCounts: earlier, readAt: NOW - REQUIRED_RECHECK_MS }), true, NOW), true);
  assert.equal(detailNeeded(light(), detail({ lightCounts: earlier, readAt: NOW - 60_000 }), true, NOW), true);
  // Nothing moved: still read every five minutes while someone waits (a gate created late, a rules read that failed).
  assert.equal(detailNeeded(light(), detail({ readAt: NOW - 60_000 }), true, NOW), false);
  assert.equal(detailNeeded(light(), detail({ readAt: NOW - REQUIRED_RECHECK_MS }), true, NOW), true);
  // A new head: read again.
  assert.equal(detailNeeded(light({ headSha: "new" }), detail(), true, NOW), true);
  assert.equal(detailNeeded(light({ state: "MERGED" }), undefined, true, NOW), false);
});

test("sidebar attention uses the last detail of this head, for display only", () => {
  assert.equal(attentionOf(light(), detail(), REQUIRED), "ready_to_merge");
  const failing = light({ counts: { total: 552, pending: 0, failed: 1, passed: 551 } });
  assert.equal(attentionOf(failing, undefined, REQUIRED), "checks_failed");
  const optional = detail({ suites: [{ id: 1, failed: [], failedMore: 0, required: REQUIRED.map((name) => passed(name)) }, { id: 2, failed: [{ name: "Docs Preview", conclusion: "failure", url: null }], failedMore: 0, required: [] }] });
  assert.equal(attentionOf(failing, optional, REQUIRED), "ready_to_merge");
  const gateMissing = detail({ suites: [{ id: 1, failed: [], failedMore: 0, required: [passed("Build")] }] });
  assert.equal(attentionOf(light(), gateMissing, REQUIRED), "checks_pending");
  assert.equal(attentionOf(light({ state: "MERGED" }), undefined, REQUIRED), "merged");
});

test("light query: all repos and runs in one query, feedback only where asked", () => {
  const query = lightQuery(
    [
      { repo: "acme/web-app", number: 12, feedback: true },
      { repo: "acme/billing-api", number: 4, feedback: false },
    ],
    [{ repo: "acme/web-app", runId: 99 }],
  );
  assert.match(query, /rateLimit \{ remaining resetAt \}/);
  assert.match(query, /r0: repository\(owner: "acme", name: "web-app"\) \{ p12: pullRequest\(number: 12\) \{[^]*reviews\(last: 30\)/);
  assert.doesNotMatch(query.split("r1:")[1]!, /reviews\(/);
  assert.match(query, /contexts\(first: 0\)/);
  assert.match(query, /w0: resource\(url: "https:\/\/github.com\/acme\/web-app\/actions\/runs\/99"\)/);
  assert.match(detailQuery("acme/web-app", [12], REQUIRED), /q1: checkRuns\(first: 5, filterBy: \{checkType: LATEST, checkName: "Merge Gate"\}\) \{ nodes \{ name status conclusion startedAt detailsUrl \} \}/);
});

test("light batches: 60 PRs and 60 runs per query", () => {
  const prs = Array.from({ length: 61 }, (_, i) => ({ repo: "acme/web-app", number: i + 1, feedback: false }));
  const runs = Array.from({ length: 130 }, (_, i) => ({ repo: "acme/web-app", runId: i + 1 }));
  assert.deepEqual(lightBatches(prs, runs).map((batch) => [batch.prs.length, batch.runs.length]), [[60, 60], [1, 60], [0, 10]]);
  assert.deepEqual(lightBatches([], []), []);
});

test("reading answers: PRs, runs, and a PR GitHub could not resolve", () => {
  const counts = (pairs: Array<[string, number]>) => pairs.map(([state, count]) => ({ state, count }));
  const answer = {
    viewer: { login: "sam" },
    r0: {
      p12: {
        number: 12, title: "Fix", url: "u", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: null, baseRefName: "main", headRefName: "fix", headRefOid: "abc", mergedAt: null,
        commits: { nodes: [{ commit: { oid: "abc", statusCheckRollup: { state: "PENDING", contexts: { checkRunCountsByState: counts([["SUCCESS", 3], ["IN_PROGRESS", 1]]), statusContextCountsByState: [] } } } }] },
        reviews: { nodes: [{ author: { login: "alex" }, state: "APPROVED", body: "", submittedAt: "2026-11-11T12:00:00Z" }] },
        comments: { nodes: [] },
      },
      p13: null,
    },
    w0: { url: "run-url", checkSuite: { status: "COMPLETED", conclusion: "FAILURE", failed: { totalCount: 21, nodes: [{ name: "deploy", conclusion: "FAILURE" }] } } },
  };
  const read = readLight(answer, [{ repo: "acme/web-app", number: 12, feedback: true }, { repo: "acme/web-app", number: 13, feedback: false }], [{ repo: "acme/web-app", runId: 7 }], NOW);
  assert.equal(read.login, "sam");
  assert.deepEqual(read.prs.get("acme/web-app#12")?.counts, { total: 4, pending: 1, failed: 0, passed: 3 });
  assert.equal(read.prs.get("acme/web-app#12")?.feedback?.reviews[0]?.author, "alex");
  assert.equal(read.prs.has("acme/web-app#13"), false);
  assert.deepEqual(read.runs.get("acme/web-app/runs/7"), { status: "completed", conclusion: "failure", url: "run-url", failedJobs: [{ name: "deploy", conclusion: "failure" }], failedMore: 20 });
});
