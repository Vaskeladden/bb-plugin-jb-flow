import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useComposer,
  useRpc,
  useSdk,
  useSettings,
  useRealtime,
  useRealtimeConnectionState,
  UrlLink,
  experimental_useSidebarThreadPullRequest as useBranchPr,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import "./live-activity.css";
import { useMonitorCollapse } from "./monitor-collapse";
import type { rpcContract } from "./server";
import type { ThreadStatus } from "./thread-status";
import { donkeyPrompt, revisePrompt } from "./status-prompt";
import { currentPlatform, shortcutLabel, type Shortcut } from "./palette-model";

export type StatusRequestKind = "status" | "donkey";
/** Fired by the Status and Donkey commands; the focused thread's card answers it. */
export const STATUS_REQUEST_EVENT = "jb-flow:request-status";
export const STATUS_REQUEST_SHORTCUTS: Record<StatusRequestKind, Shortcut> = {
  status: { key: "u", alt: true, shift: true },
  donkey: { key: "i", alt: true, shift: true },
};

export function requestThreadStatus(threadId: string, kind: StatusRequestKind) {
  window.dispatchEvent(new CustomEvent(STATUS_REQUEST_EVENT, { detail: { threadId, kind }, cancelable: true }));
}

const withShortcut = (title: string, kind: StatusRequestKind) =>
  `${title} (${shortcutLabel(STATUS_REQUEST_SHORTCUTS[kind], currentPlatform())})`;

type Sdk = ReturnType<typeof useSdk>;
type Timeline = Awaited<ReturnType<Sdk["threads"]["timeline"]>>;
export type ActivityTask = Timeline["activeBackgroundCommands"][number];
export type ActivityData = Pick<
  Timeline,
  | "activeBackgroundCommands"
  | "activeWorkflows"
  | "rows"
  | "pendingTodos"
  | "goal"
  | "contextWindowUsage"
>;
export type ActivityPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  attention: string;
};

function Meter({
  label,
  value,
  max,
  text,
  kind = "plan",
}: {
  label: string;
  value: number;
  max: number;
  text: string;
  kind?: "plan" | "workflow" | "budget" | "context";
}) {
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(value) || value < 0)
    return null;
  return (
    <div
      className="jf-live-meter"
      data-kind={kind}
      data-high={value / max >= 0.9}
    >
      <div>
        <span>{label}</span>
        <strong>{text}</strong>
      </div>
      <progress aria-label={label} max={max} value={Math.min(value, max)} />
    </div>
  );
}

function PrLink({ pr }: { pr: ActivityPr }) {
  let safe = false;
  try {
    safe = ["https:", "http:"].includes(new URL(pr.url).protocol);
  } catch {
    /* Invalid links stay inert. */
  }
  if (!safe) return null;
  const label =
    pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : pr.state === "draft"
          ? "Draft"
          : pr.attention === "none"
            ? "Open"
            : pr.attention.replaceAll("_", " ");
  return (
    <UrlLink
      className="jf-live-pr"
      href={pr.url}
      title={pr.title}
      data-state={pr.state}
      data-attention={pr.attention}
    >
      <Icon
        name={pr.state === "merged" ? "GitMerge" : "GitPullRequest"}
        className="size-3.5"
      />
      #{pr.number}
      <span>{label}</span>
    </UrlLink>
  );
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useActivity(threadId: string, enabled: boolean) {
  const sdk = useSdk();
  const [result, setResult] = useState<{
    threadId: string;
    data: ActivityData;
    updatedAt: number;
  } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;
    let again = false;
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const data = await sdk.threads.timeline({
          threadId,
          segmentLimit: "1",
          deferContent: "true",
          includeNestedRows: "false",
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setResult({ threadId, data, updatedAt: Date.now() });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult(null);
        }
      } finally {
        inflight = false;
        if (again && !controller.signal.aborted) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (timer || controller.signal.aborted) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 750);
    };
    // One bounded snapshot on mount; subsequent snapshots follow real events.
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: schedule,
    });
    const reconnect = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected") schedule();
      },
    });
    void refresh();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      unsubscribe();
      reconnect();
    };
  }, [sdk, threadId, enabled]);
  return {
    data: result?.threadId === threadId ? result.data : null,
    updatedAt: result?.updatedAt ?? 0,
  };
}

