// Pure parts of the GitHub hub (pr-hub.ts): the queries it sends, how it reads
// the answers, and what a PR's checks mean. No I/O here, so it is tested
// directly (hub-model.test.ts).
//
// The one rule for a CI watch's verdict (checksVerdict):
// - GREEN only when a detail read made in this cycle, of the PR's current
//   head, shows every required check passed.
// - FAILED only when, in that read, a check the base branch requires has
//   failed. A failed job that is not itself required never fails the PR, even
//   in the workflow of a required gate: the gate decides, and the watch says
//   so when the gate fails.
// - Everything else is PENDING, with what it waits for: a required check that
//   is queued, running or not created yet; no detail read this cycle (skipped,
//   paused, refused, failed); a head that moved; unknown required checks; more
//   check suites than were read.
// A base branch that requires nothing makes every check its gate, as GitHub's
// own rollup does: green when the read shows all checks finished and none
// failed, failed when any failed. So does a branch whose classic protection
// could not be read and whose rulesets require nothing; the message says so.
// Failed checks that are not required are named in the green or failed line.

/** Check-run conclusions that fail a check. */
export const FAILED_CONCLUSIONS = ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"] as const;
const FAILED = new Set<string>([...FAILED_CONCLUSIONS, "ERROR"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
/** Check suites read per PR when its failures or required checks are needed. */
export const DETAIL_SUITES = 30;
/** Failed check runs listed per suite (the rest are counted). */
export const FAILED_PER_SUITE = 10;
/** Failed jobs listed per run (the rest are counted). */
export const FAILED_JOBS = 20;
/** PRs (or runs) per light query, and PRs per detail query. */
export const LIGHT_BATCH = 60;
export const DETAIL_BATCH = 10;
/** Recent reviews and comments read for a PR someone waits on (a read is at most a few minutes apart). */
export const RECENT_FEEDBACK = 30;
/** While checks run, required checks are read again at most this often. */
export const REQUIRED_RECHECK_MS = 5 * 60_000;

export type PrKey = string; // "owner/name#123"
export const prKey = (repo: string, number: number): PrKey => `${repo}#${number}`;

export type Counts = { total: number; pending: number; failed: number; passed: number };
export type Feedback = {
  reviews: Array<{ author: string | null; state: string; body: string; at: number }>;
  comments: Array<{ author: string | null; body: string; at: number }>;
};

/** What one cheap read says about a PR. */
export type PrLight = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  base: string;
  head: string;
  headSha: string;
  mergedAt: number | null;
  /** Null when the head commit has no checks at all. */
  counts: Counts | null;
  /** Only for PRs someone waits on for reviews. */
  feedback: Feedback | null;
  readAt: number;
};

export type CheckState = "passed" | "failed" | "pending";
export type FailedCheck = { name: string; conclusion: string; url: string | null };
/** One instance of a required check, as it appears in one suite (or as a commit status). */
export type RequiredRun = { name: string; state: CheckState; startedAt: number | null; url: string | null };
export type DetailSuite = { failed: FailedCheck[]; failedMore: number; required: RequiredRun[] };
/** A base branch's required check names; `classicUnreadable`: only its rulesets could be read. */
export type RequiredChecks = { names: string[]; classicUnreadable: boolean };

/** One detail read of a PR's head: its own counts, failures per suite, and every required check instance. */
export type PrDetail = {
  headSha: string;
  counts: Counts;
  suites: DetailSuite[];
  /** Commit statuses (the older API), each with its state. */
  statuses: Array<{ name: string; state: CheckState; url: string | null }>;
  /** More check suites than were read. */
  incomplete: boolean;
  /** The light read's counts when this detail was read, to tell whether anything moved since. */
  lightCounts: Counts;
  readAt: number;
};

export type Attention = ReturnType<typeof attentionOf>;
export type RequiredState = { name: string; state: CheckState | "missing"; url: string | null };
export type Verdict =
  | { kind: "none" }
  | { kind: "pending"; pending: number; waitingFor: string }
  | { kind: "failed"; blocking: FailedCheck[]; optionalFailed: FailedCheck[]; more: number; pending: number; note: string | null }
  | { kind: "green"; required: string[]; passed: number; total: number; optionalFailed: FailedCheck[]; more: number; pending: number; note: string | null };

// --- queries -----------------------------------------------------------------------

const repoArgs = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
};

export type LightItem = { repo: string; number: number; feedback: boolean };
export type RunItem = { repo: string; runId: number };

