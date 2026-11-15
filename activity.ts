// Tracks running threads: when the current run started and when it last
// produced an event. The sidebar shows elapsed time and flags runs that have
// been silent for a long time ("stuck?"), which history shows do happen
// (171 turns over an hour, one over four days).
import { everyThread } from "./all-threads";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type Running = { since: number; lastEventAt: number };

/** Silence after which a running thread is flagged as possibly stuck. */
export const STUCK_AFTER_MS = 15 * 60_000;

export function createActivity(bb: BbPluginApi, changed: () => void) {
  const running = new Map<string, Running>();
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  // Event bursts are frequent; the UI only needs minute-level freshness.
  const publish = () => {
    publishTimer ??= setTimeout(() => {
      publishTimer = null;
      changed();
    }, 5_000);
  };
  bb.onDispose(() => {
    if (publishTimer) clearTimeout(publishTimer);
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (!running.has(thread.id)) running.set(thread.id, { since: Date.now(), lastEventAt: Date.now() });
    changed();
  });
  bb.events.on("experimental_thread.events", ({ thread }) => {
    const entry = running.get(thread.id);
    if (entry) {
      const wasStuck = Date.now() - entry.lastEventAt > STUCK_AFTER_MS;
      entry.lastEventAt = Date.now();
      if (wasStuck) changed();
      else publish();
    }
  });
  const stop = ({ thread }: { thread: { id: string } }) => {
    if (running.delete(thread.id)) changed();
  };
  bb.events.on("thread.idle", stop);
  bb.events.on("thread.failed", stop);
  bb.events.on("thread.archived", stop);

  // Threads already running when the plugin loads: best-effort start times.
  void everyThread((page) => bb.sdk.threads.list(page))
    .then((threads) => {
      for (const thread of threads) {
        if (thread.archivedAt === null && (thread.status === "active" || thread.status === "starting")) {
          running.set(thread.id, { since: thread.updatedAt, lastEventAt: thread.updatedAt });
        }
      }
      changed();
    })
    .catch(() => undefined);

  return {
    snapshot: (): Record<string, Running> => Object.fromEntries(running),
  };
}
