// The CI and run watchers on top of a real hub and a fake gh and bb: what a
// thread is told, and when.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHub, createQuota, createReads, type Runner } from "./github.ts";
import { createHub, type Interest } from "./pr-hub.ts";
import { createWatchers } from "./watchers.ts";

const REPO = "acme/web-app";
const HEAD = "abc1234def";
const RESET = () => new Date(Date.now() + 30 * 60_000).toISOString();
const failure = (stderr: string) => ({ stdout: "", stderr, error: Object.assign(new Error("exit 1"), { code: 1 }) });
const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", error: null });

type World = {
  prState?: "OPEN" | "MERGED" | "CLOSED" | null; // null: no such PR
  branchPr?: { number: number; state: string } | null;
  checks?: "green" | "lint-failed";
  run?: { status: string; conclusion: string | null; failed: number } | null;
};

function fakeGh(world: World) {
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    const query = args[1] === "graphql" ? args[3]!.slice("query=".length) : "";
    const rate = { rateLimit: { remaining: 4000, resetAt: RESET() } };
    if (query.includes("open: pullRequests")) {
      const nodes = world.branchPr ? [world.branchPr] : [];
      return ok({ data: { ...rate, repository: { open: { nodes: nodes.filter((pr) => pr.state === "OPEN") }, any: { nodes } } } });
    }
    if (query.includes("{ state title createdAt }")) {
      return ok({ data: { ...rate, repository: { pullRequest: world.prState ? { state: world.prState, title: "Fix login", createdAt: "2026-11-10T09:00:00Z" } : null } } });
    }
    if (query.includes("viewer { login }")) {
      const data: Record<string, unknown> = { ...rate, viewer: { login: "sam" } };
      const errors: Array<{ message: string }> = [];
      if (query.includes("p12:")) {
        const pairs = world.checks === "lint-failed" ? [["SUCCESS", 200], ["IN_PROGRESS", 300], ["FAILURE", 1]] : [["SUCCESS", 552]];
        data.r0 = world.prState
          ? {
              p12: {
                number: 12, title: "Fix login", url: `https://github.com/${REPO}/pull/12`, state: world.prState, isDraft: false, mergeable: "MERGEABLE", reviewDecision: null,
                baseRefName: "main", headRefName: "fix-login", headRefOid: HEAD, mergedAt: null,
                commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: "PENDING", contexts: { checkRunCountsByState: pairs.map(([state, count]) => ({ state, count })), statusContextCountsByState: [] } } } }] },
              },
            }
          : { p12: null };
        if (!world.prState) errors.push({ message: "Could not resolve to a PullRequest with the number of 12." });
      }
      if (query.includes("w0:")) {
        data.w0 = world.run
          ? { url: `https://github.com/${REPO}/actions/runs/77`, checkSuite: { status: world.run.status, conclusion: world.run.conclusion, failed: { totalCount: world.run.failed, nodes: Array.from({ length: Math.min(20, world.run.failed) }, (_, i) => ({ name: `job ${i + 1}`, conclusion: "FAILURE" })) } } }
          : null;
      }
      return { ...ok({ data, errors }), ...(errors.length > 0 ? { error: Object.assign(new Error("exit 1"), { code: 1 }) } : {}) };
    }
    if (query.includes("checkSuites(first")) {
      const lint = world.checks === "lint-failed";
      const gate = lint ? { name: "Merge Gate", status: "IN_PROGRESS", conclusion: null, startedAt: new Date().toISOString(), detailsUrl: null } : { name: "Merge Gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: new Date().toISOString(), detailsUrl: null };
      const pairs = lint ? [["SUCCESS", 200], ["IN_PROGRESS", 300], ["FAILURE", 1]] : [["SUCCESS", 552]];
      return ok({
        data: {
          ...rate,
          r: {
            d12: {
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: HEAD,
                      statusCheckRollup: { contexts: { checkRunCountsByState: pairs.map(([state, count]) => ({ state, count })), statusContextCountsByState: [] } },
                      status: { contexts: [] },
                      checkSuites: {
                        totalCount: 1,
                        nodes: [
                          {
                            databaseId: 1,
                            failed: { totalCount: lint ? 1 : 0, nodes: lint ? [{ name: "Lint", conclusion: "FAILURE", detailsUrl: `https://github.com/${REPO}/actions/runs/7/job/8` }] : [] },
                            q0: { nodes: [gate] },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (args[1]?.includes("/rules/branches/")) return ok([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Merge Gate" }] } }]);
    if (args[1]?.includes("/protection/")) return failure("gh: Branch not protected (HTTP 404)");
    if (args[0] === "run" && args.includes("--json")) {
      return world.run ? ok({ status: world.run.status.toLowerCase(), conclusion: world.run.conclusion, name: "Deploy", displayTitle: "Release 3", url: `https://github.com/${REPO}/actions/runs/77` }) : failure("gh: run not found (HTTP 404)");
    }
    if (args[1] === "--allow-escape-sequences") return failure("gh: Not Found (HTTP 404)");
    if (args[0] === "run" && args.includes("--log-failed")) return failure("gh: no failed jobs");
    if (args[1] === "rate_limit") return ok([0, 0]);
    return failure(`unexpected gh ${args.join(" ")}`);
  };
  return { runner, calls };
}

function fakeBb(threadStatus = "idle") {
  const kv = new Map<string, unknown>();
  const sent: Array<{ threadId: string; text: string }> = [];
  const bb = {
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)) } },
    events: { on: () => undefined },
    background: { schedule: () => undefined, service: () => undefined },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadStatus, archivedAt: null, projectId: "p1", environmentId: "e1", parentThreadId: null, updatedAt: Date.now() }),
        send: async ({ threadId, input }: { threadId: string; input: Array<{ text: string }> }) => {
          sent.push({ threadId, text: input[0]!.text });
          return { delivery: "sent" };
        },
        list: async () => [],
        output: async () => ({ output: "" }),
      },
      environments: { get: async () => ({ branchName: "fix-login" }) },
      projects: { get: async () => ({ name: "web-app", gitRemoteUrl: `git@github.com:${REPO}.git` }), list: async () => [] },
    },
  };
  return { bb: bb as never, kv, sent };
}

function setup(world: World, threadStatus = "idle") {
  let clock = Date.now();
  const { runner, calls } = fakeGh(world);
  const { bb, kv, sent } = fakeBb(threadStatus);
  const github = createGitHub(createQuota(() => clock), runner);
  const reads = createReads(github);
  let interest: () => Promise<Interest> = async () => ({ prs: [], runs: [], urgent: false });
  const hub = createHub(bb, github, reads, () => interest());
  const watchers = createWatchers(bb, reads, hub, {}, async () => false, () => undefined);
  interest = async () => ({ ...(await watchers.interest()), urgent: true });
  const advance = (ms: number) => void (clock += ms);
  return { hub, watchers, github, calls, kv, sent, advance };
}

test("wait_for_ci on a branch whose PR merged says it is already merged", async () => {
  const { watchers } = setup({ branchPr: { number: 12, state: "MERGED" }, prState: "MERGED" });
  await assert.rejects(watchers.watchCi("t1", {}), /acme\/web-app#12 is already merged \("Fix login", opened 2026-11-10\)/);
});

test("wait_for_ci on a branch without any PR", async () => {
  const { watchers } = setup({ branchPr: null });
  await assert.rejects(watchers.watchCi("t1", {}), /No open PR for branch fix-login/);
});

test("green: the thread is told once and a checks watch ends", async () => {
  const { hub, watchers, sent, kv } = setup({ prState: "OPEN", checks: "green" });
  await watchers.watchCi("t1", { pr: 12, watchFor: "checks" });
  await hub.cycle();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /^\[ci watcher\] ✅ CI is green on web-app#12 \(abc1234\): required checks passed \(Merge Gate\)/);
  assert.deepEqual(kv.get("ciWatches"), {});
  await hub.cycle();
  assert.equal(sent.length, 1);
});

test("a blocking failure while others run: told at once, with the job's log or why there is none", async () => {
  const { hub, watchers, sent, calls } = setup({ prState: "OPEN", checks: "lint-failed" });
  await watchers.watchCi("t1", { pr: 12, watchFor: "checks" });
  await hub.cycle();
  assert.match(sent[0]!.text, /❌ CI failed on web-app#12 \(abc1234\): Lint\. 300 checks still running; this is the first failure\.\n\(Log not available: .*Not Found/);
  assert.ok(calls.some((args) => args.join(" ") === `api --allow-escape-sequences repos/${REPO}/actions/jobs/8/logs`));
});

test("a working thread is left alone until it goes idle", async () => {
  const { hub, watchers, sent, kv } = setup({ prState: "OPEN", checks: "green" }, "active");
  await watchers.watchCi("t1", { pr: 12, watchFor: "checks" });
  await hub.cycle();
  assert.equal(sent.length, 0);
  assert.equal(Object.keys(kv.get("ciWatches") as object).length, 1);
});

test("registered while paused, then the PR turns out not to exist: the thread is told and the watch ends", async () => {
  const { hub, watchers, github, sent, kv, advance, calls } = setup({ prState: null });
  github.quota.record(900, Date.now() + 60_000);
  const watch = await watchers.watchCi("t1", { pr: 12, watchFor: "checks" });
  assert.equal(watch.pr, 12);
  await hub.cycle();
  assert.equal(calls.length, 0); // paused: nothing read
  assert.equal(sent.length, 0);
  advance(2 * 60_000);
  await hub.cycle();
  assert.match(sent[0]!.text, /acme\/web-app#12 doesn't exist or isn't accessible; stopped watching/);
  assert.deepEqual(kv.get("ciWatches"), {});
});

test("run watch: a failed run names its failed jobs and how many more", async () => {
  const world: World = { run: { status: "IN_PROGRESS", conclusion: null, failed: 0 } };
  const { hub, watchers, sent } = setup(world);
  await watchers.watchRun("t1", 77, REPO);
  world.run = { status: "COMPLETED", conclusion: "FAILURE", failed: 23 };
  await hub.cycle();
  assert.match(sent[0]!.text, /^\[run watcher\] ❌ web-app · Deploy \(Release 3\) finished: failure\. Failed: job 1, [^]*job 20 and 3 more\./);
});

test("run watch registered while paused for a run that does not exist: told at the first read", async () => {
  const { hub, watchers, github, sent, advance } = setup({ run: null });
  github.quota.record(900, Date.now() + 60_000);
  await watchers.watchRun("t1", 77, REPO);
  advance(2 * 60_000);
  await hub.cycle();
  assert.match(sent[0]!.text, /Run 77 in acme\/web-app doesn't exist or isn't accessible; stopped watching\./);
});
