// The only module that talks to GitHub. Every read goes through `gh` (the
// user's own login) and through the quota guard below, so the plugin never
// spends the last of the user's hourly budget, and never retries a request
// GitHub refused for rate limits. `github.test.ts` fails if another file
// starts `gh`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const GH_MISSING = "The GitHub CLI (gh) isn't installed or isn't on PATH. Install it and run `gh auth login`.";

/** Below this many points left on any GitHub counter, the plugin stops reading. */
export const QUOTA_FLOOR = 1000;
/** A rate-limit refusal without a known reset pauses at least this long. */
const MIN_PAUSE_MS = 60_000;
const RATE_LIMITED = /rate limit|secondary rate|abuse detection/i;

export class RateLimitedError extends Error {}

/** A readable gh failure; a missing binary gets setup instructions instead of "spawn gh ENOENT". */
export function ghError(prefix: string, error: Error & { code?: string | number | null }, stderr: string, max: number): Error {
  if (error.code === "ENOENT") return new Error(GH_MISSING);
  const text = `${prefix}: ${stderr || error.message}`.slice(0, max);
  return RATE_LIMITED.test(text) ? new RateLimitedError(text) : new Error(text);
}

// --- quota ---------------------------------------------------------------------

export type QuotaReading = { remaining: number; resetAt: number; at: number };
export type QuotaState = { paused: false } | { paused: true; resumesAt: number; reason: string };

/**
 * GitHub answers `rateLimit` from more than one counter for the same user:
 * two calls a second apart can report different `used` and `resetAt`. Each
 * distinct resetAt is therefore tracked as its own counter, and the guard
 * looks at the lowest `remaining` among counters that have not reset yet.
 * `remaining` only falls until its reset, so an older reading can only be
 * too generous, never pause without cause.
 */
export function createQuota(now: () => number = Date.now) {
  const counters = new Map<number, QuotaReading>();
  let refusedUntil: number | null = null;
  let refusedReason = "";

  function prune() {
    for (const [resetAt] of counters) if (resetAt <= now()) counters.delete(resetAt);
    if (refusedUntil !== null && refusedUntil <= now()) refusedUntil = null;
  }

  return {
    record(remaining: number, resetAt: number) {
      if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return;
      const key = Math.round(resetAt / 1000) * 1000;
      const known = counters.get(key);
      if (known === undefined || remaining <= known.remaining) counters.set(key, { remaining, resetAt: key, at: now() });
    },
    /** GitHub refused a request for rate limits: stop until the latest known reset (never sooner than a minute). */
    refused(reason: string, resets: number[]) {
      const until = Math.max(now() + MIN_PAUSE_MS, ...resets.filter((at) => at > now()), ...[...counters.keys()].filter((at) => at > now()));
      refusedUntil = Math.max(refusedUntil ?? 0, until);
      refusedReason = reason;
    },
    state(): QuotaState {
      prune();
      const low = [...counters.values()].filter((reading) => reading.remaining < QUOTA_FLOOR).sort((a, b) => b.resetAt - a.resetAt)[0];
      const candidates: Array<{ resumesAt: number; reason: string }> = [];
      if (low) candidates.push({ resumesAt: low.resetAt, reason: `${low.remaining} GitHub points left` });
      if (refusedUntil !== null) candidates.push({ resumesAt: refusedUntil, reason: refusedReason });
      if (candidates.length === 0) return { paused: false };
      const latest = candidates.sort((a, b) => b.resumesAt - a.resumesAt)[0]!;
      return { paused: true, ...latest };
    },
    readings(): QuotaReading[] {
      prune();
      return [...counters.values()];
    },
  };
}
export type Quota = ReturnType<typeof createQuota>;

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** The words every paused watch and list shows. */
export function pausedText(state: QuotaState): string | null {
  return state.paused ? `Paused: GitHub quota low, resumes ${clock(state.resumesAt)}` : null;
}

// --- gh --------------------------------------------------------------------------

const ghPath = () => ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";

export type Runner = (args: string[], timeout: number) => Promise<{ stdout: string; stderr: string; error: (Error & { code?: string | number | null }) | null }>;

