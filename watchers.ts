// Event-driven wake-ups that replace the user (or the agent) polling:
//
// - Auto-continue: a thread that stops on "You've hit your session limit ·
//   resets 10pm" gets "continue" scheduled for just after the reset. The
//   scheduled message is cancelled if the thread resumes before then.
// - Release watcher: a thread that goes idle waiting for a release is woken
//   with "released" once a release PR merges into the base branch and its
//   workflow runs pass. Configured per project in local.config.json.
// - Run watcher: agents call `wait_for_run` for one GitHub Actions run (a deploy,
//   a release job) and end their turn; the CI check also polls these runs and
//   messages the thread once the run finishes, with the failed log.
// - CI watcher: agents call `wait_for_ci` instead of polling `gh` in loops; the
//   plugin polls once for everyone and messages the thread when checks finish,
//   reviews/comments arrive, or the PR merges. A thread that is still working
//   is left alone; its news arrives as one message once it goes idle.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseLimitHit } from "./limits";
import { GH_MISSING, ghError } from "./prs";
import { RELEASE_WAIT } from "./release-wait";
import { parseRunRef, runOutcome, type RunState } from "./runs";

export const releaseWatchSchema = z.object({
  /** owner/name; defaults to the project's GitHub remote. */
  repo: z.string().optional(),
  /** "pr": a merged PR into `base` whose title matches; "release": a published GitHub release. */
  mode: z.enum(["pr", "release"]).default("pr"),
  base: z.string().default("main"),
  /** Regex a merged PR title must match to count as a release. */
  titlePattern: z.string().default("^Release\\b"),
});
export type ReleaseWatchConfig = z.infer<typeof releaseWatchSchema>;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
/** The fields release tracking needs; satisfied by both threads.get and threads.list rows. */
type ThreadRef = Pick<Thread, "id" | "projectId" | "updatedAt">;

const CONTINUE_DELAY_MS = 90_000;
const RELEASE_BACKFILL_VERSION = 1;
const CI_TIMEOUT_MS = 3 * 3_600_000;
/** Deploys and nightly jobs run for hours; give up on a run after this. */
const RUN_TIMEOUT_MS = 12 * 3_600_000;
const NO_CHECKS_AFTER_MS = 10 * 60_000;
const OK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** Thread states where CI news would only pile up in the queue. */
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);
/** Deploy-preview and housekeeping bots: their comments are not review feedback. */
const BOT_LOGINS = new Set(["vercel", "github-actions", "dependabot", "linear", "changeset-bot", "codecov", "netlify", "sonarcloud"]);
const isBot = (login: string | undefined, body: string) =>
  login === undefined || login.endsWith("[bot]") || BOT_LOGINS.has(login) || /^\[vc\]:/.test(body);

type RunWatch = { threadId: string; repo: string; runId: number; label: string; since: number };
type AutoContinue = { resetsAt: number; queuedMessageId: string | null };
export type ThreadPrRef = { repo: string; state: string; mergedAt?: number | null };
type ReleaseWaiter = { threadId: string; projectName: string; since: number };
/** A release seen but not yet announced. `sha` is null for GitHub releases (nothing to wait for). */
type Pending = { prNumber: number | null; title: string; sha: string | null; mergedAt: number; projectName: string };
type Release = { key: string; prNumber: number | null; title: string; sha: string | null; at: number };
type CiWatch = {
  threadId: string;
  repo: string;
  pr: number;
  watchFor: "checks" | "reviews" | "both";
  since: number;
  /** Reviews/comments newer than this are reported; advances after each report. */
  reviewsSince?: number;
  headSha: string | null;
  /** "both" after its checks were reported: keep listening for reviews, end silently. */
  quiet?: boolean;
};

function ghPath(): string {
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
}

function gh(args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ghPath(), args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(ghError(`gh ${args.slice(0, 3).join(" ")}`, error, stderr, 500));
      else resolve(stdout);
    });
  });
}

/** "{}" for a failed lookup, but a missing gh is reported as such. */
function orEmpty(error: Error): string {
  if (error.message === GH_MISSING) throw error;
  return "{}";
}