const COUNTS = `contexts(first: 0) { checkRunCountsByState { state count } statusContextCountsByState { state count } }`;
const LIGHT_FIELDS = `number title url state isDraft mergeable reviewDecision baseRefName headRefName headRefOid mergedAt
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state ${COUNTS} } } } }`;
const FEEDBACK_FIELDS = `reviews(last: ${RECENT_FEEDBACK}) { nodes { author { login } state body submittedAt } }
  comments(last: ${RECENT_FEEDBACK}) { nodes { author { login } body createdAt } }`;
const FAILED_FILTER = `filterBy: {checkType: LATEST, conclusions: [${FAILED_CONCLUSIONS.join(", ")}]}`;
// GitHub resolves an Actions run URL to its WorkflowRun (verified live on 11 Nov 2026).
const RUN_FIELDS = `... on WorkflowRun { url checkSuite { status conclusion
  failed: checkRuns(first: ${FAILED_JOBS}, ${FAILED_FILTER}) { totalCount nodes { name conclusion } } } }`;

/** PRs and runs split into queries of at most LIGHT_BATCH each; PRs of several repos share a query. */
export function lightBatches(prs: LightItem[], runs: RunItem[]): Array<{ prs: LightItem[]; runs: RunItem[] }> {
  const batches: Array<{ prs: LightItem[]; runs: RunItem[] }> = [];
  for (let i = 0; i < prs.length; i += LIGHT_BATCH) batches.push({ prs: prs.slice(i, i + LIGHT_BATCH), runs: [] });
  for (let i = 0; i < runs.length; i += LIGHT_BATCH) {
    const index = i / LIGHT_BATCH;
    if (batches[index]) batches[index]!.runs = runs.slice(i, i + LIGHT_BATCH);
    else batches.push({ prs: [], runs: runs.slice(i, i + LIGHT_BATCH) });
  }
  return batches;
}

/** One query for up to LIGHT_BATCH PRs and runs, across repos: 1-2 points. */
export function lightQuery(prs: LightItem[], runs: RunItem[]): string {
  const byRepo = new Map<string, LightItem[]>();
  for (const pr of prs) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  const repos = [...byRepo.entries()].map(
    ([repo, items], r) =>
      `r${r}: repository(${repoArgs(repo)}) { ${items
        .map((item) => `p${item.number}: pullRequest(number: ${item.number}) { ${LIGHT_FIELDS}${item.feedback ? ` ${FEEDBACK_FIELDS}` : ""} }`)
        .join(" ")} }`,
  );
  const runFields = runs.map((run, i) => `w${i}: resource(url: ${JSON.stringify(`https://github.com/${run.repo}/actions/runs/${run.runId}`)}) { ${RUN_FIELDS} }`);
  return `query { viewer { login } rateLimit { remaining resetAt } ${[...repos, ...runFields].join(" ")} }`;
}
export const lightRepoAlias = (prs: LightItem[]) => [...new Set(prs.map((pr) => pr.repo))];

/** A PR's head: its counts, failed check runs per suite, and every instance of each required check. */
export function detailQuery(repo: string, numbers: number[], required: string[]): string {
  const requiredFields = required
    .map((name, i) => `q${i}: checkRuns(first: 5, filterBy: {checkType: LATEST, checkName: ${JSON.stringify(name)}}) { nodes { name status conclusion startedAt detailsUrl } }`)
    .join(" ");
  const prs = numbers.map(
    (n) => `d${n}: pullRequest(number: ${n}) { commits(last: 1) { nodes { commit { oid statusCheckRollup { ${COUNTS} } status { contexts { context state targetUrl } }
      checkSuites(first: ${DETAIL_SUITES}) { totalCount nodes {
        failed: checkRuns(first: ${FAILED_PER_SUITE}, ${FAILED_FILTER}) { totalCount nodes { name conclusion detailsUrl } }
        ${requiredFields} } } } } } }`,
  );
  return `query { rateLimit { remaining resetAt } r: repository(${repoArgs(repo)}) { ${prs.join(" ")} } }`;
}

// --- reading answers ---------------------------------------------------------------------

type StateCount = { state: string; count: number };
type GqlCounts = { checkRunCountsByState: StateCount[]; statusContextCountsByState: StateCount[] };
type GqlLightPr = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergedAt: string | null;
  commits: { nodes: Array<{ commit: { oid: string; statusCheckRollup: { state: string; contexts: GqlCounts } | null } }> };
  reviews?: { nodes: Array<{ author: { login: string } | null; state: string; body: string; submittedAt: string | null }> };
  comments?: { nodes: Array<{ author: { login: string } | null; body: string; createdAt: string }> };
};