const execRunner: Runner = (args, timeout) =>
  new Promise((resolve) => {
    execFile(ghPath(), args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ stdout, stderr, error }));
  });

export class QuotaPausedError extends Error {}

export function createGitHub(quota: Quota = createQuota(), runner: Runner = execRunner) {
  function guard(what: string) {
    const state = quota.state();
    if (state.paused) throw new QuotaPausedError(`${pausedText(state)} (${what} not read).`);
  }

  async function onRateLimited(error: Error) {
    // GET /rate_limit is free; its graphql/core resets are among the counters to wait for.
    const reply = await runner(["api", "rate_limit", "--jq", "[.resources.core.reset, .resources.graphql.reset]"], 15_000).catch(() => null);
    let resets: number[] = [];
    try {
      resets = (JSON.parse(reply?.stdout ?? "[]") as number[]).map((seconds) => seconds * 1000);
    } catch {
      resets = [];
    }
    quota.refused(error.message.slice(0, 200), resets);
  }

  /** Runs gh once. A rate-limit refusal pauses every reader; it is never retried. */
  async function gh(args: string[], what: string, timeout = 60_000): Promise<string> {
    guard(what);
    const { stdout, stderr, error } = await runner(args, timeout);
    if (!error) return stdout;
    const failure = ghError(`gh ${args.slice(0, 3).join(" ")}`, error, stderr, 500);
    if (failure instanceof RateLimitedError) await onRateLimited(failure);
    throw Object.assign(failure, { stdout });
  }

  /**
   * One GraphQL query. GitHub answers a query with one unresolvable part (a
   * deleted PR or repo) with an error and data for every other part; gh then
   * exits non-zero. That partial data is kept. Every query should ask for
   * `rateLimit { remaining resetAt }`; the reading feeds the guard.
   */
  async function graphql<T>(query: string, what: string, timeout = 60_000): Promise<{ data: T; errors: string[] }> {
    guard(what);
    const { stdout, stderr, error } = await runner(["api", "graphql", "-f", `query=${query}`], timeout);
    type Reply = { data?: T | null; errors?: Array<{ message?: string }> };
    const parsed = ((): Reply | null => {
      try {
        return JSON.parse(stdout) as Reply;
      } catch {
        return null;
      }
    })();
    const errors = (parsed?.errors ?? []).map((entry) => entry.message ?? "unknown error");
    const limit = (parsed?.data as { rateLimit?: { remaining?: number; resetAt?: string } } | null | undefined)?.rateLimit;
    if (limit?.remaining !== undefined && limit.resetAt) quota.record(limit.remaining, Date.parse(limit.resetAt));
    const refusal = [...errors, stderr].find((text) => RATE_LIMITED.test(text));
    if (refusal !== undefined) {
      const failure = new RateLimitedError(`gh graphql: ${refusal}`.slice(0, 300));
      await onRateLimited(failure);
      throw failure;
    }
    if (parsed?.data) return { data: parsed.data, errors };
    throw error ? ghError("gh graphql", error, stderr, 400) : new Error(`gh graphql: ${errors[0] ?? "no data"}`);
  }

  const restJson = async <T>(path: string, what: string): Promise<T> => JSON.parse(await gh(["api", path], what)) as T;

  return { quota, gh, graphql, restJson };
}
export type GitHub = ReturnType<typeof createGitHub>;

// --- reads used outside the hub ----------------------------------------------------
// One function per question, so no other file builds gh commands.

const RATE = "rateLimit { remaining resetAt }";
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const repoArgs = (repo: string) => {
  const [owner, name] = repo.split("/");
  return `owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}`;
};

