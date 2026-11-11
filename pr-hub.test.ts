// The hub end to end against a fake gh: what a CI watch is told after one
// cycle. Each case is a way the verdict could be wrong (hub-model.ts, the rule
// at the top): green only from this cycle's detail read of the current head
// showing every required check passed; failed only from a required check or
// a job in a suite whose required gate is pending or failed; else pending.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHub, createQuota, createReads, type Runner } from "./github.ts";
import { createHub, type Interest } from "./pr-hub.ts";

const REPO = "acme/web-app";
const HEAD = "abc1234def";
const RESET = () => new Date(Date.now() + 30 * 60_000).toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Run = { status: "QUEUED" | "IN_PROGRESS" | "COMPLETED"; conclusion?: string | null; startedAt?: string | null; url?: string };
type Suite = { id: number; failed?: Array<{ name: string; url?: string }>; build?: Run[]; gate?: Run[] };
type Pairs = Array<[string, number]>;

const counts = (pairs: Pairs) => ({ checkRunCountsByState: pairs.map(([state, count]) => ({ state, count })), statusContextCountsByState: [] });

function lightPr(pairs: Pairs, oid = HEAD) {
  return {
    number: 12, title: "Fix login", url: `https://github.com/${REPO}/pull/12`, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: null,
    baseRefName: "main", headRefName: "fix-login", headRefOid: oid, mergedAt: null,
    commits: { nodes: [{ commit: { oid, statusCheckRollup: { state: "PENDING", contexts: counts(pairs) } } }] },
  };
}

const node = (name: string, run: Run) => ({ name, status: run.status, conclusion: run.conclusion ?? null, startedAt: run.startedAt ?? null, detailsUrl: run.url ?? null });

/**
 * A detail answer for the required checks the query asked for (`aliases`:
 * alias and check name, in query order). Both suite id fields are given so the
 * same answer reads in older query shapes too.
 */
function detailPr(pairs: Pairs, suites: Suite[], aliases: Array<[string, string]>, oid = HEAD, totalCount = suites.length) {
  return {
    commits: {
      nodes: [
        {
          commit: {
            oid,
            statusCheckRollup: { contexts: counts(pairs) },
            status: { contexts: [] },
            checkSuites: {
              totalCount,
              nodes: suites.map((suite) => ({
                databaseId: suite.id,
                workflowRun: { databaseId: suite.id },
                failed: {
                  totalCount: suite.failed?.length ?? 0,
                  nodes: (suite.failed ?? []).map((check) => ({ name: check.name, conclusion: "FAILURE", detailsUrl: check.url ?? null, isRequired: false })),
                },
                ...Object.fromEntries(
                  aliases.map(([alias, name]) => [alias, { nodes: ((name === "Build" ? suite.build : name === "Merge Gate" ? suite.gate : []) ?? []).map((run) => node(name, run)) }]),
                ),
              })),
            },
          },
        },
      ],
    },
  };
}

type Script = {
  light: Pairs | (() => Pairs);
  lightOid?: string;
  lightRemaining?: number;
  detail?: { pairs: Pairs; suites: Suite[]; oid?: string; totalCount?: number } | "error";
  rules?: string[] | "error";
  /** Classic protection's required checks; "error" when the branch can't be read. */
  classic?: string[] | "error";
};

