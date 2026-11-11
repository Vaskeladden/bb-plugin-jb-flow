// The GitHub hub: one shared read of every PR and Actions run the plugin
// follows (CI watches, run watches, the PRs threads created), instead of one
// read per watch, per thread or per page of checks.
//
// Each cycle sends one light query across all repos (state, check counts per
// state, and recent reviews/comments only where someone waits for them):
// about 1 point, whatever the number of PRs or checks. A PR's failed checks and
// required checks are read only when its counts say it is needed
// (hub-model.ts `detailNeeded`), about 1 point per few PRs. The cycle runs
// every minute while a CI or run watch is open, else every third minute.
//
// Below the quota floor, or after GitHub refuses a request for rate limits,
// the hub reads nothing until the counter resets (github.ts). Watchers only
// act on PRs read in the current cycle, so nothing is reported from a read
// that was not made.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { QuotaPausedError, RateLimitedError, type GitHub, type Reads, type QuotaState } from "./github.ts";
import {
  checksVerdict,
  DETAIL_BATCH,
  detailNeeded,
  detailQuery,
  LIGHT_BATCH,
  lightQuery,
  prKey,
  readDetail,
  readLight,
  type Counts,
  type LightAnswer,
  type LightItem,
  type PrDetail,
  type PrKey,
  type PrLight,
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
  verdict(repo: string, number: number): Verdict | undefined;
  /** The first blocking failure's run, for its log. */
  run(repo: string, runId: number): RunLight | undefined;
  /** PRs this cycle tried and could not read (not counting a pause). */
  failed: Set<PrKey>;
  login: string | null;
};

const REQUIRED_TTL_MS = 60 * 60_000;
/** An early cycle (refresh, a new PR) at most this often. */
const SOON_GAP_MS = 20_000;

