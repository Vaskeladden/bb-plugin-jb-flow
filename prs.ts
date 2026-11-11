// Tracks every PR a thread creates, across repos, so stacked and cross-repo
// work shows up as one unit. bb itself only links the PR for a thread's branch.
//
// Discovery: scan the thread's completed commands for `gh pr create` output
// (incrementally, from a per-thread cursor), plus manual links. Status: the
// GitHub hub (pr-hub.ts) reads every linked PR in its shared query; this file
// keeps the result per thread, with stack order derived from base/head
// branches within a repo.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { attentionOf, type LightItem } from "./hub-model.ts";
import type { Hub, HubView } from "./pr-hub";

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

export function createPrTracker(bb: BbPluginApi, changed: () => void, hub: Hub) {
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
    if (!remove) await refresh();
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

  /**
   * Linked PRs the hub should read: open, draft or never read; merged and
   * closed ones at most hourly. Pruning archived threads needs the full
   * thread list, so it runs at most every three minutes.
   */
  let pruned = 0;
  async function interest(): Promise<LightItem[]> {
    const status = await getStatus();
    const all = Date.now() - pruned > 3 * 60_000 ? await prune(await liveThreadIds(), status) : await getThreads();
    if (Date.now() - pruned > 3 * 60_000) {
      pruned = Date.now();
      writeTable("pr_status", "key", status);
    }
    const live = new Map<string, LightItem>();
    for (const entry of Object.values(all)) {
      for (const ref of entry.refs) {
        const known = status[key(ref)];
        if (known && (known.state === "merged" || known.state === "closed") && Date.now() - known.checkedAt < 3_600_000) continue;
        live.set(key(ref), { repo: ref.repo, number: ref.number, feedback: false });
      }
    }
    return [...live.values()];
  }

  /** After each hub cycle: the linked PRs it read become their thread's PR state. */
  async function apply(view: HubView) {
    const status = await getStatus();
    const linked = new Set(Object.values(await getThreads()).flatMap((entry) => entry.refs.map(key)));
    let changes = 0;
    for (const prKey of linked) {
      const [repo, number] = prKey.split("#");
      const light = view.pr(repo!, Number(number));
      const verdict = view.verdict(repo!, Number(number));
      if (!light || !verdict) continue;
      status[prKey] = {
        repo: light.repo,
        number: light.number,
        title: light.title,
        url: light.url,
        state: light.state === "MERGED" ? "merged" : light.state === "CLOSED" ? "closed" : light.isDraft ? "draft" : "open",
        attention: attentionOf(light, verdict),
        base: light.base,
        head: light.head,
        mergedAt: light.mergedAt,
        stackedOn: null,
        checkedAt: light.readAt,
      };
      changes += 1;
    }
    if (changes === 0) return;
    writeTable("pr_status", "key", status);
    changed();
  }
  hub.onCycle(apply);

  /** A read of every linked PR now (at most every 20 s; the hub reads them every few minutes anyway). */
  async function refresh(): Promise<void> {
    await hub.soon();
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

  // When a turn ends, a PR it opened is read at once; what it did to PRs the
  // thread already had shows at the hub's next read (within a minute while
  // anything is watched).
  bb.events.on("thread.idle", async ({ thread }) => {
    const found = await scan(thread.id).catch(() => []);
    if (found.length > 0) await refresh();
  });

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
      if (!signal.aborted) await refresh();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  return { scan, link, refresh, interest, byThread, openPrsFor };
}