function fakeGh(script: Script) {
  const calls: string[] = [];
  const ok = (data: unknown) => ({ stdout: JSON.stringify({ data }), stderr: "", error: null });
  const fail = (stderr: string) => ({ stdout: "", stderr, error: Object.assign(new Error("exit 1"), { code: 1 }) });
  const runner: Runner = async (args) => {
    if (args[1] === "graphql") {
      const query = args[3]!.slice("query=".length);
      if (query.includes("viewer { login }")) {
        calls.push("light");
        const pairs = typeof script.light === "function" ? script.light() : script.light;
        return ok({ rateLimit: { remaining: script.lightRemaining ?? 4000, resetAt: RESET() }, viewer: { login: "sam" }, r0: { p12: lightPr(pairs, script.lightOid) } });
      }
      calls.push("detail");
      const detail = script.detail;
      if (detail === undefined || detail === "error") return fail("gh: Something went wrong while executing your query.");
      const aliases = [...query.matchAll(/(q\d+): checkRuns\(first: \d+, filterBy: \{checkType: LATEST, checkName: "([^"]+)"\}/g)].map((match): [string, string] => [match[1]!, match[2]!]);
      return ok({ rateLimit: { remaining: 3990, resetAt: RESET() }, r: { d12: detailPr(detail.pairs, detail.suites, aliases, detail.oid, detail.totalCount) } });
    }
    if (args[1]?.includes("/rules/branches/")) {
      calls.push("rules");
      if (script.rules === "error") return fail("gh: Server Error (HTTP 502)");
      return { stdout: JSON.stringify([{ type: "required_status_checks", parameters: { required_status_checks: (script.rules ?? ["Build", "Merge Gate"]).map((context) => ({ context })) } }]), stderr: "", error: null };
    }
    if (/\/branches\/[^/]+$/.test(args[1] ?? "")) {
      calls.push("branch");
      if (script.classic === "error") return fail("gh: Resource not accessible by personal access token (HTTP 403)");
      return { stdout: JSON.stringify({ protected: true, protection: { required_status_checks: { enforcement_level: script.classic ? "everyone" : "off", contexts: script.classic ?? [], checks: [] } } }), stderr: "", error: null };
    }
    if (args[1] === "rate_limit") return { stdout: "[0, 0]", stderr: "", error: null };
    calls.push(args.join(" "));
    return fail("unexpected");
  };
  return { runner, calls };
}

function fakeBb() {
  const services: Array<(signal: AbortSignal) => unknown> = [];
  const warnings: string[] = [];
  const bb = {
    log: { info: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined },
    background: {
      schedule: () => undefined,
      service: (_name: string, service: { start(signal: AbortSignal): unknown }) => services.push((signal) => service.start(signal)),
    },
  };
  return { bb: bb as never, services, warnings };
}

const WATCHED: Interest = { prs: [{ repo: REPO, number: 12, feedback: false, watched: true }], runs: [], urgent: true };

function setup(script: Script, wanted: Interest = WATCHED) {
  const { runner, calls } = fakeGh(script);
  const { bb, services, warnings } = fakeBb();
  const github = createGitHub(createQuota(), runner);
  const hub = createHub(bb, github, createReads(github), async () => wanted);
  return { hub, calls, services, warnings, github };
}

async function verdictOf(script: Script) {
  const { hub } = setup(script);
  const view = await hub.cycle();
  return view!.verdict(REPO, 12)!;
}

const passed = (minutes = 5): Run => ({ status: "COMPLETED", conclusion: "SUCCESS", startedAt: ago(minutes) });
const failedRun = (minutes = 5): Run => ({ status: "COMPLETED", conclusion: "FAILURE", startedAt: ago(minutes) });
const ALL_DONE: Pairs = [["SUCCESS", 551], ["SKIPPED", 1]];

// --- the six cases from review ------------------------------------------------------

test("case 1: light read shows nothing pending, the required gate is queued a second later: pending", async () => {
  const verdict = await verdictOf({
    light: ALL_DONE,
    detail: { pairs: [["SUCCESS", 551], ["SKIPPED", 1], ["QUEUED", 1]], suites: [{ id: 1, build: [passed()], gate: [{ status: "QUEUED" }] }] },
  });
  assert.equal(verdict.kind, "pending");
});

test("case 1b: light read shows nothing pending, the required gate failed a second later: failed", async () => {
  const verdict = await verdictOf({
    light: ALL_DONE,
    detail: { pairs: [["SUCCESS", 551], ["SKIPPED", 1], ["FAILURE", 1]], suites: [{ id: 1, build: [passed()], gate: [failedRun(1)] }] },
  });
  assert.equal(verdict.kind, "failed");
});

test("case 2: a push between the light and the detail read: pending, never judged from the other head", async () => {
  const verdict = await verdictOf({
    light: ALL_DONE,
    detail: { pairs: ALL_DONE, oid: "fffffff000", suites: [{ id: 1, build: [passed()], gate: [passed()] }] },
  });
  assert.equal(verdict.kind, "pending");
});

test("case 3a: the detail read fails: pending", async () => {
  const verdict = await verdictOf({ light: ALL_DONE, detail: "error" });
  assert.equal(verdict.kind, "pending");
});

test("case 3b: the quota pauses after the light read, so no detail is read: pending", async () => {
  const { hub, calls } = setup({ light: ALL_DONE, lightRemaining: 900, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [passed()] }] } });
  const view = await hub.cycle();
  assert.equal(calls.includes("detail"), false);
  assert.equal(view!.verdict(REPO, 12)!.kind, "pending");
});