export function createHub(bb: BbPluginApi, github: GitHub, reads: Reads, interest: () => Promise<Interest>) {
  const lights = new Map<PrKey, PrLight>();
  const details = new Map<PrKey, PrDetail>();
  const lastCounts = new Map<PrKey, Counts | null>();
  const required = new Map<string, { names: string[] | null; at: number }>();
  const listeners: Array<(view: HubView) => Promise<void>> = [];
  let login: string | null = null;
  let lastCycleAt = 0;
  let running: Promise<HubView> | null = null;

  async function requiredFor(repo: string, base: string): Promise<string[] | null> {
    const key = `${repo}:${base}`;
    const cached = required.get(key);
    if (cached && Date.now() - cached.at < REQUIRED_TTL_MS) return cached.names;
    const names = await reads.requiredChecks(repo, base);
    required.set(key, { names, at: Date.now() });
    return names;
  }

  const verdictOf = (light: PrLight) => checksVerdict(light, details.get(prKey(light.repo, light.number)), required.get(`${light.repo}:${light.base}`)?.names ?? null);

  async function readLights(wanted: Interest, cycleAt: number, fresh: Set<PrKey>, failed: Set<PrKey>, runs: Map<string, RunLight>) {
    const prs = wanted.prs;
    const batches = Math.max(1, Math.ceil(prs.length / LIGHT_BATCH));
    for (let b = 0; b < batches; b += 1) {
      const items = prs.slice(b * LIGHT_BATCH, (b + 1) * LIGHT_BATCH);
      const runItems = b === 0 ? wanted.runs : [];
      if (items.length + runItems.length === 0) continue;
      try {
        const { data, errors } = await github.graphql<LightAnswer>(lightQuery(items, runItems), "watched PRs");
        if (errors.length > 0) bb.log.warn(`github hub: ${errors.slice(0, 3).join("; ")}`);
        const answer = readLight(data, items, runItems, cycleAt);
        login = answer.login ?? login;
        for (const item of items) {
          const key = prKey(item.repo, item.number);
          const light = answer.prs.get(key);
          if (light) {
            lights.set(key, light);
            fresh.add(key);
          } else failed.add(key);
        }
        for (const [key, run] of answer.runs) runs.set(key, run);
      } catch (error) {
        if (error instanceof RateLimitedError || error instanceof QuotaPausedError) throw error;
        bb.log.warn(`github hub: ${String(error)}`);
        for (const item of items) failed.add(prKey(item.repo, item.number));
      }
    }
  }

  async function readDetails(wanted: Interest, fresh: Set<PrKey>, cycleAt: number) {
    const watched = new Set(wanted.prs.filter((pr) => pr.watched).map((pr) => prKey(pr.repo, pr.number)));
    const due = new Map<string, number[]>(); // "repo base" -> numbers
    for (const key of fresh) {
      const light = lights.get(key)!;
      if (light.state !== "OPEN" || !light.counts) continue;
      // Required checks are only needed to explain failures or to finish a watch.
      const needsRules = light.counts.failed > 0 || watched.has(key);
      const names = needsRules ? await requiredFor(light.repo, light.base) : (required.get(`${light.repo}:${light.base}`)?.names ?? null);
      if (detailNeeded(light, details.get(key), names, watched.has(key), cycleAt, lastCounts.get(key) ?? null)) {
        const group = `${light.repo} ${light.base}`;
        due.set(group, [...(due.get(group) ?? []), light.number]);
      }
    }
    for (const [group, numbers] of due) {
      const [repo, base] = group.split(" ") as [string, string];
      const names = required.get(`${repo}:${base}`)?.names ?? null;
      for (let i = 0; i < numbers.length; i += DETAIL_BATCH) {
        const batch = numbers.slice(i, i + DETAIL_BATCH);
        try {
          const { data } = await github.graphql<{ r?: Record<string, unknown> | null }>(detailQuery(repo, batch, names ?? []), `checks of ${repo}`);
          for (const number of batch) {
            const key = prKey(repo, number);
            const detail = readDetail(data.r?.[`d${number}`] as Parameters<typeof readDetail>[0], names, lights.get(key)!, cycleAt);
            if (detail) details.set(key, detail);
          }
        } catch (error) {
          if (error instanceof RateLimitedError || error instanceof QuotaPausedError) throw error;
          bb.log.warn(`github hub: checks of ${repo}: ${String(error)}`);
        }
      }
    }
  }

  async function cycleNow(): Promise<HubView> {
    const cycleAt = Date.now();
    lastCycleAt = cycleAt;
    const fresh = new Set<PrKey>();
    const failed = new Set<PrKey>();
    const runs = new Map<string, RunLight>();
    if (!github.quota.state().paused) {
      const wanted = await interest();
      try {
        await readLights(wanted, cycleAt, fresh, failed, runs);
        await readDetails(wanted, fresh, cycleAt);
      } catch (error) {
        // Paused or refused: stop reading; what was read before the refusal still counts.
        bb.log.warn(`github hub: ${String(error)}`);
      }
      for (const key of fresh) lastCounts.set(key, lights.get(key)!.counts);
      for (const key of [...details.keys()]) if (lights.get(key)?.state !== "OPEN") details.delete(key);
    }
    const view: HubView = {
      cycleAt,
      quota: github.quota.state(),
      pr: (repo, number) => (fresh.has(prKey(repo, number)) ? lights.get(prKey(repo, number)) : undefined),
      verdict: (repo, number) => {
        const light = fresh.has(prKey(repo, number)) ? lights.get(prKey(repo, number)) : undefined;
        return light ? verdictOf(light) : undefined;
      },
      run: (repo, runId) => runs.get(`${repo}/runs/${runId}`),
      failed,
      login,
    };
    for (const listener of listeners) await listener(view).catch((error) => bb.log.warn(`github hub listener: ${String(error)}`));
    return view;
  }

  /** One cycle at a time; callers during a cycle share it. */
  function cycle(): Promise<HubView> {
    running ??= cycleNow().finally(() => (running = null));
    return running;
  }

  /** A cycle now, unless one ran in the last 20 s (then that one's results stand). */
  async function soon(): Promise<void> {
    if (running) {
      await running;
      return;
    }
    if (Date.now() - lastCycleAt < SOON_GAP_MS) return;
    await cycle();
  }

  bb.background.schedule("github-hub", "* * * * *", async () => {
    const wanted = await interest();
    if (wanted.prs.length + wanted.runs.length === 0) return;
    if (!wanted.urgent && new Date().getMinutes() % 3 !== 0) return;
    await cycle();
  });

  return {
    cycle,
    soon,
    /** Called after every cycle, in registration order. */
    onCycle(listener: (view: HubView) => Promise<void>) {
      listeners.push(listener);
    },
    /** The last read of a PR and what its checks mean (any cycle). */
    last(repo: string, number: number): { light: PrLight; verdict: Verdict } | undefined {
      const light = lights.get(prKey(repo, number));
      return light ? { light, verdict: verdictOf(light) } : undefined;
    },
    quota: () => github.quota.state(),
    readings: () => github.quota.readings(),
  };
}
export type Hub = ReturnType<typeof createHub>;