function useThreadStatus(threadId: string, enabled: boolean, running: boolean) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{
    threadId: string;
    snapshot: ThreadStatus | null;
    stale: boolean;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let again = false;
    const refresh = async () => {
      if (disposed) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        const snapshot = await rpc.call("thread_status", {
          threadId,
          refresh: !running,
        });
        if (!disposed)
          setResult({
            threadId,
            snapshot: snapshot?.threadId === threadId ? snapshot : null,
            stale: false,
          });
      } catch {
        if (!disposed)
          setResult((previous) => ({
            threadId,
            snapshot:
              previous?.threadId === threadId ? previous.snapshot : null,
            stale: true,
          }));
      } finally {
        inflight = false;
        if (again && !disposed) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 750);
    };
    const unsubscribe = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: () => {
        if (!running) schedule();
      },
    });
    const reconnect = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected") schedule();
      },
    });
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      reconnect();
    };
  }, [sdk, rpc, threadId, enabled, running]);
  return result?.threadId === threadId ? result : null;
}

function taskKind(task: ActivityTask): string {
  if (
    task.taskType === "local_agent" ||
    task.taskType === "local_subagent" ||
    task.taskType.includes("agent")
  )
    return "Agent";
  if (task.workflowName || task.taskType === "workflow") return "Workflow";
  return "Command";
}

function activityTasks(data: ActivityData): ActivityTask[] {
  return [
    ...new Map(
      [...data.activeBackgroundCommands, ...data.activeWorkflows].map(
        (task) => [task.id, task],
      ),
    ).values(),
  ];
}

function currentAction(data: ActivityData): {
  title: string;
  detail: string | null;
} {
  const work = [...data.rows]
    .reverse()
    .find(
      (row) =>
        row.kind === "work" &&
        row.status === "pending" &&
        (row.workKind === "command" ||
          row.workKind === "tool" ||
          row.workKind === "file-change"),
    );
  if (work?.kind === "work") {
    if (work.workKind === "command")
      return { title: "Running a command", detail: work.command };
    if (work.workKind === "tool")
      return {
        title:
          work.presentation?.title ??
          work.presentation?.label.pending ??
          work.toolName,
        detail: work.presentation?.detail ?? null,
      };
    return { title: "Updating files", detail: null };
  }
  const step = data.pendingTodos?.items.find(
    (item) => item.status === "in_progress",
  );
  return { title: step?.text ?? "Working on your request", detail: null };
}

