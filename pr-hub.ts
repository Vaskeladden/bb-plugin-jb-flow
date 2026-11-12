// The GitHub hub: one shared read of every PR and Actions run the plugin
// follows (CI watches, run watches, the PRs threads created), instead of one
// read per watch, per thread or per page of checks.
//
// Each cycle sends one light query per 60 PRs and 60 runs, across repos
// (state, check counts per state, and recent reviews/comments only where
// someone waits for them): about 1 point. A PR's failed checks and required
// checks are read only when its counts say it is needed (hub-model.ts
// `detailNeeded`), about 1 point per few PRs. A cycle starts at most once a
// minute while a CI or run watch is open, else every third minute; an early
// cycle (`soon`) takes the place of a scheduled one, so nothing reads more
// often than once a minute.
//
// Below the quota floor, or after GitHub refuses a request for rate limits,
// the hub reads nothing until the counter resets (github.ts). A CI verdict
// comes only from this cycle's reads (hub-model.ts `checksVerdict`), so
// nothing is reported from a read that was not made.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { QuotaPausedError, RateLimitedError, type GitHub, type QuotaState, type Reads } from "./github.ts";
import {
  attentionOf,
  checksVerdict,
  DETAIL_BATCH,
  detailNeeded,
  detailQuery,
  lightBatches,
  lightQuery,
  prKey,
  readDetail,
  readLight,
  runKey,
  type Attention,
  type LightAnswer,
  type LightItem,
  type PrDetail,
  type PrKey,
  type PrLight,
  type RequiredChecks,
  type RunItem,
  type RunLight,
  type Verdict,
} from "./hub-model.ts";

/** What the plugin follows right now; asked at the start of each cycle. */
export type Interest = {
  /** `watched`: someone waits on its checks, so required checks are read too. */
  prs: Array<LightItem & { watched: boolean }>;
  runs: RunItem[];
  /** A CI or run watch is open: read every minute instead of every third. */
  urgent: boolean;
};

/** One cycle's results, handed to the watchers and the PR list. */
export type HubView = {
  cycleAt: number;
  quota: QuotaState;
  /** A PR read in this cycle; undefined when it wasn't (paused, error, gone). */
  pr(repo: string, number: number): PrLight | undefined;
  /** A CI watch's verdict, from this cycle's reads only; undefined when the PR wasn't read. */
  verdict(repo: string, number: number): Verdict | undefined;
  /** The sidebar state of a PR read this cycle (may use an earlier detail read of the same head). */
  attention(repo: string, number: number): Attention | undefined;
  /** A run read in this cycle. */
  run(repo: string, runId: number): RunLight | undefined;
  /** PRs and runs GitHub answered without (deleted, no access), by prKey / runKey. */
  missing: Set<string>;
  /** PRs and runs whose query failed this cycle (not a pause), by prKey / runKey. */
  unreadable: Set<string>;
  login: string | null;
};

const REQUIRED_TTL_MS = 60 * 60_000;
/** Cycles start at most this often, scheduled or early. */
const MIN_GAP_MS = 60_000;
const IDLE_GAP_MS = 3 * 60_000;
const TICK_MS = 10_000;

const rateLimited = (error: unknown) => error instanceof RateLimitedError || error instanceof QuotaPausedError;