export function createReads(github: GitHub) {
  const { gh, graphql, restJson } = github;
  return {
    /**
     * The PR of a branch: the newest open one, else the newest in any state
     * (so a merged branch says "already merged"); null when it never had one.
     */
    async prForBranch(repo: string, branch: string): Promise<{ number: number; state: string } | null> {
      type Nodes = { nodes: Array<{ number: number; state: string }> };
      const head = `headRefName: ${JSON.stringify(branch)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}`;
      const { data } = await graphql<{ repository: { open: Nodes; any: Nodes } | null }>(
        `query { ${RATE} repository(${repoArgs(repo)}) { open: pullRequests(${head}, states: OPEN) { nodes { number state } } any: pullRequests(${head}) { nodes { number state } } } }`,
        `the PR of ${branch}`,
      );
      return data.repository?.open.nodes[0] ?? data.repository?.any.nodes[0] ?? null;
    },
    /** State, title and age of one PR; null when it doesn't exist or isn't readable. */
    async prSummary(repo: string, pr: number): Promise<{ state: string; title: string; createdAt: string } | null> {
      const { data } = await graphql<{ repository: { pullRequest: { state: string; title: string; createdAt: string } | null } | null }>(
        `query { ${RATE} repository(${repoArgs(repo)}) { pullRequest(number: ${pr}) { state title createdAt } } }`,
        `${repo}#${pr}`,
      ).catch((error: Error) => {
        if (error instanceof RateLimitedError || error instanceof QuotaPausedError || error.message === GH_MISSING) throw error;
        return { data: { repository: null } };
      });
      return data.repository?.pullRequest ?? null;
    },
    /** One Actions run's status and titles; null when it doesn't exist or isn't readable. */
    async runSummary(repo: string, runId: number): Promise<{ status: string; conclusion: string | null; name: string; displayTitle?: string; url: string } | null> {
      const text = await gh(["run", "view", String(runId), "-R", repo, "--json", "status,conclusion,name,displayTitle,url"], `run ${runId}`).catch((error: Error) => {
        if (error instanceof RateLimitedError || error instanceof QuotaPausedError || error.message === GH_MISSING) throw error;
        return "{}";
      });
      const run = JSON.parse(text) as { status?: string; conclusion?: string | null; name?: string; displayTitle?: string; url?: string };
      return run.status === undefined ? null : { status: run.status, conclusion: run.conclusion ?? null, name: run.name ?? "run", displayTitle: run.displayTitle, url: run.url ?? "" };
    },
    /** The last 60 lines of a run's failed jobs, as a fenced block ("" when there is nothing to show). */
    /**
     * The end of a failed job's log (up to its last error), or of a finished
     * run's failed jobs, as a fenced block. A job's log is read through the
     * REST job-log endpoint, which answers as soon as the job finished, while
     * the rest of its run still goes (`gh run view --job --log-failed` refuses
     * until the whole run completes; checked live on 11 Nov 2026). When there
     * is no log, says why instead.
     */
    async failedLog(repo: string, target: { runId: number; jobId?: number | null }): Promise<string> {
      let lines: string[];
      try {
        if (target.jobId) {
          const log = await gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${target.jobId}/logs`], `the log of job ${target.jobId}`);
          lines = log.split("\n").map((line) => line.replace(ANSI, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
          let end = lines.length;
          while (end > 0 && !lines[end - 1]!.startsWith("##[error]")) end -= 1;
          if (end > 0) lines = lines.slice(0, end); // the post-job cleanup after the failure says nothing
        } else {
          const log = await gh(["run", "view", String(target.runId), "-R", repo, "--log-failed"], `the log of run ${target.runId}`);
          lines = log.split("\n").map((line) => line.replace(/^[^\t]*\t[^\t]*\t/, ""));
        }
      } catch (error) {
        return `\n(Log not available: ${String((error as Error).message).split("\n")[0]!.slice(0, 200)})`;
      }
      while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
      if (lines.length === 0) return "\n(Log not available: GitHub returned an empty log.)";
      const text = lines.slice(-60).join("\n");
      return `\n\`\`\`\n${text.length > 4000 ? `…${text.slice(-4000)}` : text}\n\`\`\``;
    },
    /** Check names a branch requires before merging (rulesets and classic protection); null when GitHub won't say. */
    async requiredChecks(repo: string, branch: string): Promise<string[] | null> {
      // Both sources must answer: a failed rules read next to "no classic
      // protection" would otherwise look like "nothing required".
      const names = new Set<string>();
      const rules = await restJson<Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }>>(
        `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
        `the rules of ${repo}:${branch}`,
      ).catch((error: Error) => {
        if (error instanceof RateLimitedError || error instanceof QuotaPausedError) throw error;
        return null;
      });
      if (rules === null) return null;
      for (const rule of rules) if (rule.type === "required_status_checks") for (const check of rule.parameters?.required_status_checks ?? []) names.add(check.context);
      let unprotected = false;
      const classic = await restJson<{ contexts?: string[]; checks?: Array<{ context: string }> }>(
        `repos/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
        `the protection of ${repo}:${branch}`,
      ).catch((error: Error) => {
        if (error instanceof RateLimitedError || error instanceof QuotaPausedError) throw error;
        // 404 ("Branch not protected", "Required status checks not enabled") is an answer: nothing required there.
        if (/\b404\b|not protected|not enabled/i.test(error.message)) unprotected = true;
        return null;
      });
      if (classic === null && !unprotected) return null;
      for (const context of classic?.contexts ?? []) names.add(context);
      for (const check of classic?.checks ?? []) names.add(check.context);
      return [...names].sort();
    },
    /** Merged PRs into a base, newest first (release watcher). */
    async mergedPrs(repo: string, base: string, limit: number): Promise<Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null }>> {
      const { data } = await graphql<{ repository: { pullRequests: { nodes: Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null }> } } | null }>(
        `query { ${RATE} repository(${repoArgs(repo)}) { pullRequests(baseRefName: ${JSON.stringify(base)}, states: MERGED, first: ${limit}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title mergedAt mergeCommit { oid } } } } }`,
        `merged PRs in ${repo}`,
      );
      return data.repository?.pullRequests.nodes ?? [];
    },
    /** Published releases, newest first (release watcher). */
    async releases(repo: string, limit: number): Promise<Array<{ tagName: string; name: string; publishedAt: string; isDraft: boolean }>> {
      return JSON.parse(await gh(["release", "list", "-R", repo, "-L", String(limit), "--json", "tagName,name,publishedAt,isDraft"], `releases of ${repo}`));
    },
    /** Workflow runs for one commit (release watcher). */
    async runsForCommit(repo: string, sha: string): Promise<Array<{ name: string; status: string; conclusion: string | null; url: string }>> {
      return JSON.parse(await gh(["run", "list", "-R", repo, "--commit", sha, "--json", "name,status,conclusion,url"], `runs of ${sha.slice(0, 7)}`));
    },
    /** PRs that contain a commit (git-clean). */
    async pullsForCommit(repo: string, sha: string): Promise<unknown> {
      return JSON.parse(await gh(["api", `repos/${repo}/commits/${sha}/pulls`], `PRs of ${sha.slice(0, 7)}`, 20_000));
    },
    /** A REST read for the unreleased page (repo, branches, releases, tags, compare, commits). */
    rest: <T>(path: string) => restJson<T>(path, path.split("?")[0]!),
    /** PR titles and merge times for the unreleased page, 100 per query. */
    async prDetails(repo: string, numbers: number[]): Promise<Array<{ number: number; title: string; url: string; mergedAt: string | null; author: { login: string } | null }>> {
      type Pr = { number: number; title: string; url: string; mergedAt: string | null; author: { login: string } | null };
      const out: Pr[] = [];
      for (let i = 0; i < numbers.length; i += 100) {
        const fields = numbers
          .slice(i, i + 100)
          .map((n) => `p${n}: pullRequest(number: ${n}) { number title url mergedAt author { login } }`)
          .join("\n");
        // An issue number in a commit subject ("(#123)") resolves to null with an error; the PRs around it still come back.
        const { data } = await graphql<{ repository?: Record<string, Pr | null> }>(`query { ${RATE} repository(${repoArgs(repo)}) { ${fields} } }`, `PRs of ${repo}`);
        out.push(...Object.values(data.repository ?? {}).filter((pr): pr is Pr => pr !== null));
      }
      return out;
    },
  };
}
export type Reads = ReturnType<typeof createReads>;
