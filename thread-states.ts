// Every live, non-snoozed thread is in exactly one of four states, by a fixed
// precedence. The sidebar's filters and counts, the palette's `is:` filters,
// Studio and `bb jb-flow states` all ask this one function, so they can't drift.
// Pure (no React, no SDK at runtime) so the unit tests cover it.
import type { PrStatus } from "./prs";
import type { FlowState } from "./server";

export type ThreadStateId = "running" | "needs" | "autopilot" | "ready" | "parked";
export const THREAD_STATES: readonly ThreadStateId[] = ["running", "needs", "autopilot", "ready", "parked"];
export const THREAD_STATE_LABEL: Record<ThreadStateId, string> = {
  running: "Running",
  needs: "Needs me",
  autopilot: "Autopilot",
  ready: "Ready",
  parked: "Parked",
};

/** One look per state, shared by the filter chips and every thread row's icon. */
export const THREAD_STATE_STYLE: Record<ThreadStateId, { glyph: "spinner" | "question" | "hourglass" | "check" | "pause"; tone: string }> = {
  running: { glyph: "spinner", tone: "text-sky-500" },
  needs: { glyph: "question", tone: "text-amber-500" },
  autopilot: { glyph: "hourglass", tone: "text-violet-500" },
  ready: { glyph: "check", tone: "text-green-500" },
  parked: { glyph: "pause", tone: "text-muted-foreground" },
};

/** A promise to report back counts as stalled after the thread has been idle this long. */
export const STALLED_AFTER_MS = 60 * 60_000;

type Pr = Pick<PrStatus, "repo" | "number" | "state" | "attention">;
export type ThreadStateThread = {
  id: string;
  status: string;
  updatedAt: number;
  hasPendingInteraction?: boolean;
  indicator?: string | null;
};
export type ThreadStateFacts = Pick<FlowState, "awaiting" | "watching"> & {
  promised?: Record<string, number>;
  waitingOthers?: Record<string, number>;
  parked?: Record<string, number>;
  threadPrs: Record<string, readonly Pr[]>;
};
export type ThreadStateResult = {
  state: ThreadStateId;
  /** Why, in a few words: shown as the row's tooltip and by `bb jb-flow states`. */
  reason: string;
  /** Details on top of the state, e.g. "red PR" on a running thread. */
  badges: string[];
};

const RED = new Set(["checks_failed", "changes_requested", "conflicts"]);
const RED_LABEL: Record<string, string> = {
  checks_failed: "checks failed",
  changes_requested: "changes requested",
  conflicts: "conflicts",
};

export const isBusy = (thread: Pick<ThreadStateThread, "status">) =>
  thread.status === "active" || thread.status === "starting" || thread.status === "stopping";
export const isOpenPr = (pr: Pick<Pr, "state">) => pr.state === "open" || pr.state === "draft";
/** Every PR merged or closed (and there is at least one). */
export const prsSettled = (prs: readonly Pick<Pr, "state">[]) =>
  prs.length > 0 && prs.every((pr) => pr.state === "merged" || pr.state === "closed");

const prName = (pr: Pr) => `${pr.repo.split("/").pop()}#${pr.number}`;

/** "45 min", "2 h", "3 d". */
export function idleFor(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/**
 * The one state a thread is in, first match wins:
 * 1. Running: an agent works on it now.
 * 2. Needs me: it can't continue without you (a prompt, a question, a failure,
 *    a red PR nothing watches, or a promise to report back that went stale).
 * 3. Autopilot: it continues without you (a watch, a fresh promise, someone else's move).
 * 4. Ready: nothing left for the agent (a green PR to ship, or finished).
 * Parked: you put it aside; nothing shows until it runs again or you unpark it.
 */
export function threadState(
  thread: ThreadStateThread,
  facts: ThreadStateFacts | null | undefined,
  now: number = Date.now(),
): ThreadStateResult {
  const prs = facts?.threadPrs[thread.id] ?? [];
  const open = prs.filter(isOpenPr);
  const red = open.filter((pr) => RED.has(pr.attention));
  const watch = facts?.watching[thread.id];
  const idle = now - thread.updatedAt;
  const promised = facts?.promised?.[thread.id] !== undefined;
  const freshPromise = promised && idle <= STALLED_AFTER_MS;
  const redReason = red.length > 0 ? `red PR ${prName(red[0]!)} (${RED_LABEL[red[0]!.attention]})` : "";

  // A prompt or permission request blocks even a running agent.
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input")
    return { state: "needs", reason: "waiting for your input or permission", badges: [] };
  if (isBusy(thread))
    return { state: "running", reason: red.length > 0 ? `agent working; ${redReason}` : "agent working", badges: red.length > 0 ? ["red PR"] : [] };
  if (facts?.parked?.[thread.id] !== undefined) return { state: "parked", reason: "parked by you", badges: [] };
  if (thread.status === "error" || thread.indicator === "unread-error")
    return { state: "needs", reason: "the last turn failed", badges: [] };
  if (facts?.awaiting[thread.id] !== undefined) return { state: "needs", reason: "asked you a question", badges: [] };
  if (red.length > 0 && !watch && !freshPromise)
    return { state: "needs", reason: `${redReason}, nothing watching`, badges: ["red PR"] };
  if (promised && !watch && !freshPromise)
    return { state: "needs", reason: `promised to report back, idle ${idleFor(idle)}`, badges: [] };

  const badges = red.length > 0 ? ["red PR"] : [];
  if (watch) return { state: "autopilot", reason: watch.label, badges };
  if (freshPromise) return { state: "autopilot", reason: "will report back by itself", badges };
  if (facts?.waitingOthers?.[thread.id] !== undefined) return { state: "autopilot", reason: "waiting on someone else", badges };
  if (open.length > 0 && open.every((pr) => pr.attention === "review_requested"))
    return { state: "autopilot", reason: `${prName(open[0]!)} waiting for review`, badges };

  const green = open.find((pr) => pr.attention === "ready_to_merge");
  if (green) return { state: "ready", reason: `green PR ${prName(green)} ready to ship`, badges: ["green PR"] };
  if (prsSettled(prs)) return { state: "ready", reason: "PRs merged or closed; nothing pending", badges: [] };
  if (open.length > 0) return { state: "ready", reason: `${prName(open[0]!)} open (${open[0]!.attention.replace(/_/g, " ")}); nothing pending`, badges: [] };
  return { state: "ready", reason: "nothing pending", badges: [] };
}