export function countsOf(byState: StateCount[]): Counts {
  const counts: Counts = { total: 0, pending: 0, failed: 0, passed: 0 };
  for (const { state, count } of byState) {
    if (count === 0) continue;
    counts.total += count;
    if (FAILED.has(state)) counts.failed += count;
    else if (PENDING.has(state)) counts.pending += count;
    else counts.passed += count; // SUCCESS, NEUTRAL, SKIPPED, STALE, COMPLETED
  }
  return counts;
}
const rollupCounts = (contexts: GqlCounts) => countsOf([...contexts.checkRunCountsByState, ...contexts.statusContextCountsByState]);

export function readLightPr(repo: string, pr: GqlLightPr, readAt: number): PrLight {
  const commit = pr.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const counts = rollup ? rollupCounts(rollup.contexts) : null;
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision,
    base: pr.baseRefName,
    head: pr.headRefName,
    headSha: commit?.oid ?? pr.headRefOid,
    mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
    counts: counts && counts.total > 0 ? counts : null,
    feedback:
      pr.reviews && pr.comments
        ? {
            reviews: pr.reviews.nodes.map((review) => ({ author: review.author?.login ?? null, state: review.state, body: review.body, at: Date.parse(review.submittedAt ?? "") || 0 })),
            comments: pr.comments.nodes.map((comment) => ({ author: comment.author?.login ?? null, body: comment.body, at: Date.parse(comment.createdAt) })),
          }
        : null,
    readAt,
  };
}

export type LightAnswer = {
  viewer?: { login: string } | null;
  [alias: string]: unknown;
};

/** PRs and runs from a light answer; a PR or run GitHub couldn't resolve is simply absent. */
export function readLight(answer: LightAnswer, prs: LightItem[], runs: RunItem[], readAt: number) {
  const repos = lightRepoAlias(prs);
  const out = new Map<PrKey, PrLight>();
  repos.forEach((repo, r) => {
    const data = answer[`r${r}`] as Record<string, GqlLightPr | null> | null | undefined;
    for (const item of prs.filter((pr) => pr.repo === repo)) {
      const pr = data?.[`p${item.number}`];
      if (pr) out.set(prKey(repo, item.number), readLightPr(repo, pr, readAt));
    }
  });
  const runStates = new Map<string, RunLight>();
  runs.forEach((run, i) => {
    const node = answer[`w${i}`] as GqlRun | null | undefined;
    if (node?.checkSuite) runStates.set(runKey(run.repo, run.runId), readRun(node));
  });
  return { prs: out, runs: runStates, login: answer.viewer?.login ?? null };
}
export const runKey = (repo: string, runId: number) => `${repo}/runs/${runId}`;

type GqlRun = { url: string; checkSuite: { status: string; conclusion: string | null; failed: { totalCount: number; nodes: Array<{ name: string; conclusion: string | null }> } } | null };
export type RunLight = { status: string; conclusion: string | null; url: string; failedJobs: Array<{ name: string; conclusion: string | null }>; failedMore: number };

export function readRun(node: GqlRun): RunLight {
  const suite = node.checkSuite!;
  return {
    status: suite.status.toLowerCase(),
    conclusion: suite.conclusion ? suite.conclusion.toLowerCase() : null,
    url: node.url,
    failedJobs: suite.failed.nodes.map((job) => ({ name: job.name, conclusion: job.conclusion ? job.conclusion.toLowerCase() : null })),
    failedMore: Math.max(0, suite.failed.totalCount - suite.failed.nodes.length),
  };
}

type GqlCheckRun = { name: string; status?: string; conclusion: string | null; startedAt?: string | null; detailsUrl: string | null };
type GqlDetailPr = {
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: { contexts: GqlCounts } | null;
        status: { contexts: Array<{ context: string; state: string; targetUrl: string | null }> } | null;
        checkSuites: { totalCount: number; nodes: Array<{ failed: { totalCount: number; nodes: GqlCheckRun[] }; [alias: string]: unknown }> };
      };
    }>;
  };
};

const runState = (run: GqlCheckRun): CheckState => (run.status !== "COMPLETED" ? "pending" : FAILED.has(run.conclusion ?? "") ? "failed" : "passed");
const statusState = (state: string): CheckState => (FAILED.has(state) ? "failed" : PENDING.has(state) ? "pending" : "passed");

