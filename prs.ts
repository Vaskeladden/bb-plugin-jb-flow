// Tracks every PR a thread creates, across repos, so stacked and cross-repo
// work shows up as one unit. bb itself only links the PR for a thread's branch.
//
// Discovery: scan the thread's completed commands for `gh pr create` output
// (incrementally, from a per-thread cursor), plus manual links. Status: one
// batched GraphQL query every few minutes for all linked PRs, with stack order
// derived from base/head branches within a repo.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const prAttention = z.enum([
  "merged",
  "closed",
  "draft",
  "conflicts",
  "checks_failed",
  "changes_requested",
  "checks_pending",
  "review_requested",
  "ready_to_merge",
]);
export const prStatusSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  attention: prAttention,
  base: z.string(),
  head: z.string(),
  /** When it merged (ms), for release tracking; absent on older cached entries. */
  mergedAt: z.number().nullable().optional(),
  /** Number of the PR this one is stacked on (same repo), if any. */
  stackedOn: z.number().nullable(),
  checkedAt: z.number(),
});
export type PrStatus = z.infer<typeof prStatusSchema>;
type PrRef = { repo: string; number: number };
type ThreadPrs = { refs: PrRef[]; cursor: number };

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
const key = (ref: PrRef) => `${ref.repo}#${ref.number}`;

type CompletedItem = {
  type?: string;
  command?: unknown;
  aggregatedOutput?: unknown;
  tool?: unknown;
  status?: unknown;
  result?: unknown;
  text?: unknown;
};

const refsIn = (text: string): PrRef[] =>
  [...text.matchAll(PR_URL)].map((match) => ({ repo: match[1]!, number: Number(match[2]) }));

// A tool that opens a PR: GitHub MCP's create_pull_request and the like.
const CREATE_PR_TOOL = /create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|\bcreate[_-]?pr\b/i;
// The agent saying it opened one ("Opened https://…/pull/12", "PR is up: …").
// Only these: a PR the agent merely mentions or reviews isn't the thread's.
const OPENED_PR = new RegExp(
  String.raw`\b(opened|created|raised|filed|submitted|put up|pushed up)\b[^\n]{0,80}?https://github\.com/[\w.-]+/[\w.-]+/pull/\d+|\b(PR|pull request)\b[^\n]{0,40}?\b(is up|opened|created)\b[^\n]{0,60}?https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`,
  "gi",
);

/** PRs a completed thread item shows the thread created. */
export function createdPrs(item: CompletedItem | undefined): PrRef[] {
  if (!item) return [];
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? "");
    return /\bgh\s+pr\s+create\b/.test(command) ? refsIn(String(item.aggregatedOutput ?? "")) : [];
  }
  if (item.type === "toolCall") {
    if (item.status !== "completed" || !CREATE_PR_TOOL.test(String(item.tool ?? ""))) return [];
    return refsIn(typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""));
  }
  if (item.type === "agentMessage") {
    return [...String(item.text ?? "").matchAll(OPENED_PR)].flatMap((match) => refsIn(match[0]));
  }
  return [];
}

/**
 * PRs to re-check once a thread's turn ends: the ones it just created, plus
 * every linked PR that was still open, draft or never fetched. A turn can
 * merge, close or push to a PR the thread already had, and the sidebar must
 * show that as soon as the turn ends, not at the next scheduled refresh.
 * Settled PRs (merged, closed) are left to the hourly re-check.
 */
export function refsToRefreshAfterTurn(
  linked: readonly PrRef[],
  status: Readonly<Record<string, Pick<PrStatus, "state">>>,
  created: readonly PrRef[],
): PrRef[] {
  const out = new Map<string, PrRef>();
  for (const ref of created) out.set(key(ref), ref);
  for (const ref of linked) {
    const state = status[key(ref)]?.state;
    if (state === "merged" || state === "closed") continue;
    out.set(key(ref), ref);
  }
  return [...out.values()];
}

export const GH_MISSING = "The GitHub CLI (gh) isn't installed or isn't on PATH. Install it and run `gh auth login`.";

/** A readable gh failure; a missing binary gets setup instructions instead of "spawn gh ENOENT". */
export function ghError(prefix: string, error: Error & { code?: string | number | null }, stderr: string, max: number): Error {
  if (error.code === "ENOENT") return new Error(GH_MISSING);
  return new Error(`${prefix}: ${stderr || error.message}`.slice(0, max));
}

