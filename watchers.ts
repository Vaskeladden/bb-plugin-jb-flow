// Event-driven wake-ups that replace the user (or the agent) polling:
//
// - Auto-continue: a thread that stops on "You've hit your session limit ·
//   resets 10pm" gets "continue" scheduled for just after the reset. The
//   scheduled message is cancelled if the thread resumes before then.
// - Release watcher: a thread that goes idle waiting for a release is woken
//   with "released" once a release PR merges into the base branch and its
//   workflow runs pass. Configured per project in local.config.json.
// - Run watcher: agents call `wait_for_run` for one GitHub Actions run (a deploy,
//   a release job) and end their turn; the GitHub hub reads the run with
//   everything else and the thread is messaged once it finishes, with the failed log.
// - CI watcher: agents call `wait_for_ci` instead of polling `gh` in loops; the
//   hub (pr-hub.ts) reads every watched PR in one shared query and the thread
//   is messaged when its required checks pass, a check that blocks the merge
//   fails, reviews/comments arrive, or the PR merges. A thread that is still
//   working is left alone; its news arrives as one message once it goes idle.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CI_TIMEOUT_MS, runIdOf, stepCiWatch, type CiWatch } from "./ci-watch";
import { GH_MISSING, pausedText, QuotaPausedError, type Reads } from "./github";
import type { LightItem, RunItem } from "./hub-model";
import { parseLimitHit } from "./limits";
import type { Hub, HubView } from "./pr-hub";
import { RELEASE_WAIT } from "./release-wait";
import { parseRunRef, runOutcome } from "./runs";

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
/** Deploys and nightly jobs run for hours; give up on a run after this. */
const RUN_TIMEOUT_MS = 12 * 3_600_000;
/** Thread states where CI news would only pile up in the queue. */
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

type RunWatch = { threadId: string; repo: string; runId: number; label: string; displayTitle?: string; since: number };
type AutoContinue = { resetsAt: number; queuedMessageId: string | null };
export type ThreadPrRef = { repo: string; state: string; mergedAt?: number | null };
type ReleaseWaiter = { threadId: string; projectName: string; since: number };
/** A release seen but not yet announced. `sha` is null for GitHub releases (nothing to wait for). */
type Pending = { prNumber: number | null; title: string; sha: string | null; mergedAt: number; projectName: string };
type Release = { key: string; prNumber: number | null; title: string; sha: string | null; at: number };

