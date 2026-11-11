// Pure parts of the GitHub hub (pr-hub.ts): the queries it sends, how it reads
// the answers, and what a PR's checks mean. No I/O here, so it is tested
// directly (hub-model.test.ts).

/** Check-run conclusions that fail a check. */
export const FAILED_CONCLUSIONS = ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"] as const;
const FAILED = new Set<string>([...FAILED_CONCLUSIONS, "ERROR"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
/** Check suites read per PR when its failures or required checks are needed. */
export const DETAIL_SUITES = 30;
/** PRs per light query, and per detail query. */
export const LIGHT_BATCH = 40;
export const DETAIL_BATCH = 10;
/** Recent reviews and comments read for a PR someone waits on. */
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

export type FailedCheck = { name: string; conclusion: string; url: string | null; blocking: boolean };
export type RequiredState = { name: string; state: "passed" | "failed" | "pending" | "missing"; url: string | null };

/** What a detail read says about a PR's failures and required checks, for one head and failure count. */
export type PrDetail = {
  headSha: string;
  failedCount: number;
  pendingCount: number;
  failed: FailedCheck[];
  /** Null when the base branch's required checks are unknown. */
  required: RequiredState[] | null;
  /** More check suites than were read: required checks may be missing from the answer. */
  incomplete: boolean;
  readAt: number;
};

export type Verdict =
  | { kind: "none" }
  | { kind: "pending"; pending: number }
  | { kind: "failed"; blocking: FailedCheck[]; pending: number }
  | { kind: "green"; required: string[]; passed: number; total: number; optionalFailed: FailedCheck[]; pending: number };

// --- queries -----------------------------------------------------------------------

const repoArgs = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
};

export type LightItem = { repo: string; number: number; feedback: boolean };
export type RunItem = { repo: string; runId: number };

const LIGHT_FIELDS = `number title url state isDraft mergeable reviewDecision baseRefName headRefName headRefOid mergedAt
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 0) {
    checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }`;
const FEEDBACK_FIELDS = `reviews(last: ${RECENT_FEEDBACK}) { nodes { author { login } state body submittedAt } }
  comments(last: ${RECENT_FEEDBACK}) { nodes { author { login } body createdAt } }`;
const RUN_FIELDS = `... on WorkflowRun { url checkSuite { status conclusion
  failed: checkRuns(first: 20, filterBy: {checkType: LATEST, conclusions: [${FAILED_CONCLUSIONS.join(", ")}]}) { nodes { name conclusion } } } }`;

/** One query for every PR and run the hub follows, across repos: about 1 point. */
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

/** Failed checks (with whether GitHub requires them) and each required check, for a few PRs of one repo. */
export function detailQuery(repo: string, numbers: number[], required: string[]): string {
  const requiredFields = required
    .map((name, i) => `q${i}: checkRuns(first: 1, filterBy: {checkType: LATEST, checkName: ${JSON.stringify(name)}}) { nodes { name status conclusion detailsUrl } }`)
    .join(" ");
  const prs = numbers.map(
    (n) => `d${n}: pullRequest(number: ${n}) { commits(last: 1) { nodes { commit { oid status { contexts { context state targetUrl } }
      checkSuites(first: ${DETAIL_SUITES}) { totalCount nodes { workflowRun { databaseId }
        failed: checkRuns(first: 10, filterBy: {checkType: LATEST, conclusions: [${FAILED_CONCLUSIONS.join(", ")}]}) { nodes { name conclusion detailsUrl isRequired(pullRequestNumber: ${n}) } }
        ${requiredFields} } } } } } }`,
  );
  return `query { rateLimit { remaining resetAt } r: repository(${repoArgs(repo)}) { ${prs.join(" ")} } }`;
}

// --- reading answers ---------------------------------------------------------------------

type StateCount = { state: string; count: number };
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
  commits: { nodes: Array<{ commit: { oid: string; statusCheckRollup: { state: string; contexts: { checkRunCountsByState: StateCount[]; statusContextCountsByState: StateCount[] } } | null } }> };
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

export function readLightPr(repo: string, pr: GqlLightPr, readAt: number): PrLight {
  const commit = pr.commits.nodes[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const counts = rollup ? countsOf([...rollup.contexts.checkRunCountsByState, ...rollup.contexts.statusContextCountsByState]) : null;
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
    if (node?.checkSuite) runStates.set(`${run.repo}/runs/${run.runId}`, readRun(node));
  });
  return { prs: out, runs: runStates, login: answer.viewer?.login ?? null };
}