export function gh(args: string[], timeout = 60_000): Promise<string> {
  const bin = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(ghError("gh", error, stderr, 400));
      else resolve(stdout);
    });
  });
}

/**
 * A GraphQL query through gh. GitHub answers a query with one unresolvable
 * part (an issue number, a deleted repo) with an error *and* data for every
 * other part; gh then exits non-zero. Keep that partial data.
 */
export function ghGraphql<T>(query: string, timeout = 60_000): Promise<T> {
  const bin = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find(existsSync) ?? "gh";
  return new Promise((resolve, reject) => {
    execFile(bin, ["api", "graphql", "-f", `query=${query}`], { timeout, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed: { data?: T | null } | null = null;
      try {
        parsed = JSON.parse(stdout) as { data?: T | null };
      } catch {
        parsed = null;
      }
      if (parsed?.data) resolve(parsed.data);
      else reject(error ? ghError("gh graphql", error, stderr, 400) : new Error("gh graphql: no data"));
    });
  });
}

type GqlPr = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  baseRefName: string;
  headRefName: string;
  mergedAt: string | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
};

function attentionOf(pr: GqlPr): PrStatus["attention"] {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.isDraft) return "draft";
  if (pr.mergeable === "CONFLICTING") return "conflicts";
  const checks = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  if (checks === "FAILURE" || checks === "ERROR") return "checks_failed";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (checks === "PENDING" || checks === "EXPECTED") return "checks_pending";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "review_requested";
  return "ready_to_merge";
}

/** Long-lived branches: a PR *from* one of these (e.g. a dev→main release) is not a stack parent. */
const TRUNK = /^(main|master|dev|develop|development|staging|production|prod|release([/-].*)?)$/;