function repoSlug(remote: string | null): string | null {
  const match = remote ? /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(remote) : null;
  return match ? match[1]! : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createWatchers(
  bb: BbPluginApi,
  reads: Reads,
  hub: Hub,
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
      const releases = await reads.releases(repo, 10);
      return releases
        .filter((release) => !release.isDraft)
        .map((release) => ({ key: `${repo}@${release.tagName}`, prNumber: null, title: release.name || release.tagName, sha: null, at: Date.parse(release.publishedAt) }));
    }
    const merged = await reads.mergedPrs(repo, config.base, 10);
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
      const runs =
        release.sha === null
          ? []
          : await reads.runsForCommit(repo, release.sha).catch((error) => {
              bb.log.warn(`release-watch ${key}: ${String(error)}`);
              return null;
            });
      if (runs === null) continue;
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
      // While the hub is paused this throws its "Paused: GitHub quota low…" text.
      const found = await reads.openPrForBranch(slug, environment.branchName).catch((error: Error) => {
        if (error instanceof QuotaPausedError || error.message === GH_MISSING) throw error;
        return null;
      });
      if (found === null) throw new Error(`No open PR for branch ${environment.branchName}.`);
      pr = found;
    }
    // Refuse closed/merged PRs up front: a wrong repo guess (same number, other
    // repo) shows up here instead of as a bogus "merged" notice later. While the
    // hub is paused the watch is kept unchecked; its first read reports a merged
    // or closed PR.
    const current = await reads.prSummary(slug, pr).catch((error: Error) => {
      if (error instanceof QuotaPausedError) return "paused" as const;
      throw error;
    });
    if (current === null) throw new Error(`${slug}#${pr} doesn't exist or isn't accessible. Pass repo explicitly.`);
    if (current !== "paused" && current.state !== "OPEN") {
      throw new Error(
        `${slug}#${pr} is already ${current.state.toLowerCase()} ("${current.title}", opened ${current.createdAt.slice(0, 10)}). If you meant a PR in another repo, pass repo (owner/name).`,
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

  async function failedLog(url: string | null, repo: string): Promise<string> {
    const runId = runIdOf(url);
    return runId ? reads.failedLog(repo, Number(runId)) : "";
  }

  /** After each hub cycle: what each CI watch says, from PRs read in that cycle only. */
  async function checkCiNow(view: HubView) {
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    // One message per thread per cycle, however many of its PRs have news.
    const outbox = new Map<string, { notes: string[]; stillWatching: boolean }>();
    // Applied to a fresh read at the end, so watches added during the check survive.
    const removed = new Set<string>();
    // A working agent checks its PRs itself (pr_status). Its watches stay as
    // they are until it goes idle; the first idle cycle then reports the
    // current checks and every review since the last report, in one message.
    const busy = new Map<string, boolean>();
    for (const [key, watch] of Object.entries(watches)) {
      if (!busy.has(watch.threadId)) {
        const thread = await bb.sdk.threads.get({ threadId: watch.threadId }).catch(() => null);
        busy.set(watch.threadId, thread !== null && BUSY_STATUSES.has(thread.status));
      }
      if (busy.get(watch.threadId)) continue;
      const light = view.pr(watch.repo, watch.pr);
      const verdict = view.verdict(watch.repo, watch.pr);
      if (!light || !verdict) {
        // Not read this cycle. Paused: nothing to say. A PR GitHub keeps refusing
        // (gone, no access) is dropped after the usual timeout instead of
        // warning every cycle forever.
        if (view.failed.has(`${watch.repo}#${watch.pr}`)) {
          if (Date.now() - watch.since > CI_TIMEOUT_MS) {
            delete watches[key];
            removed.add(key);
            bb.log.warn(`ci ${key}: dropped after repeated read errors`);
          } else {
            bb.log.warn(`ci ${key}: not readable this cycle`);
          }
        }
        continue;
      }
      const step = stepCiWatch(watch, light, verdict, view.login, Date.now());
      watches[key] = step.watch;
      if (!step.report) continue;
      const entry = outbox.get(watch.threadId) ?? { notes: [], stillWatching: false };
      if (!step.done) entry.stillWatching = true;
      if (step.notes.length === 0) {
        delete watches[key];
        removed.add(key);
        continue;
      }
      const log = step.logOf ? await failedLog(step.logOf.url, watch.repo) : "";
      entry.notes.push(...step.notes.map((note, i) => (i === 0 && log ? `${note}${log}` : note)));
      outbox.set(watch.threadId, entry);
      if (step.done) {
        delete watches[key];
        removed.add(key);
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
    // While the hub is paused the watch is kept unchecked; its first read reports a finished run.
    const current = await reads.runSummary(ref.repo, ref.runId).catch((error: Error) => {
      if (error instanceof QuotaPausedError) return "paused" as const;
      throw error;
    });
    if (current === null) throw new Error(`Run ${ref.runId} in ${ref.repo} doesn't exist or isn't accessible.`);
    if (current !== "paused" && current.status === "completed") {
      throw new Error(`That run already finished: ${current.conclusion} (${current.url}). Nothing to wait for.`);
    }
    const watch: RunWatch =
      current === "paused"
        ? { threadId, repo: ref.repo, runId: ref.runId, label: `run ${ref.runId}`, since: Date.now() }
        : { threadId, repo: ref.repo, runId: ref.runId, label: current.name, ...(current.displayTitle ? { displayTitle: current.displayTitle } : {}), since: Date.now() };
    await update<Record<string, RunWatch>>("runWatches", {}, (all) => {
      all[`${threadId}:${ref.repo}/runs/${ref.runId}`] = watch;
    });
    changed();
    return watch;
  }

  /** After each hub cycle: finished runs message their threads, from runs read in that cycle only. */
  async function checkRunsNow(view: HubView) {
    const watches = await get<Record<string, RunWatch>>("runWatches", {});
    const removed = new Set<string>();
    for (const [key, watch] of Object.entries(watches)) {
      // News for a working agent would only pile up; it gets one message when idle.
      const thread = await bb.sdk.threads.get({ threadId: watch.threadId }).catch(() => null);
      if (thread !== null && BUSY_STATUSES.has(thread.status)) continue;
      const run = view.run(watch.repo, watch.runId);
      let text: string | null = null;
      if (run) {
        const outcome = runOutcome(
          { status: run.status, conclusion: run.conclusion, name: watch.label, ...(watch.displayTitle ? { displayTitle: watch.displayTitle } : {}), url: run.url, jobs: run.failedJobs },
          watch.repo,
        );
        if (outcome) {
          text = outcome.text + (outcome.failed ? await reads.failedLog(watch.repo, watch.runId) : "");
        } else if (Date.now() - watch.since > RUN_TIMEOUT_MS) {
          text = `${watch.label} in ${watch.repo.split("/")[1]} is still ${run.status} after 12 hours; stopped watching. ${run.url}`;
        }
      } else if (!view.quota.paused && view.cycleAt > 0 && Date.now() - watch.since > RUN_TIMEOUT_MS) {
        text = `Stopped watching run ${watch.runId} in ${watch.repo}: GitHub did not return it for 12 hours.`;
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

  /** What the hub reads for the watches: their PRs (with reviews where asked) and runs. */
  async function interest(): Promise<{ prs: Array<LightItem & { watched: boolean }>; runs: RunItem[] }> {
    const watches = Object.values(await get<Record<string, CiWatch>>("ciWatches", {}));
    const runs = Object.values(await get<Record<string, RunWatch>>("runWatches", {}));
    const prs = new Map<string, LightItem & { watched: boolean }>();
    for (const watch of watches) {
      const key = `${watch.repo}#${watch.pr}`;
      const known = prs.get(key);
      // `watched`: someone waits on its checks (a reviews-only watch needs no check details).
      const feedback = watch.watchFor !== "checks" || (known?.feedback ?? false);
      const watched = watch.watchFor !== "reviews" || (known?.watched ?? false);
      prs.set(key, { repo: watch.repo, number: watch.pr, feedback, watched });
    }
    const seen = new Set<string>();
    const runItems = runs.filter((run) => !seen.has(`${run.repo}/${run.runId}`) && seen.add(`${run.repo}/${run.runId}`)).map((run) => ({ repo: run.repo, runId: run.runId }));
    return { prs: [...prs.values()], runs: runItems };
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

  // Single flight: the schedule and `check-now` share one run.
  let releaseRun: Promise<void> | null = null;
  const checkReleases = () => (releaseRun ??= checkReleasesNow().finally(() => (releaseRun = null)));
  // CI and run watches act on each hub cycle; the hub runs one cycle at a time,
  // so a thread never gets the same "CI is green" twice.
  hub.onCycle(checkCiNow);
  hub.onCycle(checkRunsNow);
  /** `check-now`: one hub cycle, which also checks the CI and run watches. */
  const checkCi = async () => {
    await hub.cycle();
  };

  bb.background.schedule("release-watch", "*/3 * * * *", async () => {
    if (releaseRun !== null || Object.keys(releaseConfig).length === 0 || hub.quota().paused) return;
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const pending = await get<Record<string, Pending>>("pendingReleases", {});
    if (Object.keys(waiters).length + Object.keys(pending).length === 0) return;
    await checkReleases();
  });

  async function status() {
    return {
      autoContinue: await get<Record<string, AutoContinue>>("autoContinue", {}),
      releaseWaiters: await get<Record<string, ReleaseWaiter>>("releaseWaiters", {}),
      pendingReleases: await get<Record<string, Pending>>("pendingReleases", {}),
      ciWatches: await get<Record<string, CiWatch>>("ciWatches", {}),
      runWatches: await get<Record<string, RunWatch>>("runWatches", {}),
      github: { ...hub.quota(), counters: hub.readings() },
    };
  }

  /** What will message this thread on its own: CI/review watches and release waits. */
  async function wakeupsFor(threadId: string): Promise<Array<{ kind: "ci" | "release"; key: string; label: string }>> {
    const watches = await get<Record<string, CiWatch>>("ciWatches", {});
    const runs = await get<Record<string, RunWatch>>("runWatches", {});
    const waiters = await get<Record<string, ReleaseWaiter>>("releaseWaiters", {});
    const what = { checks: "checks", reviews: "reviews", both: "checks and reviews" } as const;
    // While the hub is paused, every GitHub watch says so first.
    const paused = pausedText(hub.quota());
    const prefix = paused ? `${paused} · ` : "";
    return [
      ...Object.entries(runs)
        .filter(([, watch]) => watch.threadId === threadId)
        .map(([key, watch]) => ({ kind: "ci" as const, key, label: `${prefix}${watch.repo.split("/")[1]} · ${watch.label}` })),
      ...Object.entries(watches)
        .filter(([, watch]) => watch.threadId === threadId)
        .map(([key, watch]) => ({
          kind: "ci" as const,
          key,
          label: `${prefix}${watch.repo.split("/")[1]}#${watch.pr} ${watch.quiet ? "reviews" : what[watch.watchFor]}`,
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

  return { watchCi, watchRun, interest, registerReleaseWaiter, checkReleases, checkCi, status, autoContinueAt, cancelAutoContinue, wakeupsFor, cancelWakeup, RELEASE_WAIT };
}