test("case 3c: a detail read skipped this cycle (nothing moved) does not carry an earlier read's answer", async () => {
  // First cycle: the gate has not been created yet. Second cycle, a minute later: same counts, no detail read.
  const { hub, calls } = setup({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()] }] } });
  assert.equal((await hub.cycle())!.verdict(REPO, 12)!.kind, "pending");
  const second = await hub.cycle();
  assert.equal(calls.filter((call) => call === "detail").length, 1);
  assert.equal(second!.verdict(REPO, 12)!.kind, "pending");
});

test("case 4: an optional job in the gate's workflow fails after the gate passed: green, and the job is named", async () => {
  const verdict = await verdictOf({
    light: [["SUCCESS", 550], ["FAILURE", 1]],
    detail: { pairs: [["SUCCESS", 550], ["FAILURE", 1]], suites: [{ id: 1, build: [passed(20)], gate: [passed(10)], failed: [{ name: "Docs Preview" }] }] },
  });
  assert.equal(verdict.kind, "green");
  assert.deepEqual(verdict.kind === "green" && verdict.optionalFailed.map((check) => check.name), ["Docs Preview"]);
});

test("case 5: every present check finished, the required gate not created yet: pending, and says what it waits for", async () => {
  const verdict = await verdictOf({ light: [["SUCCESS", 5]], detail: { pairs: [["SUCCESS", 5]], suites: [{ id: 1, build: [passed()] }] } });
  assert.equal(verdict.kind, "pending");
  assert.match(verdict.kind === "pending" ? verdict.waitingFor : "", /Merge Gate \(not created yet\)/);
});

test("case 6: the early failure's log is read from its job while the run still goes, and a missing log says why", async () => {
  const args: string[][] = [];
  const log = ["2026-11-11T12:44:30.1Z \x1b[36;1mnpm test\x1b[0m", "2026-11-11T12:44:36.9Z FAIL auth.test.ts", "2026-11-11T12:44:37.0Z ##[error]Process completed with exit code 2.", "2026-11-11T12:44:37.1Z Post job cleanup.", ""].join("\n");
  let answer: { stdout: string; stderr: string; error: (Error & { code?: number }) | null } = { stdout: log, stderr: "", error: null };
  const runner: Runner = async (call) => {
    args.push(call);
    return answer;
  };
  const reads = createReads(createGitHub(createQuota(), runner));
  const text = await reads.failedLog(REPO, { runId: 7, jobId: 8 });
  assert.deepEqual(args[0], ["api", "--allow-escape-sequences", `repos/${REPO}/actions/jobs/8/logs`]);
  assert.equal(text, "\n```\nnpm test\nFAIL auth.test.ts\n##[error]Process completed with exit code 2.\n```");
  answer = { stdout: "", stderr: "gh: Not Found (HTTP 404)", error: Object.assign(new Error("exit 1"), { code: 1 }) };
  assert.match(await reads.failedLog(REPO, { runId: 7, jobId: 8 }), /^\n\(Log not available: .*Not Found \(HTTP 404\)\)$/);
});

// --- the rest of the rule -----------------------------------------------------------

test("a required check in two suites: the latest started wins, so a passing re-run clears a failure and a failing one is not hidden", async () => {
  const rerunPassed = await verdictOf({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [failedRun(30)] }, { id: 2, gate: [passed(5)] }] } });
  assert.equal(rerunPassed.kind, "green");
  const rerunFailed = await verdictOf({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [passed(30)] }, { id: 2, gate: [failedRun(5)] }] } });
  assert.equal(rerunFailed.kind, "failed");
  // A re-run that has not started yet is the newest.
  const queued = await verdictOf({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [failedRun(30)] }, { id: 2, gate: [{ status: "QUEUED" }] }] } });
  assert.equal(queued.kind, "pending");
});

