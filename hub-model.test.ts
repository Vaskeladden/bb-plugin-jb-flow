import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attentionOf,
  checksVerdict,
  countsOf,
  detailNeeded,
  detailQuery,
  lightQuery,
  readDetail,
  readLight,
  REQUIRED_RECHECK_MS,
  verdictText,
  type PrDetail,
  type PrLight,
} from "./hub-model.ts";

const REQUIRED = ["Build", "Merge Gate"];
const NOW = Date.parse("2026-11-11T12:00:00Z");

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
    counts: { total: 552, pending: 0, failed: 0, passed: 552 },
    feedback: null,
    readAt: NOW,
    ...over,
  };
}

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return { headSha: "abc1234def", failedCount: 0, pendingCount: 0, failed: [], required: REQUIRED.map((name) => ({ name, state: "passed", url: null })), incomplete: false, readAt: NOW, ...over };
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

test("an optional check that fails on every PR does not fail the PR", () => {
  const pr = light({ counts: { total: 552, pending: 0, failed: 1, passed: 551 } });
  const read = detail({ failedCount: 1, failed: [{ name: "Docs Preview", conclusion: "failure", url: null, blocking: false }] });
  const verdict = checksVerdict(pr, read, REQUIRED);
  assert.equal(verdict.kind, "green");
  assert.equal(attentionOf(pr, verdict), "ready_to_merge");
  assert.match(verdictText(pr, verdict as Extract<typeof verdict, { kind: "green" }>), /^✅ CI is green on web-app#12 \(abc1234\): required checks passed \(Build, Merge Gate\); 551 of 552 checks passed\. Optional checks failed \(not required\): Docs Preview\.$/);
});

test("the first blocking failure is reported while other checks still run", () => {
  const pr = light({ counts: { total: 552, pending: 300, failed: 1, passed: 251 } });
  const read = detail({ failedCount: 1, pendingCount: 300, failed: [{ name: "Lint", conclusion: "failure", url: "https://github.com/acme/web-app/actions/runs/7/job/8", blocking: true }] });
  const verdict = checksVerdict(pr, read, REQUIRED);
  assert.equal(verdict.kind, "failed");
  assert.equal(
    verdictText(pr, verdict as Extract<typeof verdict, { kind: "failed" }>),
    "❌ CI failed on web-app#12 (abc1234): Lint. 300 checks still running; this is the first failure.",
  );
  assert.equal(attentionOf(pr, verdict), "checks_failed");
});

test("failures are never judged from a detail read of another head or failure count", () => {
  const pr = light({ counts: { total: 552, pending: 0, failed: 2, passed: 550 } });
  assert.equal(checksVerdict(pr, detail({ failedCount: 1 }), REQUIRED).kind, "pending");
  assert.equal(checksVerdict(pr, detail({ failedCount: 2, headSha: "old" }), REQUIRED).kind, "pending");
  assert.equal(checksVerdict(pr, undefined, REQUIRED).kind, "pending");
});

test("required checks passed while optional ones still run: done", () => {
  const pr = light({ counts: { total: 552, pending: 4, failed: 0, passed: 548 } });
  const verdict = checksVerdict(pr, detail({ pendingCount: 4 }), REQUIRED);
  assert.equal(verdict.kind, "green");
  assert.match(verdictText(pr, verdict as Extract<typeof verdict, { kind: "green" }>), /4 optional checks still running\.$/);
  // Required still running: pending.
  const running = detail({ pendingCount: 4, required: [{ name: "Merge Gate", state: "pending", url: null }, { name: "Build", state: "passed", url: null }] });
  assert.equal(checksVerdict(pr, running, REQUIRED).kind, "pending");
});

test("a required check that never reported blocks once everything else finished", () => {
  const pr = light();
  const read = detail({ required: [{ name: "Merge Gate", state: "missing", url: null }, { name: "Build", state: "passed", url: null }] });
  const verdict = checksVerdict(pr, read, REQUIRED);
  assert.equal(verdict.kind, "failed");
  assert.match(verdictText(pr, verdict as Extract<typeof verdict, { kind: "failed" }>), /Merge Gate \(required, never reported\)/);
});

test("without required checks, every check counts, as before", () => {
  const pr = light({ counts: { total: 10, pending: 0, failed: 1, passed: 9 } });
  const read = detail({ failedCount: 1, required: [], failed: [{ name: "Tests", conclusion: "failure", url: null, blocking: true }] });
  assert.equal(checksVerdict(pr, read, []).kind, "failed");
  const green = checksVerdict(light({ counts: { total: 10, pending: 0, failed: 0, passed: 10 } }), undefined, null);
  assert.equal(green.kind, "green");
  assert.equal(verdictText(light({ counts: { total: 10, pending: 0, failed: 0, passed: 10 } }), green as Extract<typeof green, { kind: "green" }>), "✅ CI is green on web-app#12 (abc1234): 10 checks passed.");
  assert.equal(checksVerdict(light({ counts: { total: 10, pending: 2, failed: 0, passed: 8 } }), undefined, null).kind, "pending");
  assert.equal(checksVerdict(light({ counts: null }), undefined, REQUIRED).kind, "none");
});

test("detail reads only when they can change the answer", () => {
  // A new failure: explain it, once per head and failure count.
  const failing = light({ counts: { total: 552, pending: 100, failed: 1, passed: 451 } });
  assert.equal(detailNeeded(failing, undefined, REQUIRED, false, NOW, null), true);
  assert.equal(detailNeeded(failing, detail({ failedCount: 1, pendingCount: 100 }), REQUIRED, false, NOW, null), false);
  // Nobody waits and nothing failed: no detail.
  const running = light({ counts: { total: 552, pending: 100, failed: 0, passed: 452 } });
  assert.equal(detailNeeded(running, undefined, REQUIRED, false, NOW, null), false);
  // Watched: required checks while running, at most every five minutes and only when counts moved.
  assert.equal(detailNeeded(running, undefined, REQUIRED, true, NOW, null), true);
  const recent = detail({ pendingCount: 120, readAt: NOW - 60_000 });
  assert.equal(detailNeeded(running, recent, REQUIRED, true, NOW, { total: 552, pending: 120, failed: 0, passed: 432 }), false);
  const old = detail({ pendingCount: 120, readAt: NOW - REQUIRED_RECHECK_MS });
  assert.equal(detailNeeded(running, old, REQUIRED, true, NOW, { total: 552, pending: 120, failed: 0, passed: 432 }), true);
  assert.equal(detailNeeded(running, old, REQUIRED, true, NOW, running.counts), false);
  // Watched and finished: one read of this head to check nothing required is missing.
  assert.equal(detailNeeded(light(), detail({ pendingCount: 5 }), REQUIRED, true, NOW, null), true);
  assert.equal(detailNeeded(light(), detail(), REQUIRED, true, NOW, null), false);
  assert.equal(detailNeeded(light({ state: "MERGED" }), undefined, REQUIRED, true, NOW, null), false);
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
  assert.match(detailQuery("acme/web-app", [12], REQUIRED), /checkName: "Merge Gate"/);
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
    w0: { url: "run-url", checkSuite: { status: "COMPLETED", conclusion: "FAILURE", failed: { nodes: [{ name: "deploy", conclusion: "FAILURE" }] } } },
  };
  const read = readLight(answer, [{ repo: "acme/web-app", number: 12, feedback: true }, { repo: "acme/web-app", number: 13, feedback: false }], [{ repo: "acme/web-app", runId: 7 }], NOW);
  assert.equal(read.login, "sam");
  assert.deepEqual(read.prs.get("acme/web-app#12")?.counts, { total: 4, pending: 1, failed: 0, passed: 3 });
  assert.equal(read.prs.get("acme/web-app#12")?.feedback?.reviews[0]?.author, "alex");
  assert.equal(read.prs.has("acme/web-app#13"), false);
  assert.deepEqual(read.runs.get("acme/web-app/runs/7"), { status: "completed", conclusion: "failure", url: "run-url", failedJobs: [{ name: "deploy", conclusion: "failure" }] });
});