type GqlRun = { url: string; checkSuite: { status: string; conclusion: string | null; failed: { nodes: Array<{ name: string; conclusion: string | null }> } } | null };
export type RunLight = { status: string; conclusion: string | null; url: string; failedJobs: Array<{ name: string; conclusion: string | null }> };

export function readRun(node: GqlRun): RunLight {
  const suite = node.checkSuite!;
  return {
    status: suite.status.toLowerCase(),
    conclusion: suite.conclusion ? suite.conclusion.toLowerCase() : null,
    url: node.url,
    failedJobs: suite.failed.nodes.map((job) => ({ name: job.name, conclusion: job.conclusion ? job.conclusion.toLowerCase() : null })),
  };
}

type GqlCheckRun = { name: string; status?: string; conclusion: string | null; detailsUrl: string | null; isRequired?: boolean };
type GqlDetailPr = {
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        status: { contexts: Array<{ context: string; state: string; targetUrl: string | null }> } | null;
        checkSuites: { totalCount: number; nodes: Array<{ workflowRun: { databaseId: number } | null; failed: { nodes: GqlCheckRun[] }; [alias: string]: unknown }> };
      };
    }>;
  };
};

/**
 * Failures and required checks of one PR. A failure blocks the merge when
 * GitHub requires it, when its workflow run also produces a required check
 * (a gate job like "Merge Gate" fails because of it), or when the branch
 * requires nothing (then every check counts, as GitHub's own rollup does).
 */
export function readDetail(pr: GqlDetailPr | null | undefined, required: string[] | null, light: PrLight, readAt: number): PrDetail | null {
  const commit = pr?.commits.nodes[0]?.commit;
  if (!commit || !light.counts) return null;
  const suites = commit.checkSuites.nodes;
  const requiredByName = new Map<string, RequiredState>();
  const gateSuites = new Set<number>();
  for (const name of required ?? []) requiredByName.set(name, { name, state: "missing", url: null });
  suites.forEach((suite) => {
    (required ?? []).forEach((name, i) => {
      const run = (suite[`q${i}`] as { nodes: GqlCheckRun[] } | undefined)?.nodes[0];
      if (!run) return;
      const state = run.status !== "COMPLETED" ? "pending" : FAILED.has(run.conclusion ?? "") ? "failed" : "passed";
      requiredByName.set(name, { name, state, url: run.detailsUrl });
      if (suite.workflowRun) gateSuites.add(suite.workflowRun.databaseId);
    });
  });
  const failed: FailedCheck[] = [];
  for (const suite of suites) {
    for (const run of suite.failed.nodes) {
      const viaGate = suite.workflowRun !== null && gateSuites.has(suite.workflowRun.databaseId);
      const blocking = required === null || required.length === 0 || run.isRequired === true || requiredByName.has(run.name) || viaGate;
      failed.push({ name: run.name, conclusion: (run.conclusion ?? "FAILURE").toLowerCase(), url: run.detailsUrl, blocking });
    }
  }
  for (const context of commit.status?.contexts ?? []) {
    if (requiredByName.has(context.context)) {
      const state = FAILED.has(context.state) ? "failed" : PENDING.has(context.state) ? "pending" : "passed";
      requiredByName.set(context.context, { name: context.context, state, url: context.targetUrl });
    }
    if (FAILED.has(context.state)) {
      const blocking = required === null || required.length === 0 || requiredByName.has(context.context);
      failed.push({ name: context.context, conclusion: context.state.toLowerCase(), url: context.targetUrl, blocking });
    }
  }
  return {
    headSha: commit.oid,
    failedCount: light.counts.failed,
    pendingCount: light.counts.pending,
    failed,
    required: required === null ? null : [...requiredByName.values()],
    incomplete: commit.checkSuites.totalCount > suites.length,
    readAt,
  };
}

// --- what the checks mean ----------------------------------------------------------------

const detailFor = (light: PrLight, detail: PrDetail | undefined) =>
  detail && light.counts && detail.headSha === light.headSha && detail.failedCount === light.counts.failed ? detail : undefined;

/**
 * Whether a PR's checks are done, and how. Done means: the checks the base
 * branch requires passed, or a check that blocks the merge failed. Without
 * required checks it means every check finished, as before. A verdict is only
 * given from a detail read of the current head and failure count; otherwise
 * the PR is pending until that read happens.
 */