/** A detail answer, or null when it is not about the head the light read saw (a push landed in between). */
export function readDetail(pr: GqlDetailPr | null | undefined, required: string[], light: PrLight, readAt: number): PrDetail | null {
  const commit = pr?.commits.nodes[0]?.commit;
  if (!commit || commit.oid !== light.headSha || !light.counts) return null;
  const suites: DetailSuite[] = commit.checkSuites.nodes.map((suite) => ({
    failed: suite.failed.nodes.map((run) => ({ name: run.name, conclusion: (run.conclusion ?? "FAILURE").toLowerCase(), url: run.detailsUrl })),
    failedMore: Math.max(0, suite.failed.totalCount - suite.failed.nodes.length),
    required: required.flatMap((name, i) =>
      ((suite[`q${i}`] as { nodes: GqlCheckRun[] } | undefined)?.nodes ?? []).map((run) => ({
        name,
        state: runState(run),
        startedAt: run.startedAt ? Date.parse(run.startedAt) : null,
        url: run.detailsUrl,
      })),
    ),
  }));
  return {
    headSha: commit.oid,
    counts: commit.statusCheckRollup ? rollupCounts(commit.statusCheckRollup.contexts) : { total: 0, pending: 0, failed: 0, passed: 0 },
    suites,
    statuses: (commit.status?.contexts ?? []).map((context) => ({ name: context.context, state: statusState(context.state), url: context.targetUrl })),
    incomplete: commit.checkSuites.totalCount > suites.length,
    lightCounts: light.counts,
    readAt,
  };
}

// --- what the checks mean ----------------------------------------------------------------

/**
 * The instance of a required check that counts. A name can appear in more than
 * one suite on the same commit (the same workflow run for two events, or a
 * re-run): the most recently started one wins, the way GitHub reports a
 * check's latest result, so a passing re-run clears an earlier failure (and a
 * newer skipped run hides an older failure, as GitHub evaluates it too). One
 * that has not started yet is the newest; on a tie the one that has not
 * passed wins. A commit status of that name is used only when no check run
 * has it.
 */
export function requiredStates(detail: PrDetail, required: string[]): RequiredState[] {
  return required.map((name) => {
    let best: RequiredRun | null = null;
    for (const suite of detail.suites) {
      for (const run of suite.required) {
        if (run.name !== name) continue;
        const mine = run.startedAt ?? Infinity;
        const theirs = best?.startedAt ?? -Infinity;
        if (best === null || mine > theirs || (mine === theirs && run.state !== "passed")) best = run;
      }
    }
    if (best) return { name, state: best.state, url: best.url };
    const status = detail.statuses.find((candidate) => candidate.name === name);
    return status ? { name, state: status.state, url: status.url } : { name, state: "missing" as const, url: null };
  });
}

const pendingVerdict = (pending: number, waitingFor: string): Verdict => ({ kind: "pending", pending, waitingFor });
const ALL_CHECKS_NOTE = "required checks not readable; judged on all checks";

/**
 * The verdict of a CI watch (see the rule at the top). `detail` must be a read
 * made in this cycle; pass undefined otherwise.
 */
export function checksVerdict(light: PrLight, detail: PrDetail | undefined, required: RequiredChecks | null): Verdict {
  if (!light.counts) return { kind: "none" };
  const pending = light.counts.pending;
  if (!detail) return pendingVerdict(pending, "check details not read this cycle");
  if (detail.headSha !== light.headSha) return pendingVerdict(pending, "a newer push");
  if (required === null) return pendingVerdict(pending, "the base branch's required checks (could not read them)");
  if (detail.incomplete) return pendingVerdict(pending, `more than ${DETAIL_SUITES} check suites; required checks may be among those not read`);
  const counts = detail.counts;
  const failedStatuses = detail.statuses.filter((status) => status.state === "failed").map((status) => ({ name: status.name, conclusion: "failure", url: status.url }));
  const allFailed = [...detail.suites.flatMap((suite) => suite.failed), ...failedStatuses];
  const more = detail.suites.reduce((sum, suite) => sum + suite.failedMore, 0);
  const names = required.names;

  if (names.length === 0) {
    // Nothing required (or nothing readable): every check is the gate.
    const note = required.classicUnreadable ? ALL_CHECKS_NOTE : null;
    if (allFailed.length > 0) return { kind: "failed", blocking: allFailed, optionalFailed: [], more, pending: counts.pending, note };
    if (counts.pending > 0 || counts.total === 0) return pendingVerdict(counts.pending, `${counts.pending} running check${counts.pending === 1 ? "" : "s"}`);
    return { kind: "green", required: [], passed: counts.passed, total: counts.total, optionalFailed: [], more: 0, pending: 0, note };
  }

  const states = requiredStates(detail, names);
  const optionalFailed = allFailed.filter((check) => !names.includes(check.name));
  const requiredFailed = states.filter((state) => state.state === "failed");
  if (requiredFailed.length > 0) {
    const blocking = requiredFailed.map((state) => ({ name: state.name, conclusion: "failure", url: state.url }));
    return { kind: "failed", blocking, optionalFailed, more, pending: counts.pending, note: null };
  }
  if (states.every((state) => state.state === "passed")) {
    return { kind: "green", required: names, passed: counts.passed, total: counts.total, optionalFailed, more, pending: counts.pending, note: null };
  }
  const waiting = states
    .filter((state) => state.state !== "passed")
    .map((state) => `${state.name} (${state.state === "missing" ? "not created yet" : "queued or running"})`)
    .join(", ");
  return pendingVerdict(counts.pending, `required ${waiting}`);
}