test("an optional job fails while the required gate still runs: pending, then green with the job named when the gate passes", async () => {
  const running: Pairs = [["SUCCESS", 200], ["IN_PROGRESS", 300], ["FAILURE", 1]];
  const lint = { name: "Lint", url: `https://github.com/${REPO}/actions/runs/7/job/8` };
  const script: Script = { light: running, detail: { pairs: running, suites: [{ id: 1, build: [passed()], gate: [{ status: "IN_PROGRESS", startedAt: ago(10) }], failed: [lint] }] } };
  const { hub } = setup(script);
  const first = (await hub.cycle())!.verdict(REPO, 12)!;
  assert.equal(first.kind, "pending");
  const done: Pairs = [["SUCCESS", 500], ["FAILURE", 1]];
  script.light = done;
  script.detail = { pairs: done, suites: [{ id: 1, build: [passed()], gate: [passed(1)], failed: [lint] }] };
  const second = (await hub.cycle())!.verdict(REPO, 12)!;
  assert.equal(second.kind, "green");
  assert.deepEqual(second.kind === "green" && second.optionalFailed.map((check) => check.name), ["Lint"]);
});

test("the required gate fails while other checks run: failed at once, named with the optional failures", async () => {
  const running: Pairs = [["SUCCESS", 200], ["IN_PROGRESS", 300], ["FAILURE", 2]];
  const verdict = await verdictOf({ light: running, detail: { pairs: running, suites: [{ id: 1, build: [passed()], gate: [failedRun(1)], failed: [{ name: "Lint" }] }] } });
  assert.equal(verdict.kind, "failed");
  assert.deepEqual(verdict.kind === "failed" && [verdict.blocking.map((check) => check.name), verdict.optionalFailed.map((check) => check.name)], [["Merge Gate"], ["Lint"]]);
});

test("classic required checks come from the branch; when it can't be read, the rulesets alone decide, and with none, all checks do", async () => {
  // Classic protection adds a required check the rulesets don't have.
  const classic = await verdictOf({ light: ALL_DONE, rules: ["Merge Gate"], classic: ["Build"], detail: { pairs: ALL_DONE, suites: [{ id: 1, gate: [passed()] }] } });
  assert.match(classic.kind === "pending" ? classic.waitingFor : "", /Build \(not created yet\)/);
  // Branch unreadable, rulesets name the gate: judged on the gate.
  const rulesOnly = await verdictOf({ light: [["SUCCESS", 9], ["FAILURE", 1]], rules: ["Merge Gate"], classic: "error", detail: { pairs: [["SUCCESS", 9], ["FAILURE", 1]], suites: [{ id: 1, gate: [passed()], failed: [{ name: "Docs Preview" }] }] } });
  assert.equal(rulesOnly.kind, "green");
  // Branch unreadable and no rulesets: every check decides, and the message says why.
  const all = await verdictOf({ light: [["SUCCESS", 10]], rules: [], classic: "error", detail: { pairs: [["SUCCESS", 10]], suites: [{ id: 1 }] } });
  assert.equal(all.kind, "green");
  assert.equal(all.kind === "green" && all.note, "required checks not readable; judged on all checks");
});

test("a failure in a workflow with no required check does not fail the PR", async () => {
  const verdict = await verdictOf({
    light: [["SUCCESS", 550], ["FAILURE", 1]],
    detail: { pairs: [["SUCCESS", 550], ["FAILURE", 1]], suites: [{ id: 1, build: [passed()], gate: [passed()] }, { id: 2, failed: [{ name: "Nightly Audit" }] }] },
  });
  assert.equal(verdict.kind, "green");
});

test("more check suites than were read: pending", async () => {
  const verdict = await verdictOf({ light: ALL_DONE, detail: { pairs: ALL_DONE, totalCount: 31, suites: [{ id: 1, build: [passed()], gate: [passed()] }] } });
  assert.equal(verdict.kind, "pending");
});

test("required checks unknown: pending, and asked again at the next detail read instead of cached", async () => {
  const reads: Pairs[] = [ALL_DONE, [["SUCCESS", 553]]];
  const { hub, calls } = setup({ light: () => reads.shift() ?? ALL_DONE, rules: "error", detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [passed()] }] } });
  assert.equal((await hub.cycle())!.verdict(REPO, 12)!.kind, "pending");
  // The counts moved and nothing runs: a new detail read, and the rules are asked again.
  assert.equal((await hub.cycle())!.verdict(REPO, 12)!.kind, "pending");
  assert.equal(calls.filter((call) => call === "rules").length, 2);
  assert.equal(calls.filter((call) => call === "detail").length, 2);
});