/** Orders PRs so each stack reads base-first, and fills `stackedOn`. */
export function orderStack(prs: PrStatus[]): PrStatus[] {
  const byHead = new Map(prs.filter((pr) => !TRUNK.test(pr.head)).map((pr) => [`${pr.repo}:${pr.head}`, pr]));
  const withParent = prs.map((pr) => ({ ...pr, stackedOn: byHead.get(`${pr.repo}:${pr.base}`)?.number ?? null }));
  const children = new Map<string, PrStatus[]>();
  for (const pr of withParent) {
    if (pr.stackedOn === null) continue;
    const parent = `${pr.repo}#${pr.stackedOn}`;
    children.set(parent, [...(children.get(parent) ?? []), pr]);
  }
  const ordered: PrStatus[] = [];
  const visit = (pr: PrStatus) => {
    if (ordered.includes(pr)) return;
    ordered.push(pr);
    for (const child of (children.get(key(pr)) ?? []).sort((a, b) => a.number - b.number)) visit(child);
  };
  withParent
    .filter((pr) => pr.stackedOn === null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
    .forEach(visit);
  withParent.forEach(visit); // cycles or orphans, just in case
  return ordered;
}

export function createPrTracker(bb: BbPluginApi, changed: () => void) {
  const kv = bb.storage.kv;
  // PR data lives in the plugin's own SQLite database: kv values are capped at
  // 256KB, and a busy user links hundreds of PRs a month.
  const db = () => bb.storage.database();
  bb.storage.migrate(db(), [
    "CREATE TABLE pr_status (key TEXT PRIMARY KEY, json TEXT NOT NULL)",
    "CREATE TABLE thread_prs (thread_id TEXT PRIMARY KEY, json TEXT NOT NULL)",
  ]);
  function readTable<T>(table: "pr_status" | "thread_prs", column: "key" | "thread_id"): Record<string, T> {
    const rows = db().prepare(`SELECT ${column} AS id, json FROM ${table}`).all() as Array<{ id: string; json: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.json) as T]));
  }
  function writeTable(table: "pr_status" | "thread_prs", column: "key" | "thread_id", value: Record<string, unknown>) {
    const handle = db();
    const insert = handle.prepare(`INSERT INTO ${table} (${column}, json) VALUES (?, ?)`);
    handle.transaction(() => {
      handle.prepare(`DELETE FROM ${table}`).run();
      for (const [id, entry] of Object.entries(value)) insert.run(id, JSON.stringify(entry));
    })();
  }
  // One-time move out of kv (v0.1.1 and earlier).
  const moved = (async () => {
    for (const [kvKey, table, column] of [
      ["prStatus", "pr_status", "key"],
      ["threadPrs", "thread_prs", "thread_id"],
    ] as const) {
      const old = await kv.get<Record<string, unknown>>(kvKey);
      if (old === null || old === undefined) continue;
      writeTable(table, column, old);
      await kv.delete(kvKey);
    }
  })().catch((error) => bb.log.warn(`pr storage move: ${String(error)}`));
  const getThreads = async () => {
    await moved;
    return readTable<ThreadPrs>("thread_prs", "thread_id");
  };
  const setThreads = async (value: Record<string, ThreadPrs>) => writeTable("thread_prs", "thread_id", value);
  // Scans (backfill, idle events, CLI) interleave; serialize read-modify-write
  // of the threadPrs map so one never overwrites another's results.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  }
  const updateThread = (threadId: string, apply: (entry: ThreadPrs) => void) =>
    exclusive(async () => {
      const all = await getThreads();
      const entry = all[threadId] ?? { refs: [], cursor: 0 };
      apply(entry);
      all[threadId] = entry;
      await setThreads(all);
      return entry;
    });
  const getStatus = async () => {
    await moved;
    return readTable<PrStatus>("pr_status", "key");
  };

  /** Reads new completed commands since the thread's cursor and links PRs it created. */
  async function scan(threadId: string, signal?: AbortSignal): Promise<PrRef[]> {
    let cursor = (await getThreads())[threadId]?.cursor ?? 0;
    const found: PrRef[] = [];
    for (let page = 0; page < 400; page += 1) {
      if (signal?.aborted) break;
      const rows = await bb.sdk.threads.events.list({
        ...(signal ? { signal } : {}),
        threadId,
        afterSeq: String(cursor),
        types: ["item/completed"],
        order: "asc",
        limit: "100",
      });
      for (const row of rows) {
        cursor = Math.max(cursor, row.seq);
        found.push(...createdPrs((row.data as { item?: CompletedItem }).item));
      }
      if (rows.length < 100) break;
    }
    await updateThread(threadId, (entry) => {
      entry.cursor = Math.max(entry.cursor, cursor);
      for (const ref of found) if (!entry.refs.some((existing) => key(existing) === key(ref))) entry.refs.push(ref);
    });
    return found;
  }

  async function link(threadId: string, ref: PrRef, remove = false) {
    await updateThread(threadId, (entry) => {
      entry.refs = entry.refs.filter((existing) => key(existing) !== key(ref));
      if (!remove) entry.refs.push(ref);
    });
    await refresh([ref]);
  }

  /** Ids of threads that are neither archived nor deleted. */
  async function liveThreadIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const page = await bb.sdk.threads.list({ limit: 500, offset });
      for (const thread of page) if (thread.archivedAt === null && thread.deletedAt === null) ids.add(thread.id);
      if (page.length < 500) return ids;
    }
  }

  /**
   * Drops archived and deleted threads, and the PRs only they referenced. kv
   * values are capped at 256KB, and a busy user links hundreds of PRs a month.
   */
  async function prune(live: Set<string>, status: Record<string, PrStatus>) {
    const kept = await exclusive(async () => {
      const all = await getThreads();
      let removed = 0;
      for (const threadId of Object.keys(all)) {
        if (!live.has(threadId)) {
          delete all[threadId];
          removed += 1;
        }
      }
      if (removed > 0) await setThreads(all);
      return all;
    });
    const referenced = new Set(Object.values(kept).flatMap((entry) => entry.refs.map(key)));
    for (const prKey of Object.keys(status)) if (!referenced.has(prKey)) delete status[prKey];
    return kept;
  }

  /** Fetches status for the given PRs (default: all linked to active threads). */
  let refreshLock: Promise<unknown> = Promise.resolve();
  function refresh(only?: PrRef[], signal?: AbortSignal): Promise<void> {
    // One at a time: each run writes the whole prStatus map.
    const run = refreshLock.then(() => refreshNow(only, signal), () => refreshNow(only, signal));
    refreshLock = run.catch(() => undefined);
    return run;
  }

  async function fetchBatch(query: string): Promise<Record<string, Record<string, GqlPr | null> | null> | null> {
    try {
      return await ghGraphql<Record<string, Record<string, GqlPr | null> | null>>(query);
    } catch (error) {
      bb.log.warn(`pr refresh: ${String(error)}`);
      return null;
    }
  }

  async function refreshNow(only?: PrRef[], signal?: AbortSignal) {
    const status = await getStatus();
    let refs = only;
    if (refs === undefined) {
      const all = await prune(await liveThreadIds(), status);
      const live = new Set<string>();
      for (const entry of Object.values(all)) {
        for (const ref of entry.refs) {
          const known = status[key(ref)];
          // Merged/closed PRs are settled; re-check them at most hourly.
          if (known && (known.state === "merged" || known.state === "closed") && Date.now() - known.checkedAt < 3_600_000) continue;
          live.add(key(ref));
        }
      }
      refs = [...live].map((value) => {
        const [repo, number] = value.split("#");
        return { repo: repo!, number: Number(number) };
      });
    }
    for (let index = 0; index < refs.length; index += 40) {
      // A reload waits for this; stop between batches (what's fetched so far is kept).
      if (signal?.aborted) break;
      const batch = refs.slice(index, index + 40);
      const byRepo = new Map<string, number[]>();
      for (const ref of batch) byRepo.set(ref.repo, [...(byRepo.get(ref.repo) ?? []), ref.number]);
      const allRepos = [...byRepo.entries()];
      const queryFor = (repos: typeof allRepos) => `query { ${repos
        .map(([repo, numbers], r) => {
          const [owner, name] = repo.split("/");
          return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers
            .map((number) => `p${number}: pullRequest(number: ${number}) { ...F }`)
            .join(" ")} }`;
        })
        .join(" ")} }
        fragment F on PullRequest { number title url state isDraft mergeable reviewDecision baseRefName headRefName mergedAt
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
      // One deleted repo or inaccessible PR fails the whole query; then retry
      // repo by repo so the rest still updates.
      const whole = await fetchBatch(queryFor(allRepos));
      const parts: Array<[typeof allRepos, Record<string, Record<string, GqlPr | null> | null>]> = [];
      if (whole) parts.push([allRepos, whole]);
      else if (allRepos.length > 1) {
        for (const single of allRepos) {
          const data = await fetchBatch(queryFor([single]));
          if (data) parts.push([[single], data]);
        }
      }
      for (const [repos, data] of parts) repos.forEach(([repo, numbers], r) => {
        for (const number of numbers) {
          const pr = data[`r${r}`]?.[`p${number}`];
          if (!pr) continue;
          status[`${repo}#${number}`] = {
            repo,
            number,
            title: pr.title,
            url: pr.url,
            state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
            attention: attentionOf(pr),
            base: pr.baseRefName,
            head: pr.headRefName,
            mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
            stackedOn: null,
            checkedAt: Date.now(),
          };
        }
      });
    }
    writeTable("pr_status", "key", status);
    changed();
  }

  /** PRs per active thread, stack-ordered, for the UI. */
  async function byThread(): Promise<Record<string, PrStatus[]>> {
    const all = await getThreads();
    const status = await getStatus();
    const result: Record<string, PrStatus[]> = {};
    for (const [threadId, entry] of Object.entries(all)) {
      const prs = entry.refs.map((ref) => status[key(ref)]).filter((pr): pr is PrStatus => pr !== undefined);
      if (prs.length > 0) result[threadId] = orderStack(prs);
    }
    return result;
  }

  async function openPrsFor(threadId: string): Promise<PrRef[]> {
    const prs = (await byThread())[threadId] ?? [];
    return prs.filter((pr) => pr.state === "open" || pr.state === "draft").map(({ repo, number }) => ({ repo, number }));
  }

  // When a turn ends, its new PRs appear and its linked PRs show what the
  // turn did to them (merged, closed, new checks) right away.
  bb.events.on("thread.idle", async ({ thread }) => {
    const found = await scan(thread.id).catch(() => []);
    const linked = (await getThreads())[thread.id]?.refs ?? [];
    const refs = refsToRefreshAfterTurn(linked, await getStatus(), found);
    if (refs.length > 0) await refresh(refs);
  });

  bb.background.schedule("pr-refresh", "*/3 * * * *", () => refresh());

  // Backfill active threads once per load, without blocking startup.
  bb.background.service("pr-backfill", {
    async start(signal) {
      if ((await kv.get<number>("threadPrsVersion")) !== 2) {
        await exclusive(() => setThreads({}));
        await kv.set("threadPrsVersion", 2);
      }
      const threads = await bb.sdk.threads.list({ limit: 500 });
      for (const thread of threads) {
        if (signal.aborted) return;
        if (thread.archivedAt !== null || thread.parentThreadId !== null) continue;
        await scan(thread.id, signal).catch((error) => {
          if (!signal.aborted) bb.log.warn(`pr scan ${thread.id}: ${String(error)}`);
        });
      }
      if (!signal.aborted) await refresh(undefined, signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { scan, link, refresh, byThread, openPrsFor };
}