test("a failure in the gate's own workflow blocks; one in another workflow does not", () => {
  const pr = light({ counts: { total: 30, pending: 0, failed: 2, passed: 28 } });
  const suite = (id: number, failed: Array<{ name: string; isRequired: boolean }>, gate: boolean) => ({
    workflowRun: { databaseId: id },
    failed: { nodes: failed.map((check) => ({ name: check.name, conclusion: "FAILURE", detailsUrl: `https://github.com/acme/web-app/actions/runs/${id}/job/1`, isRequired: check.isRequired })) },
    q0: { nodes: [] },
    q1: { nodes: gate ? [{ name: "Merge Gate", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null }] : [] },
  });
  const answer = {
    commits: {
      nodes: [
        {
          commit: {
            oid: "abc1234def",
            status: { contexts: [] },
            checkSuites: { totalCount: 2, nodes: [suite(1, [{ name: "Lint", isRequired: false }], true), suite(2, [{ name: "Docs Preview", isRequired: false }], false)] },
          },
        },
      ],
    },
  };
  const read = readDetail(answer, REQUIRED, pr, NOW)!;
  assert.deepEqual(
    read.failed.map((check) => [check.name, check.blocking]),
    [["Lint", true], ["Docs Preview", false]],
  );
  assert.deepEqual(read.required?.map((check) => [check.name, check.state]), [["Build", "missing"], ["Merge Gate", "failed"]]);
  assert.equal(checksVerdict(pr, read, REQUIRED).kind, "failed");
});