function repoSlug(remote: string | null): string | null {
  const match = remote ? /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote) : null;
  return match ? match[1]! : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createWatchers(
  bb: BbPluginApi,
  releaseConfig: Record<string, ReleaseWatchConfig>,
  /** Per thread: its own switch in the thread monitor, else the plugin setting. */
  autoContinueEnabled: (threadId: string) => Promise<boolean>,
  changed: () => void,
  /** The PRs a thread created, for cross-repo release waits. */
  threadPrs: (threadId: string) => Promise<ThreadPrRef[]> = async () => [],
) {
  const kv = bb.storage.kv;
  const get = async <T>(key: string, fallback: T): Promise<T> => (await kv.get<T>(key)) ?? fallback;
  // Read-modify-write of one kv record, one at a time per key: a CI check runs
  // for tens of seconds and must not erase a watch registered meanwhile.
  const locks = new Map<string, Promise<unknown>>();
  function update<T>(key: string, fallback: T, apply: (value: T) => void): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(async () => {
      const value = await get<T>(key, fallback);
      apply(value);
      await kv.set(key, value);
      return value;
    });
    locks.set(key, run.catch(() => undefined));
    return run;
  }

  async function tell(threadId: string, text: string, sendAt?: number) {
    return bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
      ...(sendAt === undefined ? {} : { sendAt }),
    });
  }

  async function projectFor(thread: Pick<Thread, "projectId">) {
    const project = await bb.sdk.projects.get({ projectId: thread.projectId });
    return { name: project.name, slug: repoSlug(project.gitRemoteUrl) };
  }

  // --- auto-continue ---------------------------------------------------------

  async function onIdle(thread: Thread, text: string | null) {
    if (text === null || thread.parentThreadId !== null) return;
    const hit = parseLimitHit(text);
    if (hit !== null) {
      if (!(await autoContinueEnabled(thread.id))) return;
      const pending = await get<Record<string, AutoContinue>>("autoContinue", {});
      if (pending[thread.id]?.resetsAt === hit.resetsAt) return;
      const sendAt = hit.resetsAt + CONTINUE_DELAY_MS;
      const result = await tell(thread.id, "continue", sendAt);
      await update<Record<string, AutoContinue>>("autoContinue", {}, (all) => {
        all[thread.id] = {
          resetsAt: hit.resetsAt,
          queuedMessageId: result.delivery === "queued" ? result.queuedMessage.id : null,
        };
      });
      bb.log.info(`auto-continue ${thread.id} at ${new Date(sendAt).toISOString()}`);
      return;
    }
    if (RELEASE_WAIT.test(text.slice(-1500))) await registerReleaseWaiter(thread);
  }

  /** The user resumed the thread before the reset: drop our scheduled "continue". */
  async function onActive(thread: Thread) {
    await cancelAutoContinue(thread.id);
  }

  /** When the scheduled "continue" for this thread will be sent, if any. */
  async function autoContinueAt(threadId: string): Promise<number | null> {
    const entry = (await get<Record<string, AutoContinue>>("autoContinue", {}))[threadId];
    return entry ? entry.resetsAt + CONTINUE_DELAY_MS : null;
  }

  /** Drops a scheduled "continue" (the user resumed the thread, or switched it off). */
  async function cancelAutoContinue(threadId: string) {
    const thread = { id: threadId };
    const pending = await get<Record<string, AutoContinue>>("autoContinue", {});
    const entry = pending[thread.id];
    if (entry === undefined) return;
    await update<Record<string, AutoContinue>>("autoContinue", {}, (all) => {
      delete all[thread.id];
    });
    // Until it is actually sent (90s after the reset), it can still be taken back.
    if (entry.queuedMessageId !== null && Date.now() < entry.resetsAt + CONTINUE_DELAY_MS) {
      await bb.sdk.threads.queuedMessages
        .delete({ threadId: thread.id, queuedMessageId: entry.queuedMessageId })
        .catch(() => undefined);
    }
  }

  // --- release watcher -------------------------------------------------------

  const waiterKey = (threadId: string, projectName: string) => `${threadId}@${projectName}`;

  /**
   * Projects whose release this thread may be waiting for: its own, plus repos
   * where it has a PR that hasn't shipped yet (still open, or merged after that
   * project's latest release). Long-shipped PRs don't count.
   */
  async function releaseProjectsFor(thread: ThreadRef): Promise<string[]> {
    const own = (await projectFor(thread)).name;
    const prs = await threadPrs(thread.id);
    const names = new Set<string>();
    if (releaseConfig[own] !== undefined) names.add(own);
    for (const name of Object.keys(releaseConfig)) {
      if (names.has(name)) continue;
      const repo = await releaseRepo(name);
      const inRepo = prs.filter((pr) => pr.repo === repo);
      if (inRepo.length === 0) continue;
      if (inRepo.some((pr) => pr.state === "open" || pr.state === "draft")) {
        names.add(name);
        continue;
      }
      const latest = await latestRelease(name).catch(() => null);
      if (inRepo.some((pr) => pr.state === "merged" && (pr.mergedAt ?? 0) > (latest?.at ?? 0))) names.add(name);
    }
    return [...names];
  }

  /**
   * Registers the thread for the next release of each relevant project. A
   * release that already shipped after the thread said it was waiting is
   * reported straight away.
   */
  async function registerReleaseWaiter(thread: ThreadRef) {
    const names = await releaseProjectsFor(thread);
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const added: Record<string, ReleaseWaiter> = {};
    for (const name of names) {
      const key = waiterKey(thread.id, name);
      if (waiters[key] !== undefined) continue;
      const since = Math.min(Date.now(), thread.updatedAt);
      const latest = await latestRelease(name).catch(() => null);
      if (latest && latest.at > since + 60_000 && Date.now() - latest.at > 30 * 60_000) {
        await tell(thread.id, releasedMessage(name, latest, [])).catch(() => undefined);
        bb.log.info(`release ${latest.key}: caught up ${thread.id}`);
        continue;
      }
      added[key] = { threadId: thread.id, projectName: name, since };
      bb.log.info(`release waiter: ${thread.id} (${name})`);
    }
    if (Object.keys(added).length > 0) {
      await update<Record<string, ReleaseWaiter>>("releaseWaiters", {}, (all) => {
        for (const [key, waiter] of Object.entries(added)) all[key] ??= waiter;
      });
    }
    changed();
    return names;
  }

  async function releaseRepo(projectName: string): Promise<string | null> {
    const config = releaseConfig[projectName];
    if (config?.repo) return config.repo;
    const projects = await bb.sdk.projects.list();
    const project = projects.find((candidate) => candidate.name === projectName);
    return repoSlug(project?.gitRemoteUrl ?? null);
  }

  /** Recent releases of a project, newest first. */
  async function recentReleases(projectName: string): Promise<Release[]> {
    const config = releaseConfig[projectName];
    const repo = await releaseRepo(projectName);
    if (!config || !repo) return [];
    if (config.mode === "release") {
      const releases = JSON.parse(
        await gh(["release", "list", "-R", repo, "-L", "10", "--json", "tagName,name,publishedAt,isDraft"]),
      ) as Array<{ tagName: string; name: string; publishedAt: string; isDraft: boolean }>;
      return releases
        .filter((release) => !release.isDraft)
        .map((release) => ({ key: `${repo}@${release.tagName}`, prNumber: null, title: release.name || release.tagName, sha: null, at: Date.parse(release.publishedAt) }));
    }
    const merged = JSON.parse(
      await gh(["pr", "list", "-R", repo, "--base", config.base, "--state", "merged", "-L", "10", "--json", "number,title,mergedAt,mergeCommit"]),
    ) as Array<{ number: number; title: string; mergedAt: string; mergeCommit: { oid: string } | null }>;
    const pattern = new RegExp(config.titlePattern, "i");
    return merged
      .filter((pr) => pattern.test(pr.title))
      .map((pr) => ({ key: `${repo}#${pr.number}`, prNumber: pr.number, title: pr.title, sha: pr.mergeCommit?.oid ?? null, at: Date.parse(pr.mergedAt) }))
      .sort((a, b) => b.at - a.at);
  }

  async function latestRelease(projectName: string): Promise<Release | null> {
    return (await recentReleases(projectName))[0] ?? null;
  }

  function releasedMessage(projectName: string, release: Pick<Release, "title" | "prNumber" | "at">, runs: unknown[]) {
    const headline = `${release.title}${release.prNumber !== null ? ` (#${release.prNumber})` : ""} in ${projectName}, ${new Date(release.at).toLocaleString("en-GB")}`;
    return `released: ${headline}.${runs.length ? ` Its workflows passed (${runs.length} runs).` : ""} First confirm your changes are in it; if they aren't, say you're still waiting for a release and stop. Otherwise continue where you left off.`;
  }

  async function checkReleasesNow() {
    const waiters = Object.values(await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}));
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    const projects = new Set([...waiters.map((waiter) => waiter.projectName), ...Object.values(pending).map((p) => p.projectName)]);
    const seen = await get<Record<string, number>>("seenReleases", {});

    for (const projectName of projects) {
      const repo = await releaseRepo(projectName);
      if (!releaseConfig[projectName] || !repo) continue;
      // 1. New releases become pending until their workflows finish.
      const releases = await recentReleases(projectName).catch((error) => {
        bb.log.warn(`release-watch ${projectName}: ${String(error)}`);
        return null;
      });
      if (releases === null) continue;
      for (const release of releases) {
        if (seen[release.key] !== undefined || pending[release.key] !== undefined) continue;
        if (seen[repo] === undefined) {
          seen[release.key] = release.at; // first run: everything already released is history
          continue;
        }
        pending[release.key] = { prNumber: release.prNumber, title: release.title, sha: release.sha, mergedAt: release.at, projectName };
      }
      seen[repo] = Date.now();
    }

    // 2. Pending releases whose workflow runs completed wake their waiters.
    for (const [key, release] of Object.entries(pending)) {
      const repo = await releaseRepo(release.projectName);
      if (!repo) continue;
      const runList =
        release.sha === null
          ? "[]"
          : await gh(["run", "list", "-R", repo, "--commit", release.sha, "--json", "name,status,conclusion,url"]).catch((error) => {
              bb.log.warn(`release-watch ${key}: ${String(error)}`);
              return null;
            });
      if (runList === null) continue;
      const runs = JSON.parse(runList) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
        url: string;
      }>;
      const running = runs.filter((run) => run.status !== "completed");
      const stale = Date.now() - release.mergedAt > 2 * 3_600_000;
      if (running.length > 0 && !stale) continue;
      const failed = runs.filter((run) => run.conclusion && !["success", "skipped", "neutral"].includes(run.conclusion));
      const allWaiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
      const targets = Object.entries(allWaiters).filter(
        ([, waiter]) => waiter.projectName === release.projectName && waiter.since < release.mergedAt + 60_000,
      );
      const headline = `${release.title}${release.prNumber !== null ? ` (#${release.prNumber})` : ""}, ${new Date(release.mergedAt).toLocaleString("en-GB")}`;
      const message =
        failed.length === 0
          ? releasedMessage(release.projectName, { title: release.title, prNumber: release.prNumber, at: release.mergedAt }, runs)
          : `The release merged (${headline}), but ${failed.length} workflow run(s) failed: ${failed
              .map((run) => `${run.name} (${run.url})`)
              .join(", ")}. Check whether that affects you before continuing.`;
      for (const [waiterId, waiter] of targets) {
        const thread = await bb.sdk.threads.get({ threadId: waiter.threadId }).catch(() => null);
        if (thread && thread.archivedAt === null) {
          await tell(waiter.threadId, message).catch((error) => bb.log.warn(`release notify: ${String(error)}`));
        }
      }
      await update<Record<string, ReleaseWaiter>>("releaseWaiters", {}, (all) => {
        for (const [waiterId] of targets) delete all[waiterId];
      });
      seen[key] = release.mergedAt;
      delete pending[key];
      bb.log.info(`release ${key}: notified ${targets.length} thread(s)`);
    }
    await kv.set("pendingReleases", pending);
    await kv.set("seenReleases", seen);
    changed();
  }

  // --- CI / review watcher ---------------------------------------------------

  async function watchCi(
    threadId: string,
    options: { pr?: number; watchFor?: CiWatch["watchFor"]; repo?: string },
  ) {
    const thread = await bb.sdk.threads.get({ threadId });
    const slug = options.repo ?? (await projectFor(thread)).slug;
    if (!slug) throw new Error("This project has no GitHub remote.");
    let pr = options.pr;
    if (pr === undefined) {
      const environment = thread.environmentId
        ? await bb.sdk.environments.get({ environmentId: thread.environmentId })
        : null;
      if (!environment?.branchName) throw new Error("No PR number given and the thread has no branch.");
      const found = JSON.parse(
        await gh(["pr", "view", environment.branchName, "-R", slug, "--json", "number"]).catch(orEmpty),
      ) as { number?: number };
      if (found.number === undefined) throw new Error(`No open PR for branch ${environment.branchName}.`);
      pr = found.number;
    }
    // Refuse closed/merged PRs up front: a wrong repo guess (same number, other
    // repo) shows up here instead of as a bogus "merged" notice later.
    const current = JSON.parse(
      await gh(["pr", "view", String(pr), "-R", slug, "--json", "state,title,createdAt"]).catch(orEmpty),
    ) as { state?: string; title?: string; createdAt?: string };
    if (current.state === undefined) throw new Error(`${slug}#${pr} doesn't exist or isn't accessible. Pass repo explicitly.`);
    if (current.state !== "OPEN") {
      throw new Error(
        `${slug}#${pr} is already ${current.state.toLowerCase()} ("${current.title}", opened ${current.createdAt?.slice(0, 10)}). If you meant a PR in another repo, pass repo (owner/name).`,
      );
    }
    const key = `${threadId}:${slug}#${pr}`;
    const watch: CiWatch = { threadId, repo: slug, pr, watchFor: options.watchFor ?? "both", since: Date.now(), headSha: null };
    await update<Record<string, CiWatch>>("ciWatches", {}, (all) => {
      all[key] = watch;
    });
    changed();
    return watch;
  }

  type PrState = {
    state: string;
    headRefOid: string;
    url: string;
    statusCheckRollup: Array<{
      __typename: string;
      name?: string;
      context?: string;
      status?: string;
      conclusion?: string | null;
      state?: string;
      detailsUrl?: string;
      targetUrl?: string;
    }>;
    reviews: Array<{ author: { login: string } | null; state: string; body: string; submittedAt: string }>;
    comments: Array<{ author: { login: string } | null; body: string; createdAt: string }>;
  };

  async function failedLog(detailsUrl: string | undefined, repo: string): Promise<string> {
    const runId = detailsUrl ? /\/actions\/runs\/(\d+)/.exec(detailsUrl)?.[1] : undefined;
    if (!runId) return "";
    const log = await gh(["run", "view", runId, "-R", repo, "--log-failed"], 60_000).catch(() => "");
    const lines = log.trim().split("\n").slice(-60).map((line) => line.replace(/^[^\t]*\t[^\t]*\t/, ""));
    return lines.length > 1 ? `\n\`\`\`\n${truncate(lines.join("\n"), 4000)}\n\`\`\`` : "";
  }

  async function checkCiNow() {
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    // One message per thread per cycle, however many of its PRs have news.
    const outbox = new Map<string, { notes: string[]; stillWatching: boolean }>();
    // Applied to a fresh read at the end, so watches added during the check survive.
    const removed = new Set<string>();
    // A working agent checks its PRs itself (pr_status). Its watches stay as
    // they are until it goes idle; the first idle cycle then reports the
    // current checks and every review since the last report, in one message.
    const busy = new Map<string, boolean>();
    let me: string | null = null;
    for (const [key, watch] of Object.entries(watches)) {
      if (!busy.has(watch.threadId)) {
        const thread = await bb.sdk.threads.get({ threadId: watch.threadId }).catch(() => null);
        busy.set(watch.threadId, thread !== null && BUSY_STATUSES.has(thread.status));
      }
      if (busy.get(watch.threadId)) continue;
      let pr: PrState;
      try {
        pr = JSON.parse(
          await gh(["pr", "view", String(watch.pr), "-R", watch.repo, "--json", "state,headRefOid,url,statusCheckRollup,reviews,comments"]),
        ) as PrState;
      } catch (error) {
        // gh missing, logged out or the PR gone: give up after the usual timeout
        // instead of warning every cycle forever.
        if (Date.now() - watch.since > CI_TIMEOUT_MS) {
          delete watches[key];
          removed.add(key);
          bb.log.warn(`ci ${key}: dropped after repeated errors: ${String(error)}`);
        } else {
          bb.log.warn(`ci ${key}: ${String(error)}`);
        }
        continue;
      }
      me ??= (await gh(["api", "user", "-q", ".login"]).catch(() => "")).trim();
      const notes: string[] = [];
      let done = false;
      let checksReported = false;

      if (pr.state !== "OPEN") {
        notes.push(`PR ${watch.repo.split("/")[1]}#${watch.pr} is now ${pr.state.toLowerCase()}.`);
        done = true;
      }
      // A new push restarts the checks; keep waiting on the new head.
      if (watch.headSha !== null && watch.headSha !== pr.headRefOid) watch.since = Date.now();
      watch.headSha = pr.headRefOid;

      if (!done && watch.watchFor !== "reviews") {
        const checks = pr.statusCheckRollup.map((check) => ({
          name: check.name ?? check.context ?? "check",
          pending: check.__typename === "CheckRun" ? check.status !== "COMPLETED" : check.state === "PENDING" || check.state === "EXPECTED",
          ok: check.__typename === "CheckRun" ? OK_CONCLUSIONS.has(check.conclusion ?? "") : check.state === "SUCCESS",
          url: check.detailsUrl ?? check.targetUrl,
        }));
        if (checks.length > 0 && checks.every((check) => !check.pending)) {
          const failed = checks.filter((check) => !check.ok);
          if (failed.length === 0) {
            notes.push(`✅ CI is green on ${watch.repo.split("/")[1]}#${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${checks.length} checks passed.`);
          } else {
            const log = await failedLog(failed[0]!.url, watch.repo);
            notes.push(
              `❌ CI failed on ${watch.repo.split("/")[1]}#${watch.pr} (${pr.headRefOid.slice(0, 7)}): ${failed.map((check) => check.name).join(", ")}.${log}`,
            );
          }
          // "both" keeps listening for reviews (review bots often answer after CI).
          if (watch.watchFor === "both") {
            watch.watchFor = "reviews";
            watch.quiet = true;
            checksReported = true;
          } else done = true;
        } else if (checks.length === 0 && Date.now() - watch.since > NO_CHECKS_AFTER_MS) {
          notes.push(`${watch.repo.split("/")[1]}#${watch.pr} has no CI checks after 10 minutes; nothing to wait for.`);
          if (watch.watchFor === "both") {
            watch.watchFor = "reviews";
            watch.quiet = true;
            checksReported = true;
          } else done = true;
        }
      }

      let reviewNews = false;
      if (watch.watchFor !== "checks") {
        const cutoff = watch.reviewsSince ?? watch.since;
        const human = (author: { login: string } | null, body: string) => author?.login !== me && !isBot(author?.login, body);
        const reviews = pr.reviews.filter((review) => Date.parse(review.submittedAt) > cutoff && human(review.author, review.body));
        const comments = pr.comments.filter((comment) => Date.parse(comment.createdAt) > cutoff && human(comment.author, comment.body));
        for (const review of reviews) {
          notes.push(`Review from ${review.author?.login ?? "someone"}: ${review.state}${review.body ? ` — ${truncate(review.body, 800)}` : ""}`);
        }
        for (const comment of comments) {
          notes.push(`Comment from ${comment.author?.login ?? "someone"}: ${truncate(comment.body, 800)}`);
        }
        if (reviews.length + comments.length > 0) {
          reviewNews = true;
          notes.push(`Full comments: \`gh pr view ${watch.pr} -R ${watch.repo} --comments\`; inline: \`gh api repos/${watch.repo}/pulls/${watch.pr}/comments\``);
          // Reviews only: done. Both: report now, keep watching the checks.
          if (watch.watchFor === "reviews") done = true;
        }
      }

      if (!done && Date.now() - watch.since > CI_TIMEOUT_MS) {
        // A quiet review watch already told the agent about its checks.
        if (!watch.quiet) notes.push(`Still waiting on ${watch.repo.split("/")[1]}#${watch.pr} after 3 hours; stopped watching. ${pr.url}`);
        done = true;
      }

      if (done || reviewNews || checksReported) {
        const entry = outbox.get(watch.threadId) ?? { notes: [], stillWatching: false };
        entry.notes.push(...notes);
        if (!done) entry.stillWatching = true;
        if (notes.length === 0) {
          delete watches[key];
          removed.add(key);
          continue;
        }
        outbox.set(watch.threadId, entry);
        if (done) {
          delete watches[key];
          removed.add(key);
        } else watch.reviewsSince = Date.now();
      }
    }
    for (const [threadId, entry] of outbox) {
      const others = Object.values(watches).filter((watch) => watch.threadId === threadId).length;
      const suffix =
        entry.stillWatching || others > 0
          ? `\n\n(Still watching ${others} PR${others === 1 ? "" : "s"}; you'll get another message when there's news.)`
          : "";
      await tell(threadId, `[ci watcher] ${entry.notes.join("\n\n")}${suffix}`).catch((error) =>
        bb.log.warn(`ci notify: ${String(error)}`),
      );
    }
    await update<Record<string, CiWatch>>("ciWatches", {}, (all) => {
      for (const key of removed) delete all[key];
      for (const [key, watch] of Object.entries(watches)) {
        const current = all[key];
        if (current) Object.assign(current, { since: watch.since, headSha: watch.headSha, reviewsSince: watch.reviewsSince, watchFor: watch.watchFor, quiet: watch.quiet });
      }
    });
    changed();
  }

  // --- run watcher -------------------------------------------------------------

  async function watchRun(threadId: string, run: string | number, repo?: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    const ref = parseRunRef(repo && /^\d+$/.test(String(run).trim()) ? `${repo}#${run}` : run, (await projectFor(thread)).slug);
    const current = JSON.parse(
      await gh(["run", "view", String(ref.runId), "-R", ref.repo, "--json", "status,conclusion,name,displayTitle,url"]).catch(orEmpty),
    ) as Partial<RunState>;
    if (current.status === undefined) throw new Error(`Run ${ref.runId} in ${ref.repo} doesn't exist or isn't accessible.`);
    if (current.status === "completed") {
      throw new Error(`That run already finished: ${current.conclusion} (${current.url}). Nothing to wait for.`);
    }
    const watch: RunWatch = { threadId, repo: ref.repo, runId: ref.runId, label: current.name ?? "run", since: Date.now() };
    await update<Record<string, RunWatch>>("runWatches", {}, (all) => {
      all[`${threadId}:${ref.repo}/runs/${ref.runId}`] = watch;
    });
    changed();
    return watch;
  }

  async function checkRunsNow() {
    const watches = await get<Record<string, RunWatch>>("runWatches", {});
    const removed = new Set<string>();
    for (const [key, watch] of Object.entries(watches)) {
      // News for a working agent would only pile up; it gets one message when idle.
      const thread = await bb.sdk.threads.get({ threadId: watch.threadId }).catch(() => null);
      if (thread !== null && BUSY_STATUSES.has(thread.status)) continue;
      let text: string | null = null;
      try {
        const run = JSON.parse(
          await gh(["run", "view", String(watch.runId), "-R", watch.repo, "--json", "status,conclusion,name,displayTitle,url,jobs"]),
        ) as RunState;
        const outcome = runOutcome(run, watch.repo);
        if (outcome) {
          text = outcome.text + (outcome.failed ? await failedLog(run.url, watch.repo) : "");
        } else if (Date.now() - watch.since > RUN_TIMEOUT_MS) {
          text = `${watch.label} in ${watch.repo.split("/")[1]} is still ${run.status} after 12 hours; stopped watching. ${run.url}`;
        }
      } catch (error) {
        if (Date.now() - watch.since <= RUN_TIMEOUT_MS) {
          bb.log.warn(`run ${key}: ${String(error)}`);
          continue;
        }
        text = `Stopped watching run ${watch.runId} in ${watch.repo}: ${String(error)}`;
      }
      if (text === null) continue;
      removed.add(key);
      if (thread !== null && thread.archivedAt === null) {
        await tell(watch.threadId, `[run watcher] ${text}`).catch((error) => bb.log.warn(`run notify: ${String(error)}`));
      }
    }
    if (removed.size === 0) return;
    await update<Record<string, RunWatch>>("runWatches", {}, (all) => {
      for (const key of removed) delete all[key];
    });
    changed();
  }

  // --- wiring ----------------------------------------------------------------

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => onIdle(thread, lastAssistantText));
  bb.events.on("thread.active", ({ thread }) => onActive(thread));
  bb.events.on("thread.archived", async ({ thread }) => {
    await update<Record<string, AutoContinue>>("autoContinue", {}, (all) => {
      delete all[thread.id];
    });
    // Release waiters are keyed thread@project; one thread can wait on several.
    await update<Record<string, ReleaseWaiter>>("releaseWaiters", {}, (all) => {
      for (const key of Object.keys(all)) if (all[key]!.threadId === thread.id) delete all[key];
    });
    await update<Record<string, CiWatch>>("ciWatches", {}, (all) => {
      for (const key of Object.keys(all)) if (all[key]!.threadId === thread.id) delete all[key];
    });
    await update<Record<string, RunWatch>>("runWatches", {}, (all) => {
      for (const key of Object.keys(all)) if (all[key]!.threadId === thread.id) delete all[key];
    });
    changed();
  });

  // Register threads that were already waiting before these rules existed. Bump
  // the version when RELEASE_WAIT or the config changes.
  bb.background.service("release-backfill", {
    async start(signal) {
      // Waiters used to be keyed by thread id alone; move them to thread@project.
      const stored = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
      const legacy = Object.keys(stored).filter((key) => !key.includes("@"));
      if (legacy.length > 0) {
        for (const key of legacy) {
          const waiter = stored[key]!;
          stored[waiterKey(waiter.threadId, waiter.projectName)] ??= waiter;
          delete stored[key];
        }
        await kv.set("releaseWaiters", stored);
      }
      if ((await get<number>("releaseBackfill", 0)) !== RELEASE_BACKFILL_VERSION) {
        const threads = await bb.sdk.threads.list({ limit: 500 });
        for (const thread of threads) {
          if (signal.aborted) return;
          if (thread.archivedAt !== null || thread.status !== "idle" || thread.parentThreadId !== null) continue;
          const output = await bb.sdk.threads.output({ threadId: thread.id, signal }).catch(() => null);
          const tail = (output?.output ?? "").slice(-1500);
          if (RELEASE_WAIT.test(tail)) await registerReleaseWaiter(thread).catch((error) => bb.log.warn(`release backfill ${thread.id}: ${String(error)}`));
        }
        if (!signal.aborted) await kv.set("releaseBackfill", RELEASE_BACKFILL_VERSION);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  // Single flight: the schedules and `check-now` share one run, so a thread
  // never gets the same "CI is green" twice.
  let releaseRun: Promise<void> | null = null;
  const checkReleases = () => (releaseRun ??= checkReleasesNow().finally(() => (releaseRun = null)));
  let ciRun: Promise<void> | null = null;
  const checkCi = () => (ciRun ??= checkCiNow().finally(() => (ciRun = null)));

  bb.background.schedule("release-watch", "*/3 * * * *", async () => {
    if (releaseRun !== null || Object.keys(releaseConfig).length === 0) return;
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    if (Object.keys(waiters).length + Object.keys(pending).length === 0) return;
    await checkReleases();
  });
  bb.background.schedule("ci-watch", "*/2 * * * *", async () => {
    if (ciRun !== null || Object.keys(await get<Record<string, CiWatch>>("ciWatches", {})).length === 0) return;
    await checkCi();
  });
  let runRun: Promise<void> | null = null;
  const checkRuns = () => (runRun ??= checkRunsNow().finally(() => (runRun = null)));
  bb.background.schedule("run-watch", "*/2 * * * *", async () => {
    if (runRun !== null || Object.keys(await get<Record<string, RunWatch>>("runWatches", {})).length === 0) return;
    await checkRuns();
  });

  async function status() {
    return {
      autoContinue: await get<Record<string, AutoContinue>>("autoContinue", {}),
      releaseWaiters: await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}),
      pendingReleases: await get<Record<string, Pending>>("pendingReleases", {}),
      ciWatches: await get<Record<string, CiWatch>>("ciWatches", {}),
      runWatches: await get<Record<string, RunWatch>>("runWatches", {}),
    };
  }

  /** What will message this thread on its own: CI/review watches and release waits. */
  async function wakeupsFor(threadId: string): Promise<Array<{ kind: "ci" | "release"; key: string; label: string }>> {
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    const runs = await get<Record<string, RunWatch>>("runWatches", {});
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const what = { checks: "checks", reviews: "reviews", both: "checks and reviews" } as const;
    return [
      ...Object.entries(runs)
        .filter(([, watch]) => watch.threadId === threadId)
        .map(([key, watch]) => ({ kind: "ci" as const, key, label: `${watch.repo.split("/")[1]} · ${watch.label}` })),
      ...Object.entries(watches)
        .filter(([, watch]) => watch.threadId === threadId)
        .map(([key, watch]) => ({
          kind: "ci" as const,
          key,
          label: `${watch.repo.split("/")[1]}#${watch.pr} ${watch.quiet ? "reviews" : what[watch.watchFor]}`,
        })),
      ...Object.entries(waiters)
        .filter(([, waiter]) => waiter.threadId === threadId)
        .map(([key, waiter]) => ({ kind: "release" as const, key, label: `next ${waiter.projectName} release` })),
    ];
  }

  /** Stops one watch or release wait for a thread. */
  async function cancelWakeup(threadId: string, kind: "ci" | "release", key: string) {
    if (kind === "ci") {
      await update<Record<string, CiWatch>>("ciWatches", {}, (all) => {
        if (all[key]?.threadId === threadId) delete all[key];
      });
      await update<Record<string, RunWatch>>("runWatches", {}, (all) => {
        if (all[key]?.threadId === threadId) delete all[key];
      });
    } else {
      await update<Record<string, ReleaseWaiter>>("releaseWaiters", {}, (all) => {
        if (all[key]?.threadId === threadId) delete all[key];
      });
    }
    changed();
  }

  return { watchCi, watchRun, checkRuns, registerReleaseWaiter, checkReleases, checkCi, status, autoContinueAt, cancelAutoContinue, wakeupsFor, cancelWakeup, RELEASE_WAIT };
}
