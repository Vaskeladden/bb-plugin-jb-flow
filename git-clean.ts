// Which idle threads have no uncommitted and no unmerged work in their git
// worktree, so a finished thread can show as Done (purple) instead of Ready.
// bb's environment status answers both questions, and it knows squash merges
// ("committed unmerged" is false once the work landed on the default branch).
import { everyThread } from "./all-threads.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { gh } from "./prs.ts";

/** Rechecks every idle thread this often; a thread that just went idle is checked at once. */
const SWEEP_MS = 10 * 60_000;

type Status = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["status"]>>;

/**
 * The parts of a status the Done check reads. Committed work counts as landed
 * when git sees it on the default branch, or when the branch's last commit is
 * in a merged pull request: git's squash check misses a branch that merged
 * main into itself or kept old history, which left 21 of 25 finished threads
 * Ready on 11 Nov 2026.
 */
export function needsLandedCheck(status: Status | null): string | null {
  if (!status || status.outcome !== "available") return null;
  const workspace = status.workspace as { workingTree: { hasUncommittedChanges: boolean }; mergeBase?: { hasCommittedUnmergedChanges: boolean } | null; checkout?: { headSha?: string | null } };
  if (workspace.workingTree.hasUncommittedChanges || !workspace.mergeBase?.hasCommittedUnmergedChanges) return null;
  return workspace.checkout?.headSha ?? null;
}

/** Whether GitHub lists a merged PR containing this commit (REST: commits/{sha}/pulls). */
export function inMergedPr(pulls: unknown): boolean {
  return Array.isArray(pulls) && pulls.some((pull) => typeof pull === "object" && pull !== null && typeof (pull as { merged_at?: unknown }).merged_at === "string");
}

/** Clean: nothing uncommitted, nothing committed that the default branch lacks. Null when git can't say. */
export function isClean(status: Status | null): boolean | null {
  if (!status || status.outcome !== "available") return null;
  const { workingTree, mergeBase } = status.workspace as { workingTree: { hasUncommittedChanges: boolean }; mergeBase?: { hasCommittedUnmergedChanges: boolean; squashMergeCheckComplete?: boolean } | null };
  if (workingTree.hasUncommittedChanges) return false;
  if (!mergeBase) return null;
  if (mergeBase.squashMergeCheckComplete === false) return null;
  return !mergeBase.hasCommittedUnmergedChanges;
}

export function createGitClean(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  const git = promisify(execFile);
  // A commit in a merged PR stays there, so a yes is remembered; a no is asked again later.
  const landed = new Map<string, boolean>();
  const landedInPr = async (path: string, sha: string): Promise<boolean> => {
    if (landed.get(sha)) return true;
    const remote = (await git("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 10_000 })).stdout.trim();
    const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
    if (!slug) return false;
    const yes = inMergedPr(JSON.parse(await gh(["api", `repos/${slug}/commits/${sha}/pulls`], 20_000)));
    landed.set(sha, yes);
    return yes;
  };
  const read = async () => (await kv.get<Record<string, number>>("gitClean")) ?? {};
  let lock: Promise<unknown> = Promise.resolve();
  const set = (threadId: string, clean: boolean) => {
    const run = lock.then(async () => {
      const all = await read();
      if (clean === threadId in all) return false;
      if (clean) all[threadId] = Date.now();
      else delete all[threadId];
      await kv.set("gitClean", all);
      return true;
    });
    lock = run.catch(() => undefined);
    return run.then((didChange) => {
      if (didChange) changed();
    });
  };

  /** Checks one thread; threads without a git worktree count as clean (nothing to commit). */
  const check = async (thread: { id: string; environmentId: string | null; status: string; archivedAt: number | null }, signal?: AbortSignal) => {
    if (thread.archivedAt !== null || thread.status !== "idle") return;
    if (!thread.environmentId) return set(thread.id, true);
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null);
    if (!environment || environment.environmentProviderId !== "git-worktree") return set(thread.id, true);
    const plain = await bb.sdk.environments.status({ environmentId: thread.environmentId, signal }).catch(() => null);
    const base = plain?.outcome === "available" ? plain.workspace.branch.defaultBranch : null;
    if (!base) return set(thread.id, false);
    const full = await bb.sdk.environments.status({ environmentId: thread.environmentId, mergeBaseBranch: base, signal }).catch(() => null);
    if (isClean(full) === true) return set(thread.id, true);
    const sha = needsLandedCheck(full);
    const path = (environment as { path?: string | null }).path;
    return set(thread.id, sha !== null && !!path && (await landedInPr(path, sha).catch(() => false)));
  };

  bb.events.on("thread.idle", ({ thread }) => {
    void check(thread as never).catch((error) => bb.log.warn(`git-clean ${thread.id}: ${String(error)}`));
  });
  // A run can change the worktree: not clean until the next check says so.
  bb.events.on("thread.active", ({ thread }) => void set(thread.id, false));
  bb.events.on("thread.archived", ({ thread }) => void set(thread.id, false));

  bb.background.service("git-clean-sweep", {
    async start(signal) {
      while (!signal.aborted) {
        const threads = await everyThread((page) => bb.sdk.threads.list(page)).catch(() => []);
        for (const thread of threads) {
          if (signal.aborted) return;
          await check(thread as never, signal).catch(() => {});
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SWEEP_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  return { all: read };
}