function Task({ task, now }: { task: ActivityTask; now: number }) {
  const agents = task.workflow?.agents ?? [];
  const done = agents.filter(
    (agent) => agent.state === "done" || agent.state === "skipped",
  ).length;
  return (
    <article className="jf-live-task" data-task-state={task.taskStatus}>
      <div className="jf-live-task-top">
        <span className="jf-live-task-kind">
          <Icon
            name={taskKind(task) === "Agent" ? "UserRoundPlus" : "Terminal"}
            className="size-3.5"
          />
          {taskKind(task)}
        </span>
        <span className="jf-live-task-state">{task.taskStatus}</span>
        <time>{elapsed(now - task.startedAt)}</time>
      </div>
      <div className="jf-live-task-title">{task.description}</div>
      {task.summary && <p className="jf-live-task-update">{task.summary}</p>}
      <div className="jf-live-task-meta">
        {task.model && <span>{task.model}</span>}
        {task.usage && (
          <>
            <span>{task.usage.toolUses.toLocaleString()} tool calls</span>
            <span>{task.usage.totalTokens.toLocaleString()} tokens</span>
          </>
        )}
      </div>
      {agents.length > 0 && (
        <>
          <div className="jf-live-progress-label">
            <span>Workflow steps</span>
            <span>
              {done}/{agents.length} complete
            </span>
          </div>
          <progress
            max={agents.length}
            value={done}
            aria-label={`${task.description}: workflow steps complete`}
          />
          <ul className="jf-live-agents">
            {agents.map((agent) => (
              <li
                key={`${agent.index}:${agent.attempt}`}
                data-state={agent.state}
              >
                <span className="jf-live-step-dot" aria-hidden="true" />
                <div>
                  <strong>{agent.label}</strong>
                  <span>
                    {agent.lastToolSummary ??
                      agent.lastToolName ??
                      agent.phaseTitle ??
                      agent.state}
                  </span>
                </div>
                <span>{agent.state}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {task.error && <p className="jf-live-task-error">{task.error}</p>}
    </article>
  );
}

/**
 * Everything that will prompt this thread on its own, behind one quiet
 * "Auto-prompt" control: continue after a usage limit (a switch), and each
 * CI/review watch and release wait (untick to stop it).
 */
function AutoPromptMenu({
  autoContinue,
  onToggleAutoContinue,
  watches,
  onCancelWatch,
}: {
  autoContinue: { enabled: boolean; scheduledAt: number | null };
  onToggleAutoContinue: (enabled: boolean) => Promise<void>;
  watches: readonly { kind: "ci" | "release"; key: string; label: string }[];
  onCancelWatch?: (watch: { kind: "ci" | "release"; key: string }) => Promise<void>;
}) {
  const portalScope = usePortalScopeProps();
  const count = (autoContinue.enabled ? 1 : 0) + watches.length;
  const item =
    "relative flex cursor-default select-none items-start gap-2 rounded-sm py-[0.3125rem] pl-7 pr-3 text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
  const check = (
    <span className="absolute left-2 top-[0.4rem] flex size-3.5 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator>
        <Icon name="Check" className="size-3.5" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  );
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="jf-autoprompt" data-on={count > 0}>
          <Icon name="RefreshCw" className="size-3" />
          Auto-prompt
          <span>{count > 0 ? `· ${count}` : "· off"}</span>
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          {...portalScope}
          align="end"
          sideOffset={6}
          className="z-50 min-w-64 max-w-80 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenuPrimitive.Label className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
            Prompt this thread automatically
          </DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.CheckboxItem
            className={item}
            checked={autoContinue.enabled}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => void onToggleAutoContinue(checked === true)}
          >
            {check}
            <span>
              Continue after a usage limit resets
              {autoContinue.enabled && autoContinue.scheduledAt !== null && (
                <span className="block text-muted-foreground">
                  Queued for {new Date(autoContinue.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </span>
          </DropdownMenuPrimitive.CheckboxItem>
          {watches.map((watch) => (
            <DropdownMenuPrimitive.CheckboxItem
              key={watch.key}
              className={item}
              checked
              disabled={!onCancelWatch}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                if (!checked && onCancelWatch) void onCancelWatch(watch);
              }}
            >
              {check}
              <span>{watch.kind === "ci" ? `When ${watch.label} report back` : `When the ${watch.label} is out`}</span>
            </DropdownMenuPrimitive.CheckboxItem>
          ))}
          {watches.length === 0 && (
            <p className="px-2 pb-1.5 pt-1 text-[11px] text-muted-foreground">No CI or release watches for this thread.</p>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/** A status report older than this asks to be refreshed. */
const STATUS_OUTDATED_MS = 6 * 3_600_000;

export function ActivityCard({
  threadId,
  data,
  running,
  startedAt,
  now,
  updatedAt,
  connected,
  phase = "working",
  prs = [],
  branchPrUrl,
  onClearGoal,
  idleLabel,
  monitor,
  monitorStale = false,
  hasLiveData = true,
  onRequestStatus,
  onRequestUltrastatus,
  onRequestDonkey,
  onRequestRevise,
  parked,
  onTogglePark,
  archiveTone,
  onArchive,
  autoContinue,
  onToggleAutoContinue,
  watches = [],
  onCancelWatch,
}: {
  /** The thread this card belongs to; its Status and Donkey shortcuts act only on it. */
  threadId?: string;
  /** CI/review watches and release waits that will message this thread. */
  watches?: readonly { kind: "ci" | "release"; key: string; label: string }[];
  onCancelWatch?: (watch: { kind: "ci" | "release"; key: string }) => Promise<void>;
  /** Per-thread "continue after a usage-limit reset" (null while loading). */
  autoContinue?: { enabled: boolean; scheduledAt: number | null } | null;
  onToggleAutoContinue?: (enabled: boolean) => Promise<void>;
  idleLabel?: string;
  monitor?: ThreadStatus | null;
  monitorStale?: boolean;
  hasLiveData?: boolean;
  onRequestStatus?: () => Promise<void>;
  /** Asks the agent for the thorough, checked report on the whole job, child threads included, shown in pictures. */
  onRequestUltrastatus?: () => Promise<void>;
  /** Asks the agent to explain the problem in plain words, with decisions as buttons. */
  onRequestDonkey?: () => Promise<void>;
  /** Asks the agent to have Fable 5.2 or Codex review its plan, then continue with the revised plan. */
  onRequestRevise?: () => Promise<void>;
  /** Parked by you: out of Needs me and the other lists until it runs again (undefined while loading). */
  parked?: boolean;
  onTogglePark?: (parked: boolean) => Promise<void>;
  /** Shown for a Ready thread, and highlighted for a Done one: archiving is one tap, also on a phone. */
  archiveTone?: "ready" | "done";
  onArchive?: () => Promise<void>;
  data: ActivityData;
  running: boolean;
  startedAt: number | null;
  now: number;
  updatedAt: number;
  connected: boolean;
  phase?: "working" | "waiting" | "stopping";
  prs?: readonly ActivityPr[];
  branchPrUrl?: string;
  onClearGoal?: () => Promise<void>;
}) {
  const { collapsed, toggle: toggleCollapsed } = useMonitorCollapse();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const inFlight = useRef(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [togglingContinue, setTogglingContinue] = useState(false);
  const detailsId = useId();
  const tasks = activityTasks(data);
  const count = tasks.length;
  const agents = tasks.filter((task) => taskKind(task) === "Agent").length;
  const commands = tasks.filter((task) => taskKind(task) === "Command").length;
  const workflows = tasks.filter(
    (task) => taskKind(task) === "Workflow",
  ).length;
  const action = currentAction(data);
  const primary = tasks[0];
  const todos = data.pendingTodos?.items ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const goal = data.goal;
  const context = data.contextWindowUsage;
  const active =
    running ||
    tasks.some(
      (task) => task.taskStatus === "running" || task.taskStatus === "pending",
    );
  // A report the agent has replied past, an old one, or none at all: ask for a
  // fresh one prominently instead of presenting stale text as current.
  const reportAge = monitor?.report ? now - monitor.report.capturedAt : null;
  const outdatedReason = !monitor?.report
    ? "No status report yet"
    : monitor.latestAt > monitor.report.capturedAt + 60_000
      ? "The agent replied after this report"
      : reportAge !== null && reportAge > STATUS_OUTDATED_MS
        ? `Last report ${elapsed(reportAge)} ago`
        : null;
  const canRequest = !active && !!onRequestStatus;
  const outdated = canRequest && outdatedReason !== null;
  const send = async (request: (() => Promise<void>) | undefined, failure: string) => {
    if (!request || inFlight.current) return;
    inFlight.current = true;
    setRequesting(true);
    setStatusError(null);
    try {
      await request();
    } catch {
      setStatusError(failure);
    } finally {
      inFlight.current = false;
      setRequesting(false);
    }
  };
  const requestStatus = () => send(onRequestStatus, "Could not request status. Try again.");
  const requestUltrastatus = () => send(onRequestUltrastatus, "Could not request the Ultrastatus. Try again.");
  const requestDonkey = () => send(onRequestDonkey, "Could not ask for the explanation. Try again.");
  const requestRevise = () => send(onRequestRevise, "Could not ask for the revision. Try again.");
  const shortcutTargets = useRef({ status: requestStatus, donkey: requestDonkey, canRequest, hasDonkey: !!onRequestDonkey });
  shortcutTargets.current = { status: requestStatus, donkey: requestDonkey, canRequest, hasDonkey: !!onRequestDonkey };
  useEffect(() => {
    if (!threadId) return;
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; kind?: StatusRequestKind }>).detail;
      if (event.defaultPrevented || detail?.threadId !== threadId) return;
      const targets = shortcutTargets.current;
      // Same rules as the buttons: only while they show, and one request at a time.
      if (!targets.canRequest || inFlight.current) return;
      if (detail.kind === "donkey" && !targets.hasDonkey) return;
      event.preventDefault();
      void (detail.kind === "donkey" ? targets.donkey() : targets.status());
    };
    window.addEventListener(STATUS_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(STATUS_REQUEST_EVENT, onRequest);
  }, [threadId]);
  const steps = tasks.flatMap((task) => task.workflow?.agents ?? []);
  const finishedSteps = steps.filter(
    (step) => step.state === "done" || step.state === "skipped",
  ).length;
  const title = running
    ? phase === "stopping"
      ? "Stopping agent…"
      : phase === "waiting"
        ? "Waiting for your input"
        : action.title
    : (idleLabel ??
      primary?.description ??
      (goal?.status === "complete"
        ? "Goal complete"
        : goal?.status === "paused"
          ? "Goal paused"
          : goal?.status === "budgetLimited"
            ? "Goal budget reached"
            : goal
              ? "Ready to continue"
              : "Agent idle"));
  return (
    <section
      className="jf-live-card"
      aria-label="Agent activity"
      data-jb-flow-live-activity={hasLiveData ? "" : undefined}
      data-jb-flow-goal={hasLiveData && !!goal && !!onClearGoal}
      data-jb-flow-branch-pr={!!branchPrUrl}
      data-jb-flow-plan={hasLiveData && todos.length > 0}
      data-collapsed={collapsed}
      data-expanded={expanded}
      data-connected={connected}
      data-active={phase === "working" && active}
    >
      <div className="jf-live-heading">
        <span className="jf-live-orbit" aria-hidden="true">
          <Icon name="Zap" className="size-4" />
        </span>
        <div className="jf-live-heading-copy">
          <strong className="jf-live-now" title={title}>
            {title}
          </strong>
        </div>
        <span className="jf-live-live">
          <span aria-hidden="true" />
          {connected ? (active ? "Live" : "Idle") : "Reconnecting"}
        </span>
        {active && startedAt !== null && (
          <time className="jf-live-elapsed" aria-label="Elapsed time">
            {elapsed(now - startedAt)}
          </time>
        )}
        {!running && onArchive && archiveTone && (
          <button
            type="button"
            className={archiveTone === "done" ? "jf-monitor-update" : "jf-monitor-update jf-monitor-update-quiet"}
            style={archiveTone === "done" ? { background: "var(--pr-merged, #8b5cf6)", color: "white" } : undefined}
            onClick={() => void onArchive().catch(() => {})}
            title={archiveTone === "done" ? "All work is done and merged: archive this thread" : "Nothing left for the agent: archive this thread"}
          >
            Archive
          </button>
        )}
        {canRequest && (
          <button
            type="button"
            className={outdated ? "jf-monitor-update" : "jf-monitor-update jf-monitor-update-quiet"}
            disabled={requesting}
            onClick={requestStatus}
            title={withShortcut("Ask the agent for a fresh status report", "status")}
          >
            {requesting ? "Requesting…" : "Status"}
          </button>
        )}
        {canRequest && onRequestUltrastatus && (
          <button
            type="button"
            className="jf-monitor-update jf-monitor-update-quiet"
            disabled={requesting}
            onClick={requestUltrastatus}
            title="Ask the agent for a thorough status of the whole job, child threads included: every claim checked, shown as a matrix of what is done and what is left. Takes a while and many tokens"
          >
            Ultrastatus
          </button>
        )}
        {canRequest && onRequestDonkey && (
          <button
            type="button"
            className="jf-monitor-update jf-monitor-update-quiet"
            disabled={requesting}
            onClick={requestDonkey}
            title={withShortcut(
              "Ask the agent what the real problem is, in plain words with an example, and for decisions you can answer with a click",
              "donkey",
            )}
          >
            Donkey
          </button>
        )}
        {canRequest && onRequestRevise && (
          <button
            type="button"
            className="jf-monitor-update jf-monitor-update-quiet"
            disabled={requesting}
            onClick={requestRevise}
            title="Have Fable 5.2 (complex work) or Codex review the plan, then continue with the better plan"
          >
            Revise
          </button>
        )}
        {!running && onTogglePark && parked !== undefined && (
          <button
            type="button"
            className="jf-monitor-update jf-monitor-update-quiet"
            aria-pressed={parked}
            onClick={() => void onTogglePark(!parked).catch(() => {})}
            title={parked ? "Bring the thread back into Needs me, Autopilot or Ready" : "Put the thread aside: it leaves Needs me and the other lists until it runs again"}
          >
            {parked ? "Unpark" : "Park"}
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className="jf-live-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Less" : "Details"}
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              className="size-3.5"
            />
          </button>
        )}
        <button
          type="button"
          className="jf-live-toggle jf-monitor-collapse"
          aria-label={collapsed ? "Expand monitor" : "Collapse monitor"}
          title={collapsed ? "Expand monitor" : "Collapse monitor"}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggleCollapsed}
        >
          <Icon
            name={collapsed ? "ChevronDown" : "ChevronUp"}
            className="size-4"
          />
        </button>
      </div>
      <div id={bodyId} hidden={collapsed} className="jf-monitor-body">
        {goal && !((!active || expanded) && monitor?.report) && (
          <div className="jf-live-goal">
            <Icon name="Target" className="size-3.5" />
            <p title={goal.objective}>{goal.objective}</p>
          </div>
        )}
        {(!active || expanded) && (
          <div className="jf-monitor-report">
            {monitor?.report ? (
              <>
                <div className="jf-monitor-caption">
                  <span>
                    Status report
                    {outdated && <span className="jf-monitor-stale" title={outdatedReason ?? undefined}> · out of date</span>}
                  </span>{" "}
                  <time
                    title={new Date(monitor.report.capturedAt).toLocaleString()}
                  >
                    {elapsed(now - monitor.report.capturedAt)} ago
                  </time>
                </div>
                <dl className="jf-monitor-steps">
                  {(
                    [
                      ["Done", monitor.report.done],
                      ["Next", monitor.report.doingNow ? `Doing now: ${monitor.report.doingNow}` : monitor.report.next],
                      ["Goal", goal?.objective || monitor.report.goal],
                      ["Blocked", monitor.report.blocked],
                    ] as const
                  )
                    .filter(([, text]) => text)
                    .map(([label, text]) => (
                      <div
                        key={label}
                        className="jf-monitor-step"
                        data-field={label}
                      >
                        <dt>{label}</dt>
                        <dd>{text}</dd>
                      </div>
                    ))}
                </dl>
                {expanded && monitor.report.milestones.length > 0 && (
                  <div className="jf-monitor-milestones">
                    {monitor.report.milestones.map((milestone, index) => (
                      <Meter
                        key={`${index}:${milestone.label}`}
                        label={milestone.label}
                        value={milestone.percent}
                        max={100}
                        text={`${Math.round(milestone.percent)}%`}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : monitor?.latest ? (
              <>
                <div className="jf-monitor-caption">
                  <span>
                    Latest reply
                    {outdated && <span className="jf-monitor-stale"> · no status report yet</span>}
                  </span>{" "}
                  <time title={new Date(monitor.latestAt).toLocaleString()}>
                    {elapsed(now - monitor.latestAt)} ago
                  </time>
                </div>
                <p className="jf-monitor-latest">{monitor.latest}</p>
              </>
            ) : (
              !outdated && (
                <p className="jf-monitor-empty">
                  Ready when you are. Request a status report for Goal, Done,
                  Next, Blocked and milestone progress.
                </p>
              )
            )}
            {monitorStale && (
              <p className="jf-monitor-caption" role="status">
                {monitor
                  ? "Status refresh unavailable · showing saved information"
                  : "Status unavailable · try again when connected"}
              </p>
            )}
          </div>
        )}
        {!hasLiveData && (
          <p className="jf-monitor-caption">Live activity unavailable</p>
        )}
        {running && action.detail && (
          <div className="jf-live-action" title={action.detail}>
            {action.detail}
          </div>
        )}
        {!running && primary?.summary && (
          <p className="jf-live-summary">{primary.summary}</p>
        )}
        <div className="jf-live-meters">
          {active &&
            phase === "working" &&
            todos.length === 0 &&
            steps.length === 0 &&
            !(goal?.tokenBudget && goal.tokenBudget > 0) &&
            !(context && context.modelContextWindow > 0) && (
              <div className="jf-live-meter">
                <div>
                  <span>Live activity</span>
                  <strong>In progress</strong>
                </div>
                <div
                  className="jf-live-indeterminate"
                  role="progressbar"
                  aria-label="Live activity in progress"
                >
                  <span />
                </div>
              </div>
            )}
          {todos.length > 0 && (
            <Meter
              label="Plan complete"
              value={completed}
              max={todos.length}
              text={`${completed}/${todos.length}`}
            />
          )}
          {steps.length > 0 && (
            <Meter
              label="Workflow steps finished"
              kind="workflow"
              value={finishedSteps}
              max={steps.length}
              text={`${finishedSteps}/${steps.length}`}
            />
          )}
          {goal?.tokenBudget != null && (
            <Meter
              label="Goal token budget used"
              kind="budget"
              value={goal.tokensUsed}
              max={goal.tokenBudget}
              text={`${Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}%`}
            />
          )}
          {context && (active || expanded) && (
            <Meter
              kind="context"
              label={
                context.estimated ? "Context used · estimated" : "Context used"
              }
              value={context.usedTokens}
              max={context.modelContextWindow}
              text={`${Math.round((context.usedTokens / context.modelContextWindow) * 100)}%`}
            />
          )}
        </div>
        <div className="jf-live-footer">
          <div className="jf-live-badges">
            {agents > 0 && (
              <span>
                {agents} background agent{agents === 1 ? "" : "s"}
              </span>
            )}
            {commands > 0 && (
              <span>
                {commands} command{commands === 1 ? "" : "s"}
              </span>
            )}
            {workflows > 0 && (
              <span>
                {workflows} workflow{workflows === 1 ? "" : "s"}
              </span>
            )}
            {!running && primary?.model && <span>{primary.model}</span>}
            {goal && (
              <span className="jf-live-goal-usage">
                {goal.tokensUsed.toLocaleString()} tokens ·{" "}
                {elapsed(goal.timeUsedSeconds * 1000)} goal runtime
              </span>
            )}
            {prs.slice(0, expanded ? prs.length : 2).map((pr) => (
              <PrLink key={pr.url} pr={pr} />
            ))}
            {!expanded && prs.length > 2 && (
              <button
                type="button"
                className="jf-live-pr-more"
                onClick={() => setExpanded(true)}
              >
                +{prs.length - 2} PRs
              </button>
            )}
            {!active && !expanded && (() => {
              // Quiet one-line summary; the bars are in Details.
              const milestones = monitor?.report?.milestones ?? [];
              const parts = [
                milestones.length ? `${milestones.filter((m) => m.percent >= 100).length}/${milestones.length} milestones done` : null,
                context && context.modelContextWindow > 0 ? `context ${Math.round((context.usedTokens / context.modelContextWindow) * 100)}%` : null,
              ].filter(Boolean);
              return parts.length ? <span className="jf-monitor-summary">{parts.join(" · ")}</span> : null;
            })()}
          </div>
            {onToggleAutoContinue && autoContinue && (
              <AutoPromptMenu
                autoContinue={autoContinue}
                onToggleAutoContinue={onToggleAutoContinue}
                watches={watches}
                onCancelWatch={onCancelWatch}
              />
            )}
          {statusError && <span role="alert" className="jf-monitor-error">{statusError}</span>}
          {active && hasLiveData && (!connected || now - updatedAt > 10000) && (
            <span className="jf-live-freshness">
              {connected
                ? `Updated ${elapsed(now - updatedAt)} ago`
                : "Showing last received activity"}
            </span>
          )}
        </div>
        <div id={detailsId} hidden={!expanded} className="jf-live-details">
          {monitor?.report && monitor.latestAt > monitor.report.capturedAt && (
            <div className="jf-live-summary">
              <span className="jf-live-eyebrow">LATEST REPLY</span>
              <p>{monitor.latest}</p>
            </div>
          )}

          {running && action.detail && (
            <div className="jf-live-current-details">
              <span className="jf-live-eyebrow">CURRENT ACTION</span>
              <pre>{action.detail}</pre>
            </div>
          )}
          {goal && (
            <div className="jf-live-goal-details">
              <div>
                <span className="jf-live-eyebrow">
                  GOAL ·{" "}
                  {goal.status === "budgetLimited"
                    ? "budget limited"
                    : goal.status}
                </span>
                {onClearGoal && (
                  <button
                    type="button"
                    className="jf-live-toggle"
                    disabled={clearing}
                    onClick={async () => {
                      setClearing(true);
                      setGoalError(null);
                      try {
                        await onClearGoal();
                      } catch (error) {
                        setGoalError(
                          error instanceof Error
                            ? error.message
                            : String(error),
                        );
                      } finally {
                        setClearing(false);
                      }
                    }}
                  >
                    {clearing ? "Clearing…" : "Clear goal"}
                  </button>
                )}
              </div>
              <p>{goal.objective}</p>
              {goalError && (
                <p className="jf-live-task-error" role="alert">
                  {goalError}
                </p>
              )}
            </div>
          )}
          {count > 0 ? (
            tasks.map((task) => <Task key={task.id} task={task} now={now} />)
          ) : (
            <p className="jf-live-empty">
              {running
                ? "The primary agent is active. Background tasks will appear here when started."
                : "No background tasks running."}
            </p>
          )}
          {todos.length > 0 && (
            <div className="jf-live-plan">
              <span className="jf-live-eyebrow">CURRENT PLAN</span>
              <ol>
                {todos.map((todo) => (
                  <li key={todo.id} data-state={todo.status}>
                    <Icon
                      name={
                        todo.status === "completed"
                          ? "Check"
                          : todo.status === "in_progress"
                            ? "Loader"
                            : "Circle"
                      }
                      className="size-3.5"
                    />
                    {todo.text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <div className="jf-live-signal" aria-hidden="true">
          <span />
        </div>
      </div>
    </section>
  );
}

type Wakeups = {
  autoContinue: { enabled: boolean; scheduledAt: number | null };
  watches: { kind: "ci" | "release"; key: string; label: string }[];
  parked?: boolean;
  state?: string | null;
};

/** What will wake this thread (auto-continue, CI/review watches, release waits), kept in step with the server. */
function useWakeups(threadId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<Wakeups | null>(null);
  const load = useCallback(() => {
    if (!enabled || !threadId) return;
    rpc.call("wakeups_get", { threadId }).then(setState, () => setState(null));
  }, [rpc, threadId, enabled]);
  useEffect(() => {
    setState(null);
    load();
  }, [load]);
  useRealtime("jb-flow-changed", load);
  const toggle = useCallback(
    async (next: boolean) => {
      const autoContinue = await rpc.call("auto_continue_set", { threadId, enabled: next });
      setState((current) => (current ? { ...current, autoContinue } : current));
    },
    [rpc, threadId],
  );
  const cancel = useCallback(
    async (watch: { kind: "ci" | "release"; key: string }) => {
      await rpc.call("wakeup_cancel", { threadId, ...watch });
      setState((current) => (current ? { ...current, watches: current.watches.filter((w) => w.key !== watch.key) } : current));
    },
    [rpc, threadId],
  );
  const park = useCallback(
    async (next: boolean) => {
      const { parked } = await rpc.call("thread_park", { threadId, parked: next });
      setState((current) => (current ? { ...current, parked } : current));
    },
    [rpc, threadId],
  );
  return { state, toggle, cancel, park };
}

export function LiveActivityBanner({
  runningSince,
  trackedPrs = {},
  watches = {},
}: {
  runningSince: Record<string, { since: number }>;
  trackedPrs?: Record<string, readonly ActivityPr[]>;
  watches?: Record<string, { label: string }>;
}) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const { values } = useSettings();
  const { threads } = useSidebarThreads();
  const scope = composer.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const { pullRequest } = useBranchPr(threadId ?? "");
  const thread = threads.find((thread) => thread.id === threadId);
  const running =
    composer.isRunning ||
    thread?.status === "active" ||
    thread?.status === "starting" ||
    thread?.status === "stopping";
  const enabled =
    !!threadId && values?.threadMonitor === true && !thread?.isArchived;
  const wakeups = useWakeups(threadId ?? "", enabled);
  const { data, updatedAt } = useActivity(threadId ?? "", enabled);
  const monitor = useThreadStatus(threadId ?? "", enabled, running);
  const connection = useRealtimeConnectionState();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  if (!enabled || !threadId) return null;
  const activity = data ?? {
    activeBackgroundCommands: [],
    activeWorkflows: [],
    rows: [],
    pendingTodos: null,
    goal: null,
  };
  const tasks = activityTasks(activity);
  const taskStart =
    tasks.length > 0 ? Math.min(...tasks.map((task) => task.startedAt)) : null;
  const prs = [...(trackedPrs[threadId] ?? [])];
  if (pullRequest) {
    const index = prs.findIndex((pr) => pr.url === pullRequest.url);
    if (index < 0) prs.push(pullRequest);
    else prs[index] = pullRequest;
  }
  return (
    <ActivityCard
      key={threadId}
      threadId={threadId}
      data={activity}
      hasLiveData={!!data}
      idleLabel={
        thread?.status === "error"
          ? "Agent needs attention"
          : thread?.hasPendingInteraction
            ? "Waiting for your input"
            : watches[threadId]
              ? `Waiting · ${watches[threadId].label}`
              : undefined
      }
      monitor={monitor?.snapshot}
      monitorStale={monitor?.stale}
      autoContinue={wakeups.state?.autoContinue ?? null}
      onToggleAutoContinue={wakeups.toggle}
      watches={wakeups.state?.watches ?? []}
      onCancelWatch={wakeups.cancel}
      onRequestStatus={async () => {
        await rpc.call("thread_status_request", { threadId, kind: "status" });
      }}
      onRequestUltrastatus={async () => {
        await rpc.call("thread_status_request", { threadId, kind: "ultra" });
      }}
      onRequestDonkey={async () => {
        await rpc.call("thread_reply", { threadId, text: donkeyPrompt(values?.donkeyPrompt) });
      }}
      onRequestRevise={async () => {
        await rpc.call("thread_reply", { threadId, text: revisePrompt(values?.revisePrompt) });
      }}
      parked={wakeups.state ? (wakeups.state.parked ?? false) : undefined}
      onTogglePark={wakeups.park}
      archiveTone={wakeups.state?.state === "done" ? "done" : wakeups.state?.state === "ready" ? "ready" : undefined}
      onArchive={async () => {
        await sdk.threads.archive({ threadId });
      }}
      running={running}
      startedAt={runningSince[threadId]?.since ?? taskStart}
      now={now}
      updatedAt={updatedAt}
      connected={connection === "connected"}
      prs={prs}
      branchPrUrl={pullRequest?.url}
      onClearGoal={
        thread && !thread.isArchived
          ? async () => {
              await sdk.threads.clearGoal({ threadId });
            }
          : undefined
      }
      phase={
        thread?.status === "stopping"
          ? "stopping"
          : thread?.hasPendingInteraction
            ? "waiting"
            : "working"
      }
    />
  );
}