export function checksVerdict(light: PrLight, detail: PrDetail | undefined, required: string[] | null): Verdict {
  const counts = light.counts;
  if (!counts) return { kind: "none" };
  const sameHead = detail?.headSha === light.headSha ? detail : undefined;
  const current = sameHead?.failedCount === counts.failed ? sameHead : undefined;
  if (counts.failed > 0) {
    if (!current) return { kind: "pending", pending: counts.pending };
    const blocking = current.failed.filter((check) => check.blocking);
    if (blocking.length > 0) return { kind: "failed", blocking, pending: counts.pending };
  }
  const optionalFailed = current?.failed.filter((check) => !check.blocking) ?? [];
  const requiredNames = required ?? [];
  const green = (pending: number): Verdict => ({ kind: "green", required: requiredNames, passed: counts.passed, total: counts.total, optionalFailed, pending });
  if (counts.pending > 0) {
    // Required checks done while optional ones still run: done, from a read of this head.
    const known = sameHead && !sameHead.incomplete ? sameHead.required : null;
    if (requiredNames.length > 0 && known && known.every((check) => check.state === "passed")) return green(counts.pending);
    return { kind: "pending", pending: counts.pending };
  }
  // Every check finished and none that blocks failed. A required check that never reported still blocks.
  const missing = sameHead && sameHead.pendingCount === 0 && !sameHead.incomplete ? (sameHead.required ?? []).filter((check) => check.state === "missing") : [];
  if (missing.length > 0) {
    return { kind: "failed", blocking: missing.map((check) => ({ name: check.name, conclusion: "did not run", url: null, blocking: true })), pending: 0 };
  }
  return green(0);
}

/**
 * Whether the hub should spend a detail read on this PR now. Failures are
 * always explained once per head and failure count. For a PR someone waits
 * on, required checks are read when all checks finished, and at most every
 * five minutes while they run and the counts move.
 */
export function detailNeeded(light: PrLight, detail: PrDetail | undefined, required: string[] | null, watched: boolean, now: number, lastCounts: Counts | null): boolean {
  const counts = light.counts;
  if (!counts || light.state !== "OPEN") return false;
  const sameHead = detail?.headSha === light.headSha;
  if (counts.failed > 0 && !(sameHead && detail!.failedCount === counts.failed)) return true;
  if (!watched || !required || required.length === 0) return false;
  if (counts.pending === 0) return !(sameHead && detail!.pendingCount === 0);
  const moved = lastCounts === null || lastCounts.passed !== counts.passed || lastCounts.pending !== counts.pending;
  return moved && (!sameHead || now - detail!.readAt >= REQUIRED_RECHECK_MS);
}

/** The sidebar's one-word state of a PR. */
export function attentionOf(light: PrLight, verdict: Verdict) {
  if (light.state === "MERGED") return "merged" as const;
  if (light.state === "CLOSED") return "closed" as const;
  if (light.isDraft) return "draft" as const;
  if (light.mergeable === "CONFLICTING") return "conflicts" as const;
  if (verdict.kind === "failed") return "checks_failed" as const;
  if (light.reviewDecision === "CHANGES_REQUESTED") return "changes_requested" as const;
  if (verdict.kind === "pending") return "checks_pending" as const;
  if (light.reviewDecision === "REVIEW_REQUIRED") return "review_requested" as const;
  return "ready_to_merge" as const;
}

const short = (repo: string) => repo.split("/")[1];

/** The CI watcher's line for a finished verdict. */
export function verdictText(light: PrLight, verdict: Extract<Verdict, { kind: "green" | "failed" }>): string {
  const where = `${short(light.repo)}#${light.number} (${light.headSha.slice(0, 7)})`;
  if (verdict.kind === "failed") {
    const still = verdict.pending > 0 ? ` ${verdict.pending} check${verdict.pending === 1 ? "" : "s"} still running; this is the first failure.` : "";
    return `❌ CI failed on ${where}: ${verdict.blocking.map((check) => (check.conclusion === "did not run" ? `${check.name} (required, never reported)` : check.name)).join(", ")}.${still}`;
  }
  const required = verdict.required.length > 0 ? ` required checks passed (${verdict.required.join(", ")});` : "";
  const optional = verdict.optionalFailed.length > 0 ? ` Optional checks failed (not required): ${verdict.optionalFailed.map((check) => check.name).join(", ")}.` : "";
  const running = verdict.pending > 0 ? ` ${verdict.pending} optional check${verdict.pending === 1 ? "" : "s"} still running.` : "";
  const passed = verdict.required.length > 0 ? `${verdict.passed} of ${verdict.total} checks passed` : `${verdict.passed} checks passed`;
  return `✅ CI is green on ${where}:${required} ${passed}.${optional}${running}`;
}