test("nothing required: every check is the gate", async () => {
  const green = await verdictOf({ light: [["SUCCESS", 10]], rules: [], detail: { pairs: [["SUCCESS", 10]], suites: [{ id: 1 }] } });
  assert.equal(green.kind, "green");
  const failed = await verdictOf({ light: [["SUCCESS", 9], ["FAILURE", 1]], rules: [], detail: { pairs: [["SUCCESS", 9], ["FAILURE", 1]], suites: [{ id: 1, failed: [{ name: "Tests" }] }] } });
  assert.equal(failed.kind, "failed");
  const running = await verdictOf({ light: [["SUCCESS", 9]], rules: [], detail: { pairs: [["SUCCESS", 9], ["IN_PROGRESS", 1]], suites: [{ id: 1 }] } });
  assert.equal(running.kind, "pending");
});

// --- the cycle ------------------------------------------------------------------------

test("a PR GitHub answers without is missing; a failed query leaves it unreadable", async () => {
  const gone: Runner = async (args) =>
    args[1] === "graphql"
      ? { stdout: JSON.stringify({ data: { rateLimit: { remaining: 4000, resetAt: RESET() }, viewer: { login: "sam" }, r0: { p12: null }, w0: null }, errors: [{ message: "Could not resolve to a PullRequest with the number of 12." }] }), stderr: "", error: Object.assign(new Error("exit 1"), { code: 1 }) }
      : { stdout: "[0,0]", stderr: "", error: null };
  const { bb } = fakeBb();
  const github = createGitHub(createQuota(), gone);
  const wanted: Interest = { ...WATCHED, runs: [{ repo: REPO, runId: 99 }] };
  const view = (await createHub(bb, github, createReads(github), async () => wanted).cycle())!;
  assert.deepEqual([...view.missing].sort(), [`${REPO}#12`, `${REPO}/runs/99`]);
  assert.equal(view.verdict(REPO, 12), undefined);

  const broken: Runner = async () => ({ stdout: "", stderr: "gh: connection reset", error: Object.assign(new Error("exit 1"), { code: 1 }) });
  const github2 = createGitHub(createQuota(), broken);
  const view2 = (await createHub(bb, github2, createReads(github2), async () => wanted).cycle())!;
  assert.deepEqual([...view2.unreadable].sort(), [`${REPO}#12`, `${REPO}/runs/99`]);
  assert.equal(view2.missing.size, 0);
});

test("runs are read in the light query, beyond the first 60 too", async () => {
  const runs = Array.from({ length: 61 }, (_, i) => ({ repo: REPO, runId: 1000 + i }));
  let queries = 0;
  const runner: Runner = async (args) => {
    const query = args[3] ?? "";
    queries += 1;
    const data: Record<string, unknown> = { rateLimit: { remaining: 4000, resetAt: RESET() }, viewer: { login: "sam" } };
    for (const match of query.matchAll(/w(\d+): resource\(url: "[^"]*\/runs\/(\d+)"\)/g)) {
      data[`w${match[1]}`] = { url: `u${match[2]}`, checkSuite: { status: "COMPLETED", conclusion: "FAILURE", failed: { totalCount: 23, nodes: [{ name: "deploy", conclusion: "FAILURE" }] } } };
    }
    return { stdout: JSON.stringify({ data }), stderr: "", error: null };
  };
  const { bb } = fakeBb();
  const github = createGitHub(createQuota(), runner);
  const view = (await createHub(bb, github, createReads(github), async () => ({ prs: [], runs, urgent: true })).cycle())!;
  assert.equal(queries, 2);
  assert.equal(view.run(REPO, 1060)?.url, "u1060");
  assert.equal(view.run(REPO, 1000)?.failedMore, 22);
});

test("soon(): at most one early cycle a minute, and says when it did not read", async () => {
  const { hub, calls } = setup({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [passed()] }] } });
  const first = await hub.soon();
  assert.equal(first.read, true);
  const second = await hub.soon();
  assert.deepEqual(second, { read: false, lastAt: first.lastAt, nextAt: first.lastAt + 60_000 });
  await Promise.all([hub.soon(), hub.soon()]);
  assert.equal(calls.filter((call) => call === "light").length, 1);
});

test("a reload aborts the cycle: nothing more is read and no listener is told", async () => {
  const { hub, services, calls } = setup({ light: ALL_DONE, detail: { pairs: ALL_DONE, suites: [{ id: 1, build: [passed()], gate: [passed()] }] } });
  const controller = new AbortController();
  controller.abort();
  await services[0]!(controller.signal);
  let told = 0;
  hub.onCycle(async () => void (told += 1));
  assert.equal(await hub.cycle(), null);
  assert.deepEqual(calls, []);
  assert.equal(told, 0);
});