/**
 * Whether the hub should spend a detail read on this PR now. Failures are
 * explained once per head and failure count (for the sidebar too). A PR whose
 * checks someone waits on is read when its counts moved and nothing is left
 * running, and otherwise at most every five minutes, so a wait that a read
 * could end (a required check created late, a rules read that failed) never
 * stalls on unchanged counts. A watch ends at its first green or failed read,
 * so this only repeats for PRs still pending.
 */
export function detailNeeded(light: PrLight, detail: PrDetail | undefined, watched: boolean, now: number): boolean {
  const counts = light.counts;
  if (!counts || light.state !== "OPEN") return false;
  const sameHead = detail !== undefined && detail.headSha === light.headSha;
  if (!sameHead) return counts.failed > 0 || watched;
  const seen = detail!.lightCounts;
  if (counts.failed !== seen.failed) return true;
  if (!watched) return false;
  const moved = counts.total !== seen.total || counts.pending !== seen.pending || counts.passed !== seen.passed;
  if (moved && counts.pending === 0) return true;
  return now - detail!.readAt >= REQUIRED_RECHECK_MS;
}

/**
 * The sidebar's one-word state of a PR. Display only: it uses the last detail
 * read of the current head, whenever it was made, and the light counts.
 */
export function attentionOf(light: PrLight, lastDetail: PrDetail | undefined, required: RequiredChecks | null) {
  if (light.state === "MERGED") return "merged" as const;
  if (light.state === "CLOSED") return "closed" as const;
  if (light.isDraft) return "draft" as const;
  if (light.mergeable === "CONFLICTING") return "conflicts" as const;
  const counts = light.counts;
  const detail = lastDetail?.headSha === light.headSha ? lastDetail : undefined;
  const verdict = counts && detail ? checksVerdict(light, detail, required) : null;
  if (verdict?.kind === "failed" || (counts && counts.failed > 0 && !detail)) return "checks_failed" as const;
  if (light.reviewDecision === "CHANGES_REQUESTED") return "changes_requested" as const;
  if ((counts && counts.pending > 0 && verdict?.kind !== "green") || verdict?.kind === "pending") return "checks_pending" as const;
  if (light.reviewDecision === "REVIEW_REQUIRED") return "review_requested" as const;
  return "ready_to_merge" as const;
}

const short = (repo: string) => repo.split("/")[1];

const names = (checks: FailedCheck[], more: number) => `${checks.map((check) => check.name).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;

/** The CI watcher's line for a finished verdict. */
export function verdictText(light: PrLight, verdict: Extract<Verdict, { kind: "green" | "failed" }>): string {
  const where = `${short(light.repo)}#${light.number} (${light.headSha.slice(0, 7)})`;
  const note = verdict.note ? ` (${verdict.note})` : "";
  const optional = verdict.optionalFailed.length > 0 ? ` Optional checks failed (not required): ${names(verdict.optionalFailed, verdict.more)}.` : "";
  if (verdict.kind === "failed") {
    const blockingMore = verdict.optionalFailed.length > 0 ? 0 : verdict.more;
    const still = verdict.pending > 0 ? ` ${verdict.pending} check${verdict.pending === 1 ? "" : "s"} still running.` : "";
    return `❌ CI failed on ${where}${note}: ${names(verdict.blocking, blockingMore)}.${optional}${still}`;
  }
  const required = verdict.required.length > 0 ? ` required checks passed (${verdict.required.join(", ")});` : "";
  const running = verdict.pending > 0 ? ` ${verdict.pending} optional check${verdict.pending === 1 ? "" : "s"} still running.` : "";
  const passed = verdict.required.length > 0 ? `${verdict.passed} of ${verdict.total} checks passed` : `${verdict.passed} checks passed`;
  return `✅ CI is green on ${where}${note}:${required} ${passed}.${optional}${running}`;
}