export function createHub(bb: BbPluginApi, github: GitHub, reads: Reads, interest: () => Promise<Interest>) {
  const lights = new Map<PrKey, PrLight>();
  /** The last detail read of each PR, any cycle: for `detailNeeded` and the sidebar, never for a verdict. */
  const details = new Map<PrKey, { detail: PrDetail; required: RequiredChecks | null }>();
  /** Required checks per "repo:base"; only answers are kept, an unknown is asked again at the next detail read. */
  const required = new Map<string, { checks: RequiredChecks; at: number }>();
  const listeners: Array<(view: HubView) => Promise<void>> = [];
  let login: string | null = null;
  let lastCycleAt = 0;
  let running: Promise<HubView | null> | null = null;
  /** Aborted when the plugin reloads or stops: a running cycle stops between queries and tells no one. */
  let signal: AbortSignal | null = null;
  const stopped = () => signal?.aborted === true;

  async function requiredFor(repo: string, base: string): Promise<RequiredChecks | null> {
    const key = `${repo}:${base}`;
    const cached = required.get(key);
    if (cached && Date.now() - cached.at < REQUIRED_TTL_MS) return cached.checks;
    const checks = await reads.requiredChecks(repo, base).catch((error: unknown) => {
      if (rateLimited(error)) throw error;
      bb.log.warn(`github hub: rules of ${key}: ${String(error)}`);
      return null;
    });
    if (checks !== null) required.set(key, { checks, at: Date.now() });
    return checks;
  }

  type Cycle = { at: number; fresh: Set<PrKey>; details: Map<PrKey, PrDetail>; runs: Map<string, RunLight>; missing: Set<string>; unreadable: Set<string> };

  async function readLights(wanted: Interest, cycle: Cycle) {
    for (const batch of lightBatches(wanted.prs, wanted.runs)) {
      if (stopped()) return;
      try {
        const { data, errors } = await github.graphql<LightAnswer>(lightQuery(batch.prs, batch.runs), "watched PRs");
        if (errors.length > 0) bb.log.warn(`github hub: ${errors.slice(0, 3).join("; ")}`);
        // A deleted repo or PR comes back as null next to a "Could not resolve"
        // error; the rest of the batch still reads. Any other error leaves the
        // absent ones unread, not gone.
        const answer = readLight(data, batch.prs, batch.runs, cycle.at);
        const absent = errors.every((message) => /could not resolve/i.test(message)) ? cycle.missing : cycle.unreadable;
        login = answer.login ?? login;
        for (const item of batch.prs) {
          const key = prKey(item.repo, item.number);
          const light = answer.prs.get(key);
          if (light) {
            lights.set(key, light);
            cycle.fresh.add(key);
          } else absent.add(key);
        }
        for (const item of batch.runs) {
          const key = runKey(item.repo, item.runId);
          const run = answer.runs.get(key);
          if (run) cycle.runs.set(key, run);
          else absent.add(key);
        }
      } catch (error) {
        if (rateLimited(error)) throw error;
        bb.log.warn(`github hub: ${String(error)}`);
        for (const item of batch.prs) cycle.unreadable.add(prKey(item.repo, item.number));
        for (const item of batch.runs) cycle.unreadable.add(runKey(item.repo, item.runId));
      }
    }
  }

  async function readDetails(wanted: Interest, cycle: Cycle) {
    const watched = new Set(wanted.prs.filter((pr) => pr.watched).map((pr) => prKey(pr.repo, pr.number)));
    const due = new Map<string, number[]>(); // "repo base" -> numbers
    for (const key of cycle.fresh) {
      const light = lights.get(key)!;
      if (!detailNeeded(light, details.get(key)?.detail, watched.has(key), cycle.at)) continue;
      const group = `${light.repo} ${light.base}`;
      due.set(group, [...(due.get(group) ?? []), light.number]);
    }
    for (const [group, numbers] of due) {
      const [repo, base] = group.split(" ") as [string, string];
      if (stopped()) return;
      const rules = await requiredFor(repo, base);
      const names = rules?.names ?? [];
      for (let i = 0; i < numbers.length; i += DETAIL_BATCH) {
        if (stopped()) return;
        const batch = numbers.slice(i, i + DETAIL_BATCH);
        try {
          const { data } = await github.graphql<{ r?: Record<string, unknown> | null }>(detailQuery(repo, batch, names), `checks of ${repo}`);
          for (const number of batch) {
            const key = prKey(repo, number);
            // Null when a push landed between the light read and this one: the PR stays pending.
            const detail = readDetail(data.r?.[`d${number}`] as Parameters<typeof readDetail>[0], names, lights.get(key)!, cycle.at);
            if (!detail) continue;
            details.set(key, { detail, required: rules });
            cycle.details.set(key, detail);
          }
        } catch (error) {
          if (rateLimited(error)) throw error;
          bb.log.warn(`github hub: checks of ${repo}: ${String(error)}`);
        }
      }
    }
  }

  /** Forgets PRs nobody follows any more, and details of PRs that closed. */
  function prune(wanted: Interest) {
    const followed = new Set(wanted.prs.map((pr) => prKey(pr.repo, pr.number)));
    for (const key of [...lights.keys()]) if (!followed.has(key)) lights.delete(key);
    for (const key of [...details.keys()]) if (lights.get(key)?.state !== "OPEN") details.delete(key);
  }

  async function cycleNow(): Promise<HubView | null> {
    const cycle: Cycle = { at: Date.now(), fresh: new Set(), details: new Map(), runs: new Map(), missing: new Set(), unreadable: new Set() };
    lastCycleAt = cycle.at;
    if (!github.quota.state().paused) {
      const wanted = await interest();
      try {
        await readLights(wanted, cycle);
        await readDetails(wanted, cycle);
      } catch (error) {
        if (!rateLimited(error)) throw error;
        // Paused or refused mid-cycle: stop reading. PRs whose detail was not read stay pending.
        bb.log.warn(`github hub: ${String(error)}`);
      }
      prune(wanted);
    }
    if (stopped()) return null;
    const fresh = (repo: string, number: number) => (cycle.fresh.has(prKey(repo, number)) ? lights.get(prKey(repo, number)) : undefined);
    const view: HubView = {
      cycleAt: cycle.at,
      quota: github.quota.state(),
      pr: fresh,
      verdict: (repo, number) => {
        const light = fresh(repo, number);
        if (!light) return undefined;
        const key = prKey(repo, number);
        return checksVerdict(light, cycle.details.get(key), details.get(key)?.required ?? null);
      },
      attention: (repo, number) => {
        const light = fresh(repo, number);
        const last = details.get(prKey(repo, number));
        return light ? attentionOf(light, last?.detail, last?.required ?? null) : undefined;
      },
      run: (repo, runId) => cycle.runs.get(runKey(repo, runId)),
      missing: cycle.missing,
      unreadable: cycle.unreadable,
      login,
    };
    for (const listener of listeners) {
      if (stopped()) break;
      await listener(view).catch((error) => bb.log.warn(`github hub listener: ${String(error)}`));
    }
    return view;
  }

  /** One cycle at a time; callers during a cycle share it. Null when the plugin stopped meanwhile. */
  function cycle(): Promise<HubView | null> {
    running ??= cycleNow().finally(() => (running = null));
    return running;
  }

  /**
   * A cycle now (`refresh: true`, a new PR), unless one started in the last
   * minute: then that one's results stand. It takes the place of the next
   * scheduled cycle, which waits a minute from this one. Says whether it
   * read, when the last read started, and from when a new one can start.
   */
  async function soon(): Promise<{ read: boolean; lastAt: number; nextAt: number }> {
    const answer = (read: boolean) => ({ read, lastAt: lastCycleAt, nextAt: lastCycleAt + MIN_GAP_MS });
    if (running) {
      await running;
      return answer(true);
    }
    if (Date.now() - lastCycleAt < MIN_GAP_MS) return answer(false);
    await cycle();
    return answer(true);
  }

  async function tick() {
    const wanted = await interest();
    if (wanted.prs.length + wanted.runs.length === 0) return;
    if (running || Date.now() - lastCycleAt < (wanted.urgent ? MIN_GAP_MS : IDLE_GAP_MS)) return;
    await cycle();
  }

  bb.background.service("github-hub", {
    async start(stop) {
      signal = stop;
      while (!stop.aborted) {
        await tick().catch((error) => bb.log.warn(`github hub: ${String(error)}`));
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            stop.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, TICK_MS);
          stop.addEventListener("abort", done, { once: true });
        });
      }
    },
  });

  return {
    cycle,
    soon,
    /** Called after every cycle, in registration order. */
    onCycle(listener: (view: HubView) => Promise<void>) {
      listeners.push(listener);
    },
    quota: () => github.quota.state(),
    readings: () => github.quota.readings(),
  };
}
export type Hub = ReturnType<typeof createHub>;
