import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import { isOpenPr, prsSettled, threadState } from "./thread-states.ts";

export type StudioStatus =
  "attention" | "running" | "review" | "waiting" | "done" | "idle";
export type StudioFilter = "all" | "attention" | "running" | "review";
type ThreadFacts = Pick<
  PluginSidebarThread,
  | "id"
  | "projectId"
  | "displayTitle"
  | "status"
  | "indicator"
  | "hasPendingInteraction"
  | "isUnread"
  | "isPinned"
  | "isHidden"
  | "isArchived"
  | "updatedAt"
>;
type WorkflowFacts = Pick<
  FlowState,
  "awaiting" | "watching" | "threadPrs" | "snoozes" | "waitingOthers"
> &
  Partial<Pick<FlowState, "promised">>;

/**
 * Blocked on you (prompt, permission, failure), or idle with a last message that
 * asks you something. The next action decides, not read state: bold shows unread,
 * and a read question still waits for your answer.
 */
export function needsMe(
  thread: Pick<PluginSidebarThread, "id" | "hasPendingInteraction" | "indicator" | "status">,
  awaiting: Record<string, number> | undefined,
): boolean {
  return (
    thread.hasPendingInteraction ||
    thread.indicator === "waiting-for-input" ||
    thread.status === "error" ||
    thread.indicator === "unread-error" ||
    (thread.status === "idle" && awaiting?.[thread.id] !== undefined)
  );
}

/** Studio's finer view of the thread's one state (thread-states.ts). */
export function studioStatus(
  thread: ThreadFacts,
  state: WorkflowFacts | null,
): StudioStatus {
  const { state: current } = threadState(thread, state);
  if (current === "needs") return "attention";
  if (current === "running") return "running";
  if (current === "autopilot" || state?.snoozes[thread.id]) return "waiting";
  const prs = state?.threadPrs[thread.id] ?? [];
  if (prs.some((pr) => isOpenPr(pr) && pr.attention === "ready_to_merge")) return "review";
  if (prsSettled(prs)) return "done";
  return "idle";
}

export const STATUS_LABEL: Record<StudioStatus, string> = {
  attention: "Needs you",
  running: "Working",
  review: "Ready to merge",
  waiting: "Waiting",
  done: "PRs settled",
  idle: "Idle",
};

const RANK: Record<StudioStatus, number> = {
  attention: 0,
  review: 1,
  running: 2,
  waiting: 3,
  idle: 4,
  done: 5,
};

export function studioThreads<T extends ThreadFacts>(
  threads: readonly T[],
  state: WorkflowFacts | null,
  options: { project: string; query: string; filter: StudioFilter },
): T[] {
  const query = options.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        !thread.isArchived &&
        !thread.isHidden &&
        (options.project === "all" || thread.projectId === options.project) &&
        (!query || thread.displayTitle.toLocaleLowerCase().includes(query)) &&
        (options.filter === "all" ||
          studioStatus(thread, state) === options.filter),
    )
    .sort(
      (a, b) =>
        RANK[studioStatus(a, state)] - RANK[studioStatus(b, state)] ||
        Number(b.isPinned) - Number(a.isPinned) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
}
