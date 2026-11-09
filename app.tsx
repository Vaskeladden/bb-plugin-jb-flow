import "./flow-ui.css";
import { mountWorkspaceTopBar } from "./workspace-topbar";
import { toast } from "sonner";
import type { WorkspaceState } from "./workspaces";
import { WorkspaceNavigation, WorkspaceTopBar, WorkspaceRouteBridge, WorkspaceSettings } from "./workspace-ui";
import { useWorkspaces, useSelectedWorkspace } from "./workspace-client";
import { inWorkspace } from "./workspaces";
import { mountTimelineActivity } from "./timeline-activity";
// jb-flow frontend: the Triage thread list, a snooze control in the thread
// header, the stale-thread digest on the homepage, and the area-tag migration
// in settings. All plugin state comes from server.ts over RPC and refreshes on
// the "jb-flow-changed" realtime signal.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads as useSidebarThreads,
  ThreadTitle,
  useRealtime,
  useRpc,
  useSdk,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbContext,
  useBbNavigate,
  useComposer,
  useSidebarSplitLayout,
  useSidebarThreadShortcut,
  useSettings,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type {
  JsonValue,
  PluginSidebarProject,
  PluginSidebarSection,
  PluginSidebarThread,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { DigestItem, FlowState, rpcContract } from "./server";
import { useSidebarThreadActions } from "./thread-actions";
import type { Leftover } from "./leftovers";
import { RepoCommandsPanel, RepoCommandsSettings } from "./repo-panel";
import {
  DecisionChips,
  UnreleasedSection, YourMoveSection,
  HeaderStatusStrip,
  PR_TONE,
  PullRequestsPanel,
  StatusIcon,
  ThreadHoverPreview,
  allSettled,
  attentionLabel,
  duration,
  prGlyph,
  rowStatus,
  type RowWaiting,
  runInfo,
  threadPrs,
  useNow,
  worstPr,
} from "./ui-extras";
import type { RunInfo, ThreadPr } from "./ui-extras";
import { SNOOZE_PRESETS, formatWhen, parseWhen } from "./when";
import { LANE_NAMES, matchLanes, resolveLanes, sectionNames, type Lane, type LaneId, type LaneSections } from "./lanes";
import { THREAD_STATE_LABEL, THREAD_STATE_STYLE, threadState, type ThreadStateId, type ThreadStateResult } from "./thread-states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Glyph } from "@/components/ui/glyph";
import type { GlyphName } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Studio, StudioReview, STUDIO_REVIEW_TAB } from "./studio";
import { mountShellAppearance, ShellAppearancePreference } from "./shell-appearance";
import { LiveActivityBanner } from "./live-activity";
import { PALETTE_EVENT, Palette, usePaletteTrigger } from "./palette";
import { CatchUpHomeEntry, CatchUpOverlay, CatchUpPage, useCatchUpBadge, useCatchUpTrigger } from "./catch-up";
import { CATCH_UP_EVENT } from "./catch-up-model";
import { dropKey, mergeOrder, needsFreeze, stepKey } from "./section-order";
import { buildThreadTree, filterThreadTree, flattenThreadTree, indexThreadTree } from "./thread-tree";
import { ThreadBranch } from "./thread-branch";

const DAY_MS = 86_400_000;

// --- shared state -------------------------------------------------------------

// One store for every component in this window: the list, header strip, PR
// tab and snooze header all used to fetch the full state on each change.
type FlowRpc = ReturnType<typeof useRpc<typeof rpcContract>>;
let flowState: FlowState | null = null;
const flowListeners = new Set<(next: FlowState) => void>();
let flowScheduled = false;
let flowInflight = false;
let flowAgain = false;

function refetchFlowState(rpc: FlowRpc) {
  // Coalesce: every subscribed component hears the same realtime event.
  if (flowScheduled) return;
  flowScheduled = true;
  setTimeout(() => {
    flowScheduled = false;
    fetchFlowState(rpc);
  }, 0);
}

function fetchFlowState(rpc: FlowRpc) {
  if (flowInflight) {
    flowAgain = true;
    return;
  }
  flowInflight = true;
  rpc
    .call("state_get", null)
    .then((next) => {
      projectNaming = next;
      flowState = next;
      for (const listener of flowListeners) listener(next);
    }, () => undefined)
    .finally(() => {
      flowInflight = false;
      if (flowAgain) {
        flowAgain = false;
        fetchFlowState(rpc);
      }
    });
}

function useFlowState() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [state, setState] = useState<FlowState | null>(flowState);
  useEffect(() => {
    flowListeners.add(setState);
    if (flowState === null) refetchFlowState(rpc);
    else setState(flowState);
    return () => {
      flowListeners.delete(setState);
    };
  }, [rpc]);
  const refetch = useCallback(() => refetchFlowState(rpc), [rpc]);
  useRealtime("jb-flow-changed", refetch);
  useEffect(() => {
    if (connection === "connected") refetchFlowState(rpc);
  }, [connection, rpc]);
  return { rpc, state };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// --- lanes --------------------------------------------------------------------

// --- project chips ------------------------------------------------------------

let projectNaming: Pick<FlowState, "projectShortNames" | "stripProjectPrefixes"> = {
  projectShortNames: {}, stripProjectPrefixes: [],
};

function shortProjectName(name: string): string {
  const known = projectNaming.projectShortNames[name];
  if (known) return known;
  const prefix = projectNaming.stripProjectPrefixes.find((candidate) => name.startsWith(candidate));
  return (prefix ? name.slice(prefix.length) : name).slice(0, 10);
}

function ProjectChip({
  project,
}: {
  project: PluginSidebarProject | undefined;
}) {
  if (project === undefined || project.isPersonal) return null;
  return (
    <span
      className="jf-project-chip"
      title={project.name}
    >
      {shortProjectName(project.name)}
    </span>
  );
}

// --- dialogs --------------------------------------------------------------------

function SnoozeDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { rpc, state } = useFlowState();
  const current = state?.snoozes[threadId];
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setNote(current?.note ?? "");
      setCustom("");
      setError(null);
    }
  }, [open, current?.note]);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onOpenChange(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  const snooze = (when: string) =>
    run(() =>
      rpc.call("snooze", {
        threadId,
        when,
        note: note.trim() === "" ? null : note,
        until: parseWhen(when),
      }),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Snooze thread</DialogTitle>
          <DialogDescription>
            {current
              ? `Snoozed until ${formatWhen(current.until)}.`
              : "Hide it until later. It comes back unread."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {SNOOZE_PRESETS.map((preset) => (
            <Button
              key={preset.when}
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => snooze(preset.when)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.trim() !== "") void snooze(custom.trim());
          }}
        >
          <Input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="3d, fri, 2026-10-12…"
            aria-label="Custom snooze time"
          />
          <Button
            type="submit"
            size="sm"
            disabled={pending || custom.trim() === ""}
          >
            Snooze
          </Button>
        </form>
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional: prompt to send on wake-up"
          aria-label="Wake-up prompt"
        />
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {current ? (
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => run(() => rpc.call("unsnooze", { threadId }))}
            >
              Wake now
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TagDialog({
  threadId,
  tags,
  knownTags,
  onClose,
}: {
  threadId: string;
  tags: readonly string[];
  knownTags: readonly string[];
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<string[]>([...tags]);
  const [input, setInput] = useState("");
  const toggle = (tag: string) =>
    setDraft((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag],
    );
  const save = async () => {
    const next =
      input.trim() === "" ? draft : [...new Set([...draft, input.trim()])];
    await rpc.call("tags_set", { threadId, tags: next });
    onClose();
  };
  const options = [...new Set([...knownTags, ...draft])].sort();
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5">
          {options.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                draft.includes(tag)
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground",
              )}
            >
              {tag}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="New tag"
            aria-label="New tag"
          />
          <Button type="submit" size="sm">
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- thread header: status strip + Pull requests panel ------------------------------

function ThreadStatusHeader({ threadId }: { threadId: string }) {
  const { state } = useFlowState();
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  return <HeaderStatusStrip threadId={threadId} state={state} branchPr={pullRequest} />;
}

function PullRequestsTab({ threadId, params }: { threadId: string; params: JsonValue | null }) {
  const { state } = useFlowState();
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  return <PullRequestsPanel threadId={threadId} params={params} state={state} branchPr={pullRequest} />;
}

function DecisionChipsBanner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const { threads } = useSidebarThreads();
  const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
  // Stays while you type: the question lives here, so it must not vanish with a draft.
  if (composer.isRunning) return null;
  return <DecisionChips threadId={threadId} updatedAt={thread?.updatedAt ?? null} idle={thread?.status === "idle"} />;
}

/** The row after this one (or before, at the end), to keep focus on after this row moves away. */
function neighbourRowId(row: HTMLElement): string | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-jb-flow-row]"));
  const index = rows.indexOf(row);
  return (rows[index + 1] ?? rows[index - 1])?.dataset.jbFlowRow ?? null;
}

/** Focuses a row once the list has re-rendered. */
function focusRowSoon(threadId: string | null) {
  if (threadId === null) return;
  window.setTimeout(() => {
    document.querySelector<HTMLElement>(`[data-jb-flow-row="${CSS.escape(threadId)}"]`)?.focus();
  }, 150);
}

/** The ⌘K palette: mounted once per window, rendered only while open. */
function PaletteHost() {
  const enabled = useSettings().values?.palette === true;
  const { open, close, shortcut } = usePaletteTrigger(enabled);
  return open ? <PaletteWithFlow onClose={close} shortcut={shortcut} /> : null;
}

function PaletteWithFlow(props: { onClose: () => void; shortcut: Parameters<typeof Palette>[0]["shortcut"] }) {
  const { state } = useFlowState();
  return <Palette {...props} flow={state} />;
}

/** Catch up's overlay: mounted once per window, rendered only while open. */
function CatchUpHost() {
  const enabled = useSettings().values?.catchUp === true;
  useEffect(() => {
    catchUpEnabled = enabled;
  }, [enabled]);
  const { open, close } = useCatchUpTrigger(enabled);
  return open ? <CatchUpWithFlow onClose={close} /> : null;
}

function CatchUpWithFlow({ onClose }: { onClose: () => void }) {
  const { state } = useFlowState();
  return <CatchUpOverlay flow={state} onClose={onClose} />;
}

/** Hosts dialogs that command-palette commands open (they can't render UI themselves). */
function CommandHost() {
  const settings = useSettings().values;
  const expandPlans = settings?.expandPlans === true;
  useEffect(() => {
    // Read by the plan-expander content script, which can't use hooks.
    if (expandPlans) document.documentElement.dataset[EXPAND_PLANS_FLAG] = "";
    else delete document.documentElement.dataset[EXPAND_PLANS_FLAG];
  }, [expandPlans]);
  const [snoozeThreadId, setSnoozeThreadId] = useState<string | null>(null);
  useEffect(() => {
    const onSnooze = (event: Event) => setSnoozeThreadId((event as CustomEvent<string>).detail);
    window.addEventListener(SNOOZE_EVENT, onSnooze);
    return () => window.removeEventListener(SNOOZE_EVENT, onSnooze);
  }, []);
  return snoozeThreadId === null ? null : (
    <SnoozeDialog threadId={snoozeThreadId} open onOpenChange={(open) => (open ? undefined : setSnoozeThreadId(null))} />
  );
}

// --- thread header action --------------------------------------------------------

function SnoozeHeaderAction({ threadId }: { threadId: string }) {
  const { state } = useFlowState();
  const [open, setOpen] = useState(false);
  const snoozed = state?.snoozes[threadId];
  const label = snoozed
    ? `Snoozed until ${formatWhen(snoozed.until)}`
    : "Snooze thread";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "size-7",
          snoozed ? "text-foreground" : "text-muted-foreground",
        )}
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <Glyph name="alarm" className={cn("size-4", snoozed && "text-amber-500")} />
      </Button>
      <SnoozeDialog threadId={threadId} open={open} onOpenChange={setOpen} />
    </>
  );
}

// --- triage thread list ----------------------------------------------------------

type Group = {
  id: string;
  title: string;
  threads: PluginSidebarThread[];
  defaultCollapsed?: boolean;
  limit?: number;
  action?: { label: string; run: () => void };
  hint?: string;
  dynamic?: { glyph: GlyphName; tone: string };
  /** First of your own sections: draws the "Your sections" divider above it. */
  firstUserGroup?: boolean;
  /** Your section, but the plugin also files matching threads into it. */
  auto?: boolean;
  /** Your section behind this group (null = the unsectioned Active lane). */
  section?: { id: string | null; name: string; isLane: boolean };
};

function ThreadRow({
  thread,
  childrenSummary,
  project,
  active,
  tags,
  snoozeUntil,
  watching,
  waiting,
  createdPrs,
  running,
  now,
  lanes,
  otherSections,
  onNavigate,
  onSnooze,
  onUnsnooze,
  onTag,
  onRename,
  onNewSection,
  machine,
  threadState: stateInfo,
  workspaceState, onWorkspace,
}: {
  thread: PluginSidebarThread;
  childrenSummary?: ReactNode;
  workspaceState: WorkspaceState;
  onWorkspace: (workspaceId: string | null, automatic: boolean) => void;
  project: PluginSidebarProject | undefined;
  /** The machine it runs on; `remote` when it's not the machine BB runs on (tagged on the row). */
  machine: { name: string; remote: boolean } | null;
  /** Its one state and why (none while snoozed), shown as the row's tooltip. */
  threadState?: ThreadStateResult;
  active: boolean;
  tags: readonly string[];
  snoozeUntil: number | undefined;
  watching: FlowState["watching"][string] | undefined;
  waiting: RowWaiting | undefined;
  createdPrs: FlowState["threadPrs"][string] | undefined;
  running: FlowState["running"][string] | undefined;
  now: number;
  lanes: readonly Lane[];
  otherSections: readonly PluginSidebarSection[];
  onNavigate: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onTag: () => void;
  onRename: () => void;
  /** Asks for a name, creates the section and moves this thread into it. */
  onNewSection: () => void;
}) {
  const actions = useSidebarThreadActions();
  const sdk = useSdk();
  const split = useSidebarThreadSplit(thread.id);
  const drag = useContext(DragContext);
  const moveRpc = useRpc<typeof rpcContract>();
  const moveTo = (sectionId: string | null) => {
    void moveRpc.call("thread_move", { threadId: thread.id, sectionId, via: "thread menu" });
  };
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };
  const shortcut = useSidebarThreadShortcut(thread.id);
  const busy = thread.status === "active" || thread.status === "starting";
  const { pullRequest } = useSidebarThreadPullRequest(thread.id);
  const prs = threadPrs(createdPrs, pullRequest);
  const run = busy ? runInfo(running, now) : null;
  // The row's icon wears its state's colour, the same as the filter chip; the glyph and
  // label keep the detail (alert on a failure, rocket on a release watch).
  const detail = rowStatus(thread, busy, watching, prs, run, waiting, now);
  const status = stateInfo
    ? {
        ...detail,
        tone: THREAD_STATE_STYLE[stateInfo.state].tone,
        ...(detail.glyph === "dot" ? { glyph: THREAD_STATE_STYLE[stateInfo.state].glyph } : {}),
      }
    : detail;
  const worst = worstPr(prs);
  const openPrs = prs.filter((pr) => pr.state === "open" || pr.state === "draft");
  const rpc = useRpc<typeof rpcContract>();

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const lane = lanes.find((candidate) => candidate.key === event.key);
    if (lane) {
      event.preventDefault();
      // The row leaves its place; keep the keyboard on the list (inbox style).
      const next = neighbourRowId(event.currentTarget);
      void rpc
        .call("thread_move", { threadId: thread.id, sectionId: lane.sectionId, via: `key ${event.key}` })
        .then(() => focusRowSoon(next));
    } else if (event.key === "e") {
      event.preventDefault();
      focusRowSoon(neighbourRowId(event.currentTarget));
      actions.archive(thread.id);
    } else if (event.key === "s") {
      event.preventDefault();
      onSnooze();
    } else if (event.key === "t") {
      event.preventDefault();
      onTag();
    } else if (event.key === "u") {
      event.preventDefault();
      void actions.setRead(thread.id, thread.isUnread);
    } else if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      const rows = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("[data-jb-flow-row]"),
      );
      const index = rows.indexOf(event.currentTarget);
      rows[index + (event.key === "j" ? 1 : -1)]?.focus();
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <ThreadHoverPreview
          thread={thread}
          projectName={project?.name ?? null}
          machineName={machine ? machineLabel(machine.name) : null}
          sectionName={[...lanes.map((lane) => ({ id: lane.sectionId, name: lane.title })), ...otherSections].find((section) => section.id === thread.sectionId)?.name ?? null}
          status={status}
          tags={tags}
          prs={prs}
          watching={watching}
          snoozeUntil={snoozeUntil}
        >
        <a
          href={thread.href}
          {...split.splitProps}
          onPointerDown={(event) => {
            split.splitProps.onPointerDown?.(event);
            drag.start(thread, event);
          }}
          data-jb-flow-row={thread.id}
          data-thread-state={stateInfo?.state}
          title={stateInfo ? `${THREAD_STATE_LABEL[stateInfo.state]}: ${stateInfo.reason}` : undefined}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            actions.open(thread.id);
            onNavigate();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "jf-thread-row group flex h-7 items-center gap-2 rounded-md pl-6 pr-2 text-sm outline-none",
            "hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-ring",
            active && "bg-accent",
          )}
          style={{
            opacity: drag.dragging?.threadId === thread.id ? 0.4 : 1,
          }}
        >
          <StatusIcon status={status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              thread.isUnread && "font-semibold",
            )}
          >
            <ThreadTitle threadId={thread.id} />
          </span>
          {childrenSummary}
          {tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="shrink-0 text-[10px] text-muted-foreground"
            >
              #{tag}
            </span>
          ))}
          <ProjectChip project={project} />
          {machine?.remote ? (
            <span className="shrink-0 text-[10px] text-muted-foreground" title={`Runs on ${machineLabel(machine.name)}`}>
              {machineShort(machine.name)}
            </span>
          ) : null}
          {run ? (
            <span className={cn("shrink-0 text-[10px] tabular-nums", run.stuck ? "font-medium text-amber-600" : "text-sky-600")}>
              {run.stuck ? `stuck ${duration(run.silent)}` : duration(run.elapsed)}
            </span>
          ) : null}
          {worst ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                window.open(worst.url, "_blank", "noopener");
              }}
              title={prs.map((pr) => `${pr.repo}#${pr.number} · ${attentionLabel(pr.attention)} · ${pr.title}`).join("\n")}
              className={cn("shrink-0 text-[10px] tabular-nums hover:underline", PR_TONE[worst.attention])}
            >
              {prs.length === 1 ? `#${worst.number}` : `${prs.length} PRs`}
            </button>
          ) : null}
          {snoozeUntil !== undefined ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formatWhen(snoozeUntil)}
            </span>
          ) : shortcut ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {shortcut.label}
            </span>
          ) : null}
        </a>
        </ThreadHoverPreview>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem
          onSelect={() => {
            actions.open(thread.id);
            onNavigate();
          }}
        >
          <Icon name="MessageSquare" className="size-4" /> Open
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!split.isAvailable}
          onSelect={() => {
            actions.open(thread.id, { split: true });
            onNavigate();
          }}
        >
          <Icon name="Columns2" className="size-4" /> Open in split view
        </ContextMenuItem>
        {busy ? (
          <ContextMenuItem onSelect={() => void rpc.call("thread_stop", { threadId: thread.id })}>
            <Icon name="Square" className="size-4" /> Stop run{run?.stuck ? ` (silent ${duration(run.silent)})` : ""}
          </ContextMenuItem>
        ) : null}
        {openPrs.length > 0 ? (
          <ContextMenuItem onSelect={() => void rpc.call("thread_watch_ci", { threadId: thread.id })}>
            <Glyph name="hourglass" className="size-4" /> Watch CI ({openPrs.length} open PR{openPrs.length === 1 ? "" : "s"})
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          <Icon name={thread.isPinned ? "PinOff" : "Pin"} className="size-4" />
          {thread.isPinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          <Icon
            name={thread.isUnread ? "MailOpen" : "Mail"}
            className="size-4"
          />
          {thread.isUnread ? "Mark as read" : "Mark as unread"}
          <ContextMenuShortcut>U</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onRename}>
          <Glyph name="pencil" className="size-4" /> Rename…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger><Icon name="Folder" className="size-4" /> Move to workspace</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onSelect={() => onWorkspace(null, true)}>Automatic</ContextMenuItem>
            {workspaceState.workspaces.map((workspace) => <ContextMenuItem key={workspace.id} onSelect={() => onWorkspace(workspace.id, false)}>{workspace.name}</ContextMenuItem>)}
            <ContextMenuItem onSelect={() => onWorkspace(null, false)}>No workspace</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Glyph name="folderMove" className="size-4" /> Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            {lanes.map((lane) => (
              <ContextMenuItem
                key={lane.id}
                disabled={thread.sectionId === lane.sectionId}
                onSelect={() => moveTo(lane.sectionId)}
              >
                {lane.title}
                <ContextMenuShortcut>{lane.key}</ContextMenuShortcut>
              </ContextMenuItem>
            ))}
            {otherSections.length > 0 ? <ContextMenuSeparator /> : null}
            {otherSections.map((section) => (
              <ContextMenuItem
                key={section.id}
                disabled={thread.sectionId === section.id}
                onSelect={() => moveTo(section.id)}
              >
                {section.name}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onNewSection}>
              <Icon name="Plus" className="size-4" /> New section…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {snoozeUntil !== undefined ? (
          <ContextMenuItem onSelect={onUnsnooze}>
            <Glyph name="alarm" className="size-4" /> Wake now
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onSnooze}>
          <Glyph name="alarm" className="size-4" />{" "}
          {snoozeUntil !== undefined ? "Change snooze…" : "Snooze…"}
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={onTag}>
          <Glyph name="tag" className="size-4" /> Tags…
          <ContextMenuShortcut>T</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            copy(new URL(thread.href, window.location.origin).toString())
          }
        >
          <Icon name="Link" className="size-4" /> Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(thread.id)}>
          <Icon name="Copy" className="size-4" /> Copy thread ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.archive(thread.id)}>
          <Icon name="Archive" className="size-4" /> Archive
          <ContextMenuShortcut>E</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.requestDelete(thread.id)}
        >
          <Icon name="Trash2" className="size-4" /> Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function RenameDialog({
  thread,
  onClose,
}: {
  thread: PluginSidebarThread;
  onClose: () => void;
}) {
  const actions = useSidebarThreadActions();
  const [title, setTitle] = useState(thread.title ?? thread.displayTitle);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename thread</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() === "") return;
            void actions.rename(thread.id, title.trim()).then(onClose);
          }}
        >
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Thread title"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={title.trim() === ""}>
            Save
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupHeader({
  title,
  count,
  collapsed,
  onToggle,
  action,
  hint,
  dynamic,
  menu,
  onDragStart,
  auto,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: { label: string; run: () => void };
  /** Shown on hover only, e.g. the lane's move key. */
  hint?: string;
  /** Computed group (not a section you made): accent styling. */
  dynamic?: { glyph: GlyphName; tone: string };
  /** Right-click menu items for this group. */
  menu?: ReactNode;
  /** Makes the header draggable to reorder sections. */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  auto?: boolean;
}) {
  const header = (
    <div data-jb-flow-section-header="" onPointerDown={onDragStart} className="group/header flex w-full items-center gap-1 px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} className="flex min-w-0 flex-1 items-center gap-1.5 hover:text-foreground">
        {dynamic ? (
          <Glyph name={dynamic.glyph} className={cn("size-3.5", dynamic.tone)} />
        ) : (
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3" />
        )}
        <span className={cn("truncate", dynamic && "text-foreground")}>{title}</span>
        {auto ? (
          <span
            title="Fills itself: unfiled threads whose agent is waiting on someone else, or whose open PRs all wait on a reviewer. Threads you move here stay."
            className="rounded border border-border px-1 text-[9px] font-normal uppercase leading-3 tracking-wide text-muted-foreground"
          >
            auto
          </span>
        ) : null}
        {hint ? (
          <kbd className="rounded border border-border px-1 text-[10px] font-normal leading-4 opacity-0 group-hover/header:opacity-100">{hint}</kbd>
        ) : null}
      </button>
      {action ? (
        <button type="button" onClick={action.run} className="jf-group-action rounded px-1 text-[11px] text-foreground/70 opacity-0 hover:bg-accent hover:text-foreground group-hover/header:opacity-100">
          {action.label}
        </button>
      ) : null}
      <span className="tabular-nums">{count}</span>
    </div>
  );
  if (!menu) return header;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function SectionNameDialog({
  initial,
  title,
  onSave,
  onClose,
}: {
  initial: string;
  title: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === "") return;
            onSave(name.trim()).then(onClose, (cause: unknown) => setError(errorText(cause)));
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Section name" autoFocus />
          <Button type="submit" size="sm" disabled={name.trim() === ""}>
            Save
          </Button>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => {
              setPending(true);
              onConfirm().finally(onClose);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- drag threads between sections ---------------------------------------------------
// Pointer-based (not HTML5 drag) so bb's own drag-to-split keeps working: a
// drop inside the sidebar moves the thread; leaving the sidebar cancels ours
// and bb's split gesture takes over.

const DROP_ATTR = "data-jb-drop-section";
const ACTIVE_DROP = "__active";

type DragState = { threadId: string; title: string; x: number; y: number; over: string | null };
const DragContext = createContext<{
  start: (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => void;
  dragging: DragState | null;
}>({ start: () => undefined, dragging: null });

function useThreadDrag(onDrop: (threadId: string, sectionId: string | null) => void) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const start = useCallback(
    (thread: PluginSidebarThread, event: ReactPointerEvent<HTMLElement>) => {
      // A finger on the list is scrolling: dragging is for mouse and pen. Phones
      // reorder from the section menu instead.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.pointerType === "touch") return;
      const nav = event.currentTarget.closest("nav");
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
        }
        const bounds = nav?.getBoundingClientRect();
        if (bounds && (moveEvent.clientX > bounds.right || moveEvent.clientX < bounds.left)) {
          finish(false); // left the sidebar: bb's drag-to-split owns this gesture
          return;
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${DROP_ATTR}]`);
        over = target?.getAttribute(DROP_ATTR) ?? null;
        setDragging({ threadId: thread.id, title: thread.displayTitle, x: moveEvent.clientX, y: moveEvent.clientY, over });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        // Swallow the click that follows the drag so the row doesn't navigate.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onDrop(thread.id, over === ACTIVE_DROP ? null : over);
      };
      const up = () => finish(true);
      // The browser took the gesture (a scroll, a system gesture): end without dropping,
      // so a half-started drag can't finish on the next tap somewhere else.
      const cancel = () => finish(false);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", escape);
    },
    [onDrop],
  );
  return { start, dragging };
}

// --- reorder sections by dragging their header ---------------------------------------

const SECTION_ATTR = "data-jb-section-key";
/** Order key for a section; the unsectioned Active lane has no id. */
const sectionKey = (id: string | null) => id ?? ACTIVE_DROP;

/** Saved order first; sections it doesn't know yet go right after their default predecessor. */
type SectionDragState = { key: string; over: string | null; after: boolean };

function useSectionDrag(onMove: (key: string, target: string, after: boolean) => void) {
  const [dragging, setDragging] = useState<SectionDragState | null>(null);
  const start = useCallback(
    (key: string, event: ReactPointerEvent<HTMLElement>) => {
      // A finger on the list is scrolling: dragging is for mouse and pen. Phones
      // reorder from the section menu instead.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.pointerType === "touch") return;
      const origin = { x: event.clientX, y: event.clientY };
      let active = false;
      let over: string | null = null;
      let after = false;
      const move = (moveEvent: PointerEvent) => {
        if (!active) {
          if (Math.hypot(moveEvent.clientX - origin.x, moveEvent.clientY - origin.y) < 6) return;
          active = true;
          document.body.style.userSelect = "none";
        }
        const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest(`[${SECTION_ATTR}]`);
        const targetKey = target?.getAttribute(SECTION_ATTR) ?? null;
        if (target && targetKey !== null && targetKey !== key) {
          const bounds = target.getBoundingClientRect();
          over = targetKey;
          after = moveEvent.clientY > bounds.top + bounds.height / 2;
        } else {
          over = null;
        }
        setDragging({ key, over, after });
      };
      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", escape);
        setDragging(null);
        if (!active) return;
        document.body.style.userSelect = "";
        // Swallow the click that follows the drag so the header doesn't toggle.
        window.addEventListener("click", (clickEvent) => clickEvent.stopPropagation(), { capture: true, once: true });
        if (drop && over !== null) onMove(key, over, after);
      };
      const up = () => finish(true);
      // The browser took the gesture (a scroll, a system gesture): end without dropping,
      // so a half-started drag can't finish on the next tap somewhere else.
      const cancel = () => finish(false);
      const escape = (keyEvent: globalThis.KeyboardEvent) => {
        if (keyEvent.key === "Escape") finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", escape);
    },
    [onMove],
  );
  return { start, dragging };
}

/** What an idle thread's agent said it waits for (you first), as the row shows it. */
function rowWaiting(state: FlowState | null | undefined, threadId: string): RowWaiting | undefined {
  const asks = state?.awaiting[threadId];
  if (asks !== undefined) return { kind: "asks", since: asks };
  const others = state?.waitingOthers[threadId];
  if (others !== undefined) return { kind: "others", since: others };
  const promised = state?.promised[threadId];
  return promised === undefined ? undefined : { kind: "promised", since: promised };
}

/** An unfiled thread counts as done only after this long without activity. */
const DONE_AFTER_MS = 2 * 3_600_000;

// --- smart filters (computed sets, not your sections) --------------------------------

/** The four thread states (thread-states.ts): every awake thread is in exactly one. */
type SmartId = ThreadStateId;
/** A smart filter, or one machine's threads (`machine:<hostId>`). */
type Filter = SmartId | `machine:${string}`;
const SMART: Array<{ id: SmartId; label: string; glyph: GlyphName; tone: string; hint: string }> = [
  { id: "needs", label: THREAD_STATE_LABEL.needs, glyph: THREAD_STATE_STYLE.needs.glyph, tone: THREAD_STATE_STYLE.needs.tone, hint: "Can't continue without you: a question or prompt, a failure, a red PR nothing watches, or a promise to report back that went quiet for an hour" },
  { id: "running", label: THREAD_STATE_LABEL.running, glyph: THREAD_STATE_STYLE.running.glyph, tone: THREAD_STATE_STYLE.running.tone, hint: "Agents working right now" },
  { id: "autopilot", label: THREAD_STATE_LABEL.autopilot, glyph: THREAD_STATE_STYLE.autopilot.glyph, tone: THREAD_STATE_STYLE.autopilot.tone, hint: "Continues without you: watching CI or a run, a usage-limit reset, will report back, or waiting on someone else" },
  { id: "ready", label: THREAD_STATE_LABEL.ready, glyph: THREAD_STATE_STYLE.ready.glyph, tone: THREAD_STATE_STYLE.ready.tone, hint: "Nothing left for the agent, but work to land: a green PR to ship, or changes not committed or merged yet" },
  { id: "done", label: THREAD_STATE_LABEL.done, glyph: THREAD_STATE_STYLE.done.glyph, tone: THREAD_STATE_STYLE.done.tone, hint: "All work done: nothing pending, nothing left to commit or merge (archive it)" },
  { id: "parked", label: THREAD_STATE_LABEL.parked, glyph: THREAD_STATE_STYLE.parked.glyph, tone: THREAD_STATE_STYLE.parked.tone, hint: "Put aside by you with Park: in no other list until it runs again or you unpark it" },
];

/** "Alex’s Mac Studio" → "Mac Studio". */
export const machineLabel = (name: string) => name.replace(/^[^’']+[’']s\s+/, "");
/** Row-sized: "MacBook Pro" → "MBP", "Mac Studio" → "Studio". */
const machineShort = (name: string) => {
  const label = machineLabel(name);
  if (/^MacBook Pro/i.test(label)) return "MBP";
  return label.replace(/^(MacBook|Mac)\s+/i, "");
};

/** The machine a thread runs on: via its environment, else the server's thread map. */
function threadHost(thread: PluginSidebarThread, machines: FlowState["machines"] | undefined): string | undefined {
  if (!machines) return undefined;
  return (thread.environment?.id ? machines.environmentHosts[thread.environment.id] : undefined) ?? machines.threadHosts[thread.id];
}

const COLLAPSE_KEY = "jb-flow:collapsed";

function useCollapsed(defaults: Record<string, boolean>) {
  const [stored, setStored] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<
        string,
        boolean
      >;
    } catch {
      return {};
    }
  });
  const isCollapsed = (id: string) => stored[id] ?? defaults[id] ?? false;
  const toggle = (id: string) =>
    setStored((current) => {
      const next = {
        ...current,
        [id]: !(current[id] ?? defaults[id] ?? false),
      };
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      return next;
    });
  const reveal = useCallback((ids: readonly string[]) => setStored((current) => {
    if (ids.every((id) => current[id] === false)) return current;
    const next = { ...current, ...Object.fromEntries(ids.map((id) => [id, false])) };
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    return next;
  }), []);
  return { isCollapsed, toggle, reveal };
}

function FilterChip({ hint, active, onClick, glyph, tone, label, count }: {
  hint: string;
  active: boolean;
  onClick: () => void;
  glyph: GlyphName;
  tone: string;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "jf-filter-chip flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors",
        active
          ? "border-foreground/20 bg-accent text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Glyph name={glyph} className={cn("size-3", tone)} />
      <span className="jf-filter-label">{label}</span>
      <span className="jf-filter-count tabular-nums">{count}</span>
    </button>
  );
}

function TriageThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { threads: allThreads, projects, sections: hostSections, status } = useSidebarThreads();
  const { state: workspaceState, ready: workspaceReady, rpc: workspaceRpc, refresh: refreshWorkspaces } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const workspace = workspaceState.workspaces.find((item) => item.id === selectedWorkspace);
  const threads = useMemo(() => allThreads.filter((thread) => inWorkspace(thread, selectedWorkspace, workspaceState, allThreads)), [allThreads, selectedWorkspace, workspaceState]);
  const { rpc, state } = useFlowState();
  // BB saves a section rename but doesn't refresh the sidebar's section list
  // until reload. Show the new name meanwhile; drop it once BB's name changes.
  const [renamed, setRenamed] = useState<Record<string, { from: string; to: string }>>({});
  const sections = useMemo(
    () =>
      hostSections.map((section) => {
        const rename = renamed[section.id];
        return rename && rename.from === section.name ? { ...section, name: rename.to } : section;
      }),
    [hostSections, renamed],
  );
  const now = useNow();
  const [renameTarget, setRenameTarget] = useState<PluginSidebarThread | null>(
    null,
  );
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<string | null>(null);
  const [tagTarget, setTagTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const lanes = useMemo(() => resolveLanes(sections, state?.laneSections), [sections, sectionNames(sections), state?.laneSections]);
  const otherSections = useMemo(() => {
    const laneIds = new Set(lanes.map((lane) => lane.sectionId));
    return sections.filter(
      (section) =>
        !laneIds.has(section.id) && section.id !== state?.snoozedSectionId &&
        (selectedWorkspace === null || workspace?.sectionIds.includes(section.id) || threads.some((thread) => !thread.isArchived && !thread.isHidden && thread.sectionId === section.id)),
    );
  }, [sections, lanes, state?.snoozedSectionId, selectedWorkspace, workspaceState, workspace, threads]);
  const tags = useMemo(() => state?.tags ?? {}, [state]);
  const knownTags = useMemo(
    () => [...new Set(Object.entries(tags).filter(([id]) => threads.some((thread) => thread.id === id)).flatMap(([, values]) => values))].sort(),
    [tags, threads],
  );

  const [smart, setSmart] = useState<Filter | null>(null);
  useEffect(() => { setTagFilter(null); setSmart(null); setExpanded({}); }, [selectedWorkspace]);
  const machines = state?.machines;
  const rowMachine = (thread: PluginSidebarThread) => {
    const hostId = threadHost(thread, machines);
    const host = machines?.hosts.find((candidate) => candidate.id === hostId);
    // Tag rows only when there is more than one machine and we know which one is local.
    const remote = (machines?.hosts.length ?? 0) > 1 && machines?.localHostId != null && host?.id !== machines.localHostId;
    return host ? { name: host.name, remote } : null;
  };
  const [sectionDialog, setSectionDialog] = useState<{ mode: "create" | "rename"; id?: string; name: string; threadId?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown> } | null>(null);
  const sdk = useSdk();
  const actions = useSidebarThreadActions();
  const dropRpc = useRpc<typeof rpcContract>();
  const onDrop = useCallback(
    (threadId: string, sectionId: string | null) => {
      void dropRpc.call("thread_move", { threadId, sectionId, via: "drag" });
    },
    [dropRpc],
  );
  const drag = useThreadDrag(onDrop);

  // Lanes and your own sections share one order, so any section can sit anywhere.
  // It is one order for every view, changed only by the user: a view shows a
  // subset, and every move works on the full order, so a hidden section keeps
  // its place and switching workspace never reshuffles.
  const sectionOrder = state?.sectionOrder;
  const fullOrder = useMemo(() => {
    const laneIds = new Set(lanes.map((lane) => lane.sectionId));
    return mergeOrder(sectionOrder ?? [], [
      ...lanes.map((lane) => sectionKey(lane.sectionId)),
      ...sections.filter((section) => !laneIds.has(section.id) && section.id !== state?.snoozedSectionId).map((section) => section.id),
    ]);
  }, [lanes, sections, sectionOrder, state?.snoozedSectionId]);
  const visibleKeys = useMemo(
    () => new Set([...lanes.map((lane) => sectionKey(lane.sectionId)), ...otherSections.map((section) => section.id)]),
    [lanes, otherSections],
  );
  const sectionKeys = useMemo(() => fullOrder.filter((key) => visibleKeys.has(key)), [fullOrder, visibleKeys]);
  // A section the saved order lacks (new, or never placed) is written into it
  // once, where it shows now, so its place cannot drift later.
  useEffect(() => {
    if (sectionOrder === undefined || sections.length === 0) return;
    if (needsFreeze(sectionOrder, fullOrder)) void rpc.call("section_order_set", { order: fullOrder });
  }, [sectionOrder, fullOrder, sections.length, rpc]);

  const saveOrder = (keys: string[] | null) => {
    if (keys) void rpc.call("section_order_set", { order: keys });
  };
  const moveSection = (key: string, delta: -1 | 1) => saveOrder(stepKey(fullOrder, visibleKeys, key, delta));
  const sectionDrag = useSectionDrag(
    useCallback(
      (key: string, target: string, after: boolean) => saveOrder(dropKey(fullOrder, key, target, after)),
      [fullOrder, rpc],
    ),
  );

  const sectionMenu = (group: Group) => {
    const section = group.section;
    if (!section) return undefined;
    const ids = group.threads.flatMap((thread) => flattenThreadTree([treeNodes.get(thread.id)!]).map((member) => member.id));
    const key = sectionKey(section.id);
    const index = sectionKeys.indexOf(key);
    // The section's project, if set and still there: new threads start in it.
    const projectId = state?.sectionProjects[key];
    const project = projectId ? projectById.get(projectId) : undefined;
    const setProject = (next: string | null) => void rpc.call("section_project_set", { section: key, projectId: next });
    return (
      <>
        <ContextMenuItem
          onSelect={() =>
            actions.openNewThread({
              ...(section.id ? { sectionId: section.id } : {}),
              ...(project ? { projectId: project.id } : workspace?.projectIds[0] ? { projectId: workspace.projectIds[0] } : {}),
              focusPrompt: true,
            })
          }
        >
          <Icon name="Plus" className="size-4" />
          <span className="truncate">{project ? `New thread in ${project.name}` : "New thread here"}</span>
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon name="Folder" className="size-4" /> Project for new threads
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
            <ContextMenuItem onSelect={() => setProject(null)}>
              <span className="flex-1">Whatever is selected</span>
              {!project ? <Icon name="Check" className="size-4" /> : null}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {projects.map((candidate) => (
              <ContextMenuItem key={candidate.id} onSelect={() => setProject(candidate.id)}>
                <span className="flex-1 truncate">{candidate.name}</span>
                {project?.id === candidate.id ? <Icon name="Check" className="size-4" /> : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={ids.length === 0} onSelect={() => ids.forEach((id) => void actions.setRead(id, true))}>
          <Icon name="MailOpen" className="size-4" /> Mark all as read
        </ContextMenuItem>
        <ContextMenuSeparator />
        {section.id !== null ? (
          <ContextMenuItem onSelect={() => setSectionDialog({ mode: "rename", id: section.id!, name: section.name })}>
            <Glyph name="pencil" className="size-4" /> Rename…
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem disabled={index <= 0} onSelect={() => moveSection(sectionKey(section.id), -1)}>
          <Icon name="ArrowUp" className="size-4" /> Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={index === -1 || index >= sectionKeys.length - 1} onSelect={() => moveSection(sectionKey(section.id), 1)}>
          <Icon name="ArrowDown" className="size-4" /> Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={ids.length === 0}
          onSelect={() =>
            setConfirm({
              title: `Archive ${ids.length} thread${ids.length === 1 ? "" : "s"}?`,
              body: `Everything in ${section.name} will be archived. You can unarchive threads later.`,
              label: "Archive all",
              run: () => rpc.call("archive", { threadIds: ids }),
            })
          }
        >
          <Icon name="Archive" className="size-4" /> Archive all threads…
        </ContextMenuItem>
        {!section.isLane && section.id !== null ? (
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() =>
              setConfirm({
                title: `Delete "${section.name}"?`,
                body: `The section is removed and its ${ids.length} thread${ids.length === 1 ? "" : "s"} move back to Unassigned. Threads are not deleted.`,
                label: "Delete section",
                run: () => sdk.threadSections.delete({ id: section.id! }),
              })
            }
          >
            <Icon name="Trash2" className="size-4" /> Delete section…
          </ContextMenuItem>
        ) : null}
      </>
    );
  };

  const { groups, smartCounts, machineCounts, treeNodes } = useMemo(() => {
    const snoozedSectionId = state?.snoozedSectionId ?? null;
    const visible = threads
      .filter((thread) => !thread.isHidden && !thread.isArchived)
      .sort((a, b) => b.createdAt - a.createdAt);
    // No Snoozed section until the first snooze: then nothing is snoozed (a null
    // sectionId is "unsectioned", not "in a missing section").
    const isSnoozed = (thread: PluginSidebarThread) => snoozedSectionId !== null && thread.sectionId === snoozedSectionId;
    const matchesTag = (thread: PluginSidebarThread) => tagFilter === null || (tags[thread.id] ?? []).includes(tagFilter);
    const snoozedTree = filterThreadTree(buildThreadTree(visible.filter(isSnoozed)), matchesTag);
    const awakeTree = filterThreadTree(buildThreadTree(visible.filter((thread) => !isSnoozed(thread))), matchesTag);
    const allAwake = flattenThreadTree(awakeTree).filter(matchesTag);

    const now = Date.now();
    const stateOf = (thread: PluginSidebarThread) => threadState(thread, state, now).state;
    const openPrs = (thread: PluginSidebarThread) =>
      threadPrs(state?.threadPrs[thread.id], null).filter((pr) => pr.state === "open" || pr.state === "draft");
    const sets = Object.fromEntries(
      SMART.map((entry) => [entry.id, (thread: PluginSidebarThread) => stateOf(thread) === entry.id]),
    ) as Record<SmartId, (thread: PluginSidebarThread) => boolean>;
    // Ready threads that are finished, for Archive all: unfiled (anything you put in
    // a section stays there), every PR settled, quiet for a while, and not open.
    const finished = (thread: PluginSidebarThread) =>
      thread.sectionId === null &&
      thread.id !== activeThreadId &&
      now - thread.updatedAt > DONE_AFTER_MS &&
      sets.ready(thread) &&
      allSettled(threadPrs(state?.threadPrs[thread.id], null));
    const smartCounts = Object.fromEntries(
      SMART.map((entry) => [entry.id, allAwake.filter(sets[entry.id]).length]),
    ) as Record<SmartId, number>;
    // Archive cascades beyond the current filter/workspace. Check the complete
    // family, including hidden and snoozed descendants, before offering it.
    const fullTree = indexThreadTree(buildThreadTree(allThreads.filter((thread) => !thread.isArchived)));
    const finishedRoots = new Set(
      awakeTree.filter((node) => flattenThreadTree([fullTree.get(node.thread.id)!]).every(finished)).map((node) => node.thread.id),
    );
    const machineCounts = new Map<string, number>();
    for (const thread of allAwake) {
      const host = threadHost(thread, machines);
      if (host) machineCounts.set(host, (machineCounts.get(host) ?? 0) + 1);
    }

    const selectedTree = smart?.startsWith("machine:")
        ? filterThreadTree(awakeTree, (thread) => threadHost(thread, machines) === smart.slice("machine:".length))
        : smart !== null ? filterThreadTree(awakeTree, sets[smart as SmartId]) : awakeTree;
    const treeNodes = indexThreadTree([...selectedTree, ...snoozedTree]);
    const awake = selectedTree.map((node) => node.thread);
    const snoozed = snoozedTree.map((node) => node.thread);

    // One machine's threads, across every section.
    if (smart?.startsWith("machine:")) {
      const hostId = smart.slice("machine:".length);
      const host = machines?.hosts.find((candidate) => candidate.id === hostId);
      return {
        treeNodes,
        smartCounts,
        machineCounts,
        groups: [
          {
            id: smart,
            title: `On ${host ? machineLabel(host.name) : "machine"}`,
            threads: awake,
            dynamic: { glyph: "terminal", tone: "text-slate-400" },
          },
        ] satisfies Group[],
      };
    }

    // A smart filter keeps your sections and shows only the matching threads in
    // each (fork: stable-created-order). "Ready" keeps a flat list so Archive all
    // still has one place to act on.
    if (smart !== null && smart !== "ready") {
      const entry = SMART.find((candidate) => candidate.id === smart)!;
      const members = awake;
      const inSection = (key: string, thread: PluginSidebarThread) => sectionKey(thread.sectionId) === key;
      const filtered: Group[] = [];
      for (const key of sectionKeys) {
        const lane = lanes.find((candidate) => sectionKey(candidate.sectionId) === key);
        const section = lane ? null : otherSections.find((candidate) => candidate.id === key);
        if (!lane && !section) continue;
        const threadsHere = members.filter((thread) => inSection(key, thread));
        if (threadsHere.length === 0) continue;
        filtered.push({
          id: lane ? `lane:${lane.id}` : `section:${section!.id}`,
          title: lane ? lane.title : section!.name,
          threads: threadsHere,
          section: lane ? { id: lane.sectionId, name: lane.title, isLane: true } : { id: section!.id, name: section!.name, isLane: false },
        });
      }
      const placed = new Set(filtered.flatMap((group) => group.threads.map((thread) => thread.id)));
      const loose = members.filter((thread) => !placed.has(thread.id));
      if (loose.length > 0) filtered.unshift({ id: `smart:${smart}`, title: entry.label, threads: loose, dynamic: { glyph: entry.glyph, tone: entry.tone } });
      return { smartCounts, machineCounts, groups: filtered, treeNodes };
    }

    // Ready: green PRs to ship first, then finished threads with Archive all
    // (only those that qualify: unfiled, settled, quiet; never the open thread).
    if (smart !== null) {
      const toShip = awake.filter((thread) => openPrs(thread).some((pr) => pr.attention === "ready_to_merge"));
      const rest = awake.filter((thread) => !toShip.includes(thread));
      const archivable = rest.filter((thread) => finishedRoots.has(thread.id));
      const groups: Group[] = [];
      if (toShip.length > 0)
        groups.push({ id: "smart:ready-ship", title: "Ready to ship", threads: toShip, dynamic: { glyph: "pr", tone: "text-green-500" } });
      groups.push({
        id: "smart:ready",
        title: toShip.length > 0 ? "Finished" : THREAD_STATE_LABEL.ready,
        threads: rest,
        dynamic: { glyph: "check", tone: "text-green-500" },
        action:
          archivable.length > 0
            ? {
                label: archivable.length === rest.length ? "Archive all" : `Archive ${archivable.length} settled`,
                run: () => void rpc.call("archive", { threadIds: archivable.map((thread) => thread.id) }),
              }
            : undefined,
      });
      return { treeNodes, smartCounts, machineCounts, groups };
    }

    // Waiting on someone else: the agent said so, or every open PR waits on a reviewer.
    // Only unfiled threads move automatically; your own sections stay as you set them.
    const waitsOnOthers = (thread: PluginSidebarThread) => {
      if (thread.sectionId !== null || !sets.autopilot(thread)) return false;
      if (state?.waitingOthers[thread.id] !== undefined) return true;
      const open = openPrs(thread);
      return open.length > 0 && open.every((pr) => pr.attention === "review_requested");
    };
    const waitingLane = lanes.find((lane) => lane.id === "waiting");
    // Fork (stable-created-order): threads stay in their own section like in
    // Conductor. Needs me, Stalled and Done are the counters' filters, not
    // groups that pull threads out of their sections.
    const pinned = awake.filter((thread) => thread.isPinned);
    const rest = awake.filter((thread) => !thread.isPinned);

    const result: Group[] = [];
    if (pinned.length > 0) result.push({ id: "pinned", title: "Pinned", threads: pinned });
    for (const key of sectionKeys) {
      const lane = lanes.find((candidate) => sectionKey(candidate.sectionId) === key);
      if (lane) {
        result.push({
          id: `lane:${lane.id}`,
          title: lane.title,
          hint: lane.key,
          threads: rest.filter((thread) =>
            lane.id === "waiting"
              ? thread.sectionId === lane.sectionId || waitsOnOthers(thread)
              : lane.id === "active"
                ? thread.sectionId === null && !(waitingLane && waitsOnOthers(thread))
                : thread.sectionId === lane.sectionId,
          ),
          ...(lane.id === "waiting" ? { auto: true } : {}),
          defaultCollapsed: lane.id === "low" || lane.id === "later",
          limit: lane.id === "active" ? 25 : 15,
          section: { id: lane.sectionId, name: lane.title, isLane: true },
        });
        continue;
      }
      const section = otherSections.find((candidate) => candidate.id === key);
      if (!section) continue;
      result.push({
        id: `section:${section.id}`,
        title: section.name,
        threads: rest.filter((thread) => thread.sectionId === section.id),
        defaultCollapsed: true,
        section: { id: section.id, name: section.name, isLane: false },
      });
    }
    const firstUser = result.find((group) => group.section !== undefined);
    if (firstUser) firstUser.firstUserGroup = true;
    result.push({
      id: "snoozed",
      title: "Snoozed",
      threads: snoozed.sort((a, b) => (state?.snoozes[a.id]?.until ?? 0) - (state?.snoozes[b.id]?.until ?? 0)),
      defaultCollapsed: true,
      dynamic: { glyph: "alarm", tone: "text-muted-foreground" },
    });
    return { groups: result, smartCounts, machineCounts, treeNodes };
  }, [threads, allThreads, sections, lanes, otherSections, state, tags, tagFilter, smart, rpc, sectionKeys, activeThreadId, machines]);

  const defaults = useMemo(
    () =>
      Object.fromEntries([
        ...groups.map((group) => [group.id, group.defaultCollapsed ?? false]),
        ...Array.from(treeNodes.values(), (node) => [`thread:${node.thread.id}`, true]),
      ]),
    [groups, treeNodes],
  );
  const { isCollapsed, toggle, reveal } = useCollapsed(defaults);
  const activePath = groups.flatMap((group) => group.threads.flatMap((thread) => {
    const node = treeNodes.get(thread.id)!;
    if (!flattenThreadTree([node]).some((item) => item.id === activeThreadId)) return [];
    return [group.id, ...Array.from(treeNodes.values())
      .filter((candidate) => flattenThreadTree([candidate]).some((item) => item.id === activeThreadId))
      .map((candidate) => `thread:${candidate.thread.id}`)];
  })).join("\n");
  useEffect(() => { if (activePath) reveal(activePath.split("\n")); }, [activeThreadId, activePath, reveal]);

  if (status === "loading" || (!workspaceReady && selectedWorkspace !== null)) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Loading threads…
      </p>
    );
  }

  return (
    <DragContext.Provider value={drag}>
    <nav
      aria-label="Triage"
      className="jf-triage flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-4"
    >
      <div className="jf-triage-heading"><span>Threads</span>
        {smart !== null && <button type="button" onClick={() => setSmart(null)}>Clear filter</button>}
        <span className="jf-triage-keyboard" title="Keys on a focused row: 1–5 move to lane · s snooze · t tag · e archive · u unread · j/k move"><Icon name="Info" className="size-3" /></span>
      </div>
      <div className="jf-triage-filters">
        {SMART.filter((entry) => entry.id === "needs" || smartCounts[entry.id] > 0 || smart === entry.id).map((entry) => (
          <FilterChip
            key={entry.id}
            hint={entry.hint}
            active={smart === entry.id}
            onClick={() => setSmart((current) => (current === entry.id ? null : entry.id))}
            glyph={entry.glyph}
            tone={entry.tone}
            label={entry.label}
            count={smartCounts[entry.id]}
          />
        ))}
      </div>
      {(machines?.hosts.length ?? 0) > 1 && (
        <details className="jf-machine-filters" key={smart?.startsWith("machine:") ? "selected-machine" : "machines"}
          open={smart?.startsWith("machine:") ? true : undefined}>
          <summary><Icon name="Terminal" className="size-3.5" /><span>Machines</span><Icon name="ChevronDown" className="size-3" /></summary>
          <div className="jf-triage-filters">
        {(machines?.hosts.length ?? 0) > 1
          ? machines!.hosts
              .filter((host) => (machineCounts.get(host.id) ?? 0) > 0 || smart === `machine:${host.id}`)
              .map((host) => {
                const id = `machine:${host.id}` as const;
                return (
                  <FilterChip
                    key={id}
                    hint={`Threads running on ${machineLabel(host.name)}${host.connected ? "" : " (offline)"}`}
                    active={smart === id}
                    onClick={() => setSmart((current) => (current === id ? null : id))}
                    glyph="terminal"
                    tone={host.connected ? "text-slate-400" : "text-slate-400/40"}
                    label={machineLabel(host.name)}
                    count={machineCounts.get(host.id) ?? 0}
                  />
                );
              })
          : null}
          </div>
        </details>
      )}
      {knownTags.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-2 pt-1">
          {knownTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setTagFilter((current) => (current === tag ? null : tag))}
              className={cn(
                "rounded-full border px-2 text-[10px] leading-4",
                tagFilter === tag
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}
      {/* Before the groups: a new install has no sections, so no "Your sections" divider to hang it on. */}
      <MissingLanesHint sections={sections} pinned={state?.laneSections ?? {}} />
      {groups.map((group) => {
        const keepEmpty =
          group.id === "needs-me" || group.id.startsWith("smart:") || group.id.startsWith("section:") || group.firstUserGroup;
        if (group.threads.length === 0 && !keepEmpty) return null;
        const collapsed = group.id.startsWith("smart:") ? false : isCollapsed(group.id);
        const activeIndex = group.threads.findIndex((thread) => flattenThreadTree([treeNodes.get(thread.id)!]).some((item) => item.id === activeThreadId));
        const limit = expanded[group.id] ? Infinity : Math.max(group.limit ?? Infinity, activeIndex + 1);
        return (
          <section
            key={group.id}
            {...(group.section ? { [DROP_ATTR]: sectionKey(group.section.id), [SECTION_ATTR]: sectionKey(group.section.id) } : {})}
            className={cn(
              "relative rounded-md transition-colors",
              group.section && drag.dragging && drag.dragging.over === sectionKey(group.section.id) && "bg-accent/70 ring-1 ring-ring/40",
              group.section && sectionDrag.dragging?.key === sectionKey(group.section.id) && "opacity-40",
            )}
          >
            {group.section && sectionDrag.dragging?.over === sectionKey(group.section.id) ? (
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-primary",
                  sectionDrag.dragging.after ? "-bottom-px" : "top-0",
                )}
              />
            ) : null}
            {group.firstUserGroup ? (
              <div className="jf-sections-divider group/divider mx-2 mt-6 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Your sections
                <span className="h-px flex-1 bg-border" />
                <button
                  type="button"
                  onClick={() => setSectionDialog({ mode: "create", name: "" })}
                  className="rounded px-1 normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="New section"
                >
                  + New section
                </button>
              </div>
            ) : null}
            <GroupHeader
              title={group.title}
              count={group.threads.length}
              collapsed={collapsed}
              onToggle={() => toggle(group.id)}
              action={group.action}
              hint={group.hint}
              dynamic={group.dynamic}
              menu={sectionMenu(group)}
              auto={group.auto}
              {...(group.section && !smart ? { onDragStart: (event: ReactPointerEvent<HTMLElement>) => sectionDrag.start(sectionKey(group.section!.id), event) } : {})}
            />
            {collapsed ? null : group.threads.length === 0 ? (
              <p className="py-1 pl-6 pr-2 text-xs text-muted-foreground">
                {group.id === "needs-me" ? "You’re all caught up." : "No threads yet."}
              </p>
            ) : (
              <>
                <ul className="jf-thread-tree" aria-label={group.title}>
                  {group.threads.slice(0, limit).map((root) => (
                    <ThreadBranch
                      key={root.id}
                      node={treeNodes.get(root.id)!}
                      isCollapsed={isCollapsed}
                      toggle={toggle}
                      needsAttention={(thread) => threadState(thread, state, now).state === "needs"}
                      filtered={smart !== null || tagFilter !== null}
                      renderRow={(thread, childrenSummary) => (
                        <ThreadRow
                          key={thread.id}
                          thread={thread}
                          childrenSummary={childrenSummary}
                          workspaceState={workspaceState}
                          onWorkspace={(workspaceId, automatic) => void workspaceRpc.call("workspace_assign", { threadId: thread.id, workspaceId, automatic }).then(refreshWorkspaces).catch((cause) => toast.error(errorText(cause)))}
                          project={projectById.get(thread.projectId)}
                          active={thread.id === activeThreadId}
                          tags={tags[thread.id] ?? []}
                          snoozeUntil={state?.snoozes[thread.id]?.until}
                          watching={state?.watching[thread.id]}
                          waiting={rowWaiting(state, thread.id)}
                          createdPrs={state?.threadPrs[thread.id]}
                          running={state?.running[thread.id]}
                          now={now}
                          lanes={lanes}
                          otherSections={otherSections}
                          onNavigate={onNavigate}
                          onSnooze={() => setSnoozeTarget(thread.id)}
                          onUnsnooze={() =>
                            void rpc.call("unsnooze", { threadId: thread.id })
                          }
                          onTag={() => setTagTarget(thread.id)}
                          onRename={() => setRenameTarget(thread)}
                          onNewSection={() => setSectionDialog({ mode: "create", name: "", threadId: thread.id })}
                          machine={rowMachine(thread)}
                          threadState={group.id === "snoozed" ? undefined : threadState(thread, state, now)}
                        />
                      )}
                    />
                  ))}
                </ul>
                {group.threads.length > limit ? (
                  <button
                    type="button"
                    className="py-1 pl-6 pr-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setExpanded((current) => ({
                        ...current,
                        [group.id]: true,
                      }))
                    }
                  >
                    Show {group.threads.length - limit} more
                  </button>
                ) : null}
              </>
            )}
          </section>
        );
      })}
      {snoozeTarget === null ? null : (
        <SnoozeDialog
          threadId={snoozeTarget}
          open
          onOpenChange={(open) => (open ? undefined : setSnoozeTarget(null))}
        />
      )}
      {sectionDialog === null ? null : (
        <SectionNameDialog
          title={sectionDialog.mode === "create" ? "New section" : "Rename section"}
          initial={sectionDialog.name}
          onSave={(name) =>
            sectionDialog.mode === "create"
              ? sdk.threadSections.create({ name }).then(async (section) => {
                  if (workspace) {
                    await workspaceRpc.call("workspace_save", { ...workspace, sectionIds: [...workspace.sectionIds, section.id] });
                    await refreshWorkspaces();
                  }
                  if (sectionDialog.threadId) await dropRpc.call("thread_move", { threadId: sectionDialog.threadId, sectionId: section.id, via: "new section" });
                  return section;
                })
              : sdk.threadSections.update({ id: sectionDialog.id!, name }).then((result) => {
                  const from = hostSections.find((section) => section.id === sectionDialog.id)?.name;
                  if (from !== undefined) setRenamed((current) => ({ ...current, [sectionDialog.id!]: { from, to: name } }));
                  return result;
                })
          }
          onClose={() => setSectionDialog(null)}
        />
      )}
      {confirm === null ? null : (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
        />
      )}
      {renameTarget === null ? null : (
        <RenameDialog
          thread={renameTarget}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {tagTarget === null ? null : (
        <TagDialog
          threadId={tagTarget}
          tags={tags[tagTarget] ?? []}
          knownTags={knownTags}
          onClose={() => setTagTarget(null)}
        />
      )}
      {drag.dragging ? (
        <div
          className="pointer-events-none fixed z-50 max-w-64 truncate rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: drag.dragging.x + 12, top: drag.dragging.y + 8 }}
        >
          {drag.dragging.title}
          <span className="ml-1 text-muted-foreground">{drag.dragging.over ? "→ drop to move" : ""}</span>
        </div>
      ) : null}
    </nav>
    </DragContext.Provider>
  );
}

// --- homepage digest ---------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="jf-empty-state rounded-lg border border-border px-4 py-5 text-center text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

function DigestSection() {
  const { state: workspaceState } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const { threads: workspaceThreads } = useSidebarThreads();
  const rpc = useRpc<typeof rpcContract>();
  const actions = useSidebarThreadActions();
  const { projects } = useSidebarThreads();
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const [digest, setDigest] = useState<{
    generatedAt: number;
    items: DigestItem[];
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      if (refresh) setPending(true);
      rpc
        .call("digest_list", { refresh })
        .then(
          (result) => {
            setDigest(result);
            setSelected((current) => {
              const ids = new Set(result.items.map((item) => item.threadId));
              return new Set([...current].filter((id) => ids.has(id)));
            });
            setError(null);
          },
          (cause: unknown) => setError(errorText(cause)),
        )
        .finally(() => {
          if (refresh) setPending(false);
        });
    },
    [rpc],
  );
  useEffect(() => load(false), [load]);
  useRealtime("jb-flow-changed", () => load(false));

  const act = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      setSelected(new Set());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => { setSelected(new Set()); setShowAll(false); }, [selectedWorkspace]);
  const items = (digest?.items ?? []).filter((item) => {
    const thread = workspaceThreads.find((thread) => thread.id === item.threadId);
    return selectedWorkspace === null || (thread !== undefined && inWorkspace(thread, selectedWorkspace, workspaceState, workspaceThreads));
  });
  const ids = items.filter((item) => selected.has(item.threadId)).map((item) => item.threadId);
  const shown = showAll ? items : items.slice(0, 15);
  const allSelected =
    items.length > 0 && items.every((item) => selected.has(item.threadId));
  const toggleOne = (threadId: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(threadId);
      else next.delete(threadId);
      return next;
    });

  return (
    <div className="jf-home jf-digest space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {digest === null
            ? "Loading…"
            : `${items.length} idle thread${items.length === 1 ? "" : "s"} without a section · updated ${formatWhen(digest.generatedAt)}`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => load(true)}
          >
            <Icon name="RotateCcw" className="size-3.5" /> Refresh
          </Button>
          {ids.length > 0 && <><Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              act(() => rpc.call("digest_keep", { threadIds: ids, days: 14 }))
            }
          >
            Keep 14d
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() =>
              act(() =>
                Promise.all(
                  ids.map((threadId) =>
                    rpc.call("snooze", { threadId, when: "1w", note: null, until: parseWhen("1w") }),
                  ),
                ),
              )
            }
          >
            Snooze 1w
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending || ids.length === 0}
            onClick={() => act(() => rpc.call("archive", { threadIds: ids }))}
          >
            Archive{ids.length > 0 ? ` ${ids.length}` : ""}
          </Button></>}
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {digest === null ? null : items.length === 0 ? (
        <EmptyState>No stale threads.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          <li className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked === true
                    ? new Set(items.map((item) => item.threadId))
                    : new Set(),
                )
              }
              aria-label="Select all"
            />
            Select all
          </li>
          {shown.map((item) => (
            <li
              key={item.threadId}
              className="flex items-start gap-3 px-3 py-2 text-sm"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.has(item.threadId)}
                onCheckedChange={(checked) =>
                  toggleOne(item.threadId, checked === true)
                }
                aria-label={`Select "${item.title}"`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="truncate text-left font-medium hover:underline"
                    onClick={() => actions.open(item.threadId)}
                  >
                    {item.title}
                  </button>
                  <ProjectChip project={projectById.get(item.projectId)} />
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.idleDays}d
                  </span>
                </div>
                {item.summary ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
          {items.length > shown.length ? (
            <li className="px-3 py-2">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAll(true)}
              >
                Show all {items.length}
              </button>
            </li>
          ) : null}
        </ul>
      )}
      <LeftoversBlock />
    </div>
  );
}

// --- settings: area-section → tag migration ---------------------------------------

// Worktree checkouts bb no longer tracks (see leftovers.ts). Shown only when there are some.
function LeftoversBlock() {
  const rpc = useRpc<typeof rpcContract>();
  const [report, setReport] = useState<{ checkedAt: number; items: Leftover[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("leftovers_get", { refresh: false }).then(setReport, (cause: unknown) => setError(errorText(cause)));
  }, [rpc]);
  if (!report || report.items.length === 0) return error ? <p className="text-sm text-destructive">{error}</p> : null;
  const safe = report.items.filter((item) => item.safe);
  return (
    <details className="jf-leftovers space-y-2">
      <summary><Icon name="FolderGit" className="size-4" /><span>Worktree cleanup</span><span>{report.items.length} checkouts</span><Icon name="ChevronDown" className="size-3" /></summary>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">Leftover worktrees</span>
        <span className="text-muted-foreground">
          {report.items.length} checkout(s) bb no longer tracks · checked {formatWhen(report.checkedAt)}
        </span>
        {safe.length > 0 ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setConfirming(true)}>
            Delete {safe.length} merged
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-xs">
        {report.items.map((item) => (
          <li key={item.path} className="flex items-center gap-2 px-3 py-1.5" title={item.path}>
            <span className="font-medium">{item.repo}</span>
            <span className="truncate text-muted-foreground">{item.branch}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {[item.pr ? `${item.pr} ${item.prState}` : "no PR", item.dirty ? `${item.dirty} uncommitted` : null, item.nodeModules ? "node_modules" : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {item.safe ? null : <span className="shrink-0 text-amber-600">keep</span>}
          </li>
        ))}
      </ul>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {confirming ? (
        <ConfirmDialog
          title={`Delete ${safe.length} leftover checkout(s)?`}
          body="Only checkouts whose PR is merged (or that have no commits of their own) and that have no uncommitted changes are removed. Branches stay on GitHub."
          confirmLabel="Delete"
          onConfirm={() => rpc.call("leftovers_clean", null).then(() => rpc.call("leftovers_get", { refresh: false }).then(setReport))}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </details>
  );
}

const LANES_HINT_KEY = "jb-flow:lanes-hint-hidden";

/** New installs have no lane sections; say so once, with a one-click fix. */
function MissingLanesHint({ sections, pinned }: { sections: readonly PluginSidebarSection[]; pinned: LaneSections }) {
  const sdk = useSdk();
  const [hidden, setHidden] = useState(() => localStorage.getItem(LANES_HINT_KEY) === "1");
  const [pending, setPending] = useState(false);
  const matched = matchLanes(sections, pinned);
  const missing = (Object.keys(LANE_NAMES) as LaneId[]).filter((lane) => !matched[lane]);
  if (hidden || missing.length === 0) return null;
  return (
    <div className="mx-2 mt-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
      {missing.length === 4 ? "No lane sections yet" : `Missing lanes: ${missing.map((lane) => LANE_NAMES[lane]).join(", ")}`}. Number keys
      move a thread into a lane.
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          disabled={pending}
          className="rounded px-1 text-foreground hover:bg-accent"
          onClick={async () => {
            setPending(true);
            try {
              for (const lane of missing) await sdk.threadSections.create({ name: LANE_NAMES[lane] });
            } finally {
              setPending(false);
            }
          }}
        >
          Create {missing.length === 1 ? "it" : "them"}
        </button>
        <button
          type="button"
          className="rounded px-1 hover:bg-accent"
          onClick={() => {
            localStorage.setItem(LANES_HINT_KEY, "1");
            setHidden(true);
          }}
        >
          Hide
        </button>
      </div>
    </div>
  );
}

function LaneSettings() {
  const sdk = useSdk();
  const { state } = useFlowState();
  const { sections } = useSidebarThreads();
  const matched = matchLanes(sections, state?.laneSections ?? {});
  const missing = (Object.keys(LANE_NAMES) as LaneId[]).filter((lane) => !matched[lane]);
  const [pending, setPending] = useState(false);
  return (
    <div className="jf-settings space-y-3 text-sm">
      <p className="text-muted-foreground">
        The Triage list's lanes (keys 1, 3, 4 and 5) are sections named Priority, Waiting for others, Pick up later and
        Low priority. Unassigned (key 2) is always there. Rename a lane's section later and it keeps its role.
      </p>
      {missing.length === 0 ? (
        <p>All lanes have a section.</p>
      ) : (
        <Button
          size="sm"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              for (const lane of missing) await sdk.threadSections.create({ name: LANE_NAMES[lane] });
            } finally {
              setPending(false);
            }
          }}
        >
          Create {missing.map((lane) => LANE_NAMES[lane]).join(", ")}
        </Button>
      )}
    </div>
  );
}

function MigrationSettings() {
  const { rpc, state } = useFlowState();
  const { sections } = useSidebarThreads();
  const lanes = useMemo(() => resolveLanes(sections, state?.laneSections), [sections, sectionNames(sections), state?.laneSections]);
  const laneIds = new Set(lanes.map((lane) => lane.sectionId));
  const candidates = sections.filter(
    (section) =>
      !laneIds.has(section.id) &&
      section.id !== state?.snoozedSectionId,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="jf-settings space-y-3 text-sm">
      <p className="text-muted-foreground">
        Turn "area" sections into tags. Their threads get the tag and move to
        the Unassigned lane, so one thread can be both #Commercial and Waiting. The
        sections themselves are kept.
      </p>
      <div className="space-y-1.5">
        {candidates.map((section) => (
          <label key={section.id} className="flex items-center gap-2">
            <Checkbox
              checked={selected.has(section.id)}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(section.id);
                  else next.delete(section.id);
                  return next;
                })
              }
            />
            {section.name}
          </label>
        ))}
      </div>
      <Button
        size="sm"
        disabled={pending || selected.size === 0}
        onClick={async () => {
          setPending(true);
          try {
            const { tagged } = await rpc.call("migrate_areas", {
              sectionIds: [...selected],
              moveToSectionId: null,
            });
            setResult(`Tagged and moved ${tagged} thread(s).`);
            setSelected(new Set());
          } catch (cause) {
            setResult(errorText(cause));
          } finally {
            setPending(false);
          }
        }}
      >
        Convert to tags
      </Button>
      {result === null ? null : (
        <p className="text-muted-foreground">{result}</p>
      )}
    </div>
  );
}

// --- focus reporter ------------------------------------------------------------------
// Tells the server which thread this window has focused, so `bb jb-flow focused`
// (used by the Stream Deck) can target it. Split layouts report the focused pane.

/** RPC client for command-palette handlers, which run outside React. */
let commandRpc: ReturnType<typeof useRpc<typeof rpcContract>> | null = null;
/** The Catch up setting, for the command's availability check (it can't use hooks). */
let catchUpEnabled = false;
const SNOOZE_EVENT = "jb-flow:snooze";

function FocusReporter() {
  const rpc = useRpc<typeof rpcContract>();
  commandRpc = rpc;
  const { threadId: routeThreadId } = useBbContext();
  const split = useSidebarSplitLayout();
  const threadId = split?.panes.find((pane) => pane.isFocused)?.threadId ?? routeThreadId;
  const [clientId] = useState(() => {
    const existing = sessionStorage.getItem("jb-flow:client");
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem("jb-flow:client", created);
    return created;
  });

  const interactedAt = useRef(0);
  useEffect(() => {
    const send = () => {
      void rpc
        .call("focus_report", {
          clientId,
          threadId,
          windowFocused: document.hasFocus(),
          interactedAt: interactedAt.current,
          origin: location.origin,
          userAgent: navigator.userAgent.slice(0, 300),
        })
        .catch(() => undefined);
    };
    // The window you last physically used wins, so report interactions promptly
    // (throttled: at most one extra report per 5s).
    let lastSent = 0;
    const interact = () => {
      interactedAt.current = Date.now();
      if (Date.now() - lastSent > 5_000) {
        lastSent = Date.now();
        send();
      }
    };
    for (const type of ["pointerdown", "keydown", "pointermove", "wheel"] as const) {
      window.addEventListener(type, interact, { passive: true, capture: true });
    }
    send();
    window.addEventListener("focus", send);
    window.addEventListener("blur", send);
    document.addEventListener("visibilitychange", send);
    // Keep reporting while BB is in the background too: deck keys are pressed
    // while other apps have focus.
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === "visible") send();
    }, 60_000);
    return () => {
      for (const type of ["pointerdown", "keydown", "pointermove", "wheel"] as const) {
        window.removeEventListener(type, interact, { capture: true });
      }
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
      document.removeEventListener("visibilitychange", send);
      window.clearInterval(heartbeat);
    };
  }, [rpc, clientId, threadId]);
  return null;
}

// --- plan review banners -----------------------------------------------------------
// BB renders a plan awaiting approval in a banner that starts collapsed, caps its
// body at min(32rem, 50dvh) and sizes the banner to the space left in the thread.
// Core renderers can't be replaced, so this content script expands each banner
// once when it appears (a manual collapse sticks) and lets it take ~75% of the
// window with a single scroll area, resizable by dragging. Selectors are BB's own test ids.

// Only with the "Expand plan reviews" setting on: CommandHost sets this flag on <html>.
const EXPAND_PLANS_FLAG = "jbFlowExpandPlans";
const PLAN_BANNER = 'html[data-jb-flow-expand-plans] section[data-testid="plan-review-banner"]';
// The plan's height, set by dragging the handle on top of the banner (the
// banner sits above the composer, so it grows upwards). Remembered per browser.
const PLAN_HEIGHT_VAR = "--jf-plan-height";
const PLAN_HEIGHT_KEY = "jb-flow-plan-height";
const PLAN_STYLE = `
${PLAN_BANNER}[data-expanded] {
  position: relative;
  max-height: calc(var(${PLAN_HEIGHT_VAR}, 75dvh) + 5dvh) !important;
}
${PLAN_BANNER} .overflow-y-auto:has([data-testid="plan-review-request"]) {
  max-height: var(${PLAN_HEIGHT_VAR}, 75dvh) !important;
}
${PLAN_BANNER} .jf-plan-resize {
  position: absolute;
  z-index: 2;
  top: -5px;
  left: 0;
  right: 0;
  height: 10px;
  cursor: ns-resize;
  touch-action: none;
}
${PLAN_BANNER} .jf-plan-resize::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 50%;
  width: 36px;
  height: 4px;
  margin-left: -18px;
  border-radius: 999px;
  background: var(--border);
}
${PLAN_BANNER} .jf-plan-resize:hover::after,
${PLAN_BANNER} .jf-plan-resize[data-dragging]::after {
  background: var(--muted-foreground);
}
/* The plan body itself doesn't scroll; the banner body does. */
${PLAN_BANNER} [data-testid="plan-review-request"] > div:first-child {
  max-height: none !important;
  overflow: visible !important;
}
${PLAN_BANNER} [data-testid="plan-review-request"] .text-xs {
  font-size: 0.8125rem;
}
`;

function mountPlanExpander({ signal }: { signal: AbortSignal }) {
  const style = document.createElement("style");
  style.dataset.jbFlow = "plan-expander";
  style.textContent = PLAN_STYLE;
  document.head.append(style);

  const root = document.documentElement;
  try {
    const saved = Number(localStorage.getItem(PLAN_HEIGHT_KEY));
    if (saved > 0) root.style.setProperty(PLAN_HEIGHT_VAR, `${saved}px`);
  } catch {
    /* No storage: the default height applies. */
  }

  /** A grip on top of the banner: drag up to grow, down to shrink, double-click to reset. */
  const addHandle = (banner: HTMLElement) => {
    if (banner.querySelector(":scope > .jf-plan-resize")) return;
    const handle = document.createElement("div");
    handle.className = "jf-plan-resize";
    handle.title = "Drag to resize the plan · double-click to reset";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.addEventListener("pointerdown", (event) => {
      const body = banner.querySelector<HTMLElement>('.overflow-y-auto:has([data-testid="plan-review-request"])');
      if (!body) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.dataset.dragging = "";
      const startY = event.clientY;
      const startHeight = body.getBoundingClientRect().height;
      // Grow until the banner's top (and this handle) is 110px from the window
      // top, so the handle stays clear of the thread header and can be grabbed again.
      const maxHeight = startHeight + Math.max(0, banner.getBoundingClientRect().top - 110);
      let height = startHeight;
      const move = (next: PointerEvent) => {
        height = Math.round(Math.min(maxHeight, Math.max(160, startHeight + (startY - next.clientY))));
        root.style.setProperty(PLAN_HEIGHT_VAR, `${height}px`);
      };
      const end = () => {
        delete handle.dataset.dragging;
        handle.removeEventListener("pointermove", move);
        try {
          localStorage.setItem(PLAN_HEIGHT_KEY, String(height));
        } catch {
          /* Keep it for this session only. */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end, { once: true });
      handle.addEventListener("pointercancel", end, { once: true });
    });
    handle.addEventListener("dblclick", () => {
      root.style.removeProperty(PLAN_HEIGHT_VAR);
      try {
        localStorage.removeItem(PLAN_HEIGHT_KEY);
      } catch {
        /* Nothing saved. */
      }
    });
    banner.prepend(handle);
  };

  const seen = new WeakSet<Element>();
  const expand = () => {
    if (!(EXPAND_PLANS_FLAG in document.documentElement.dataset)) return;
    for (const banner of Array.from(document.querySelectorAll<HTMLElement>(PLAN_BANNER))) {
      if (banner.hasAttribute("data-expanded")) addHandle(banner);
      if (seen.has(banner)) continue;
      seen.add(banner);
      if (banner.hasAttribute("data-expanded")) continue;
      const toggle = banner.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
      toggle?.click();
    }
  };
  expand();
  const observer = new MutationObserver(expand);
  // Also when a banner is expanded by hand, so it gets its handle.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-expanded"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-jb-flow-expand-plans"] });
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  return () => {
    observer.disconnect();
    style.remove();
    for (const handle of Array.from(document.querySelectorAll(".jf-plan-resize"))) handle.remove();
  };
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "workspace-topbar", mount: mountWorkspaceTopBar });
  app.slots.experimental_appOverlay({ id: "workspace-topbar", component: WorkspaceTopBar });
  app.contentScripts.register({ id: "shell-appearance", mount: mountShellAppearance });
  app.contentScripts.register({ id: "timeline-activity", mount: mountTimelineActivity });
  app.slots.experimental_appOverlay({ id: "shell-appearance-preference", component: ShellAppearancePreference });
  app.slots.navPanel({
    id: "studio",
    title: "Studio",
    icon: "Columns",
    path: "studio",
    component: ({ subPath }) => {
      const { state } = useFlowState();
      return <Studio subPath={subPath} state={state} />;
    },
    fixedTabs: [{
      ...STUDIO_REVIEW_TAB,
      component: ({ subPath }) => {
        const { state } = useFlowState();
        return <StudioReview subPath={subPath} state={state} />;
      },
    }],
  });
  app.slots.navPanel({
    id: "catch-up",
    title: "Catch up",
    icon: "MailOpen",
    path: "catch-up",
    component: () => {
      const { state } = useFlowState();
      return <CatchUpPage flow={state} />;
    },
    experimental_useBadge: () => {
      const { state } = useFlowState();
      return useCatchUpBadge(state, useSettings().values?.catchUp === true);
    },
  });
  app.contentScripts.register({ id: "plan-expander", mount: mountPlanExpander });
  app.slots.experimental_appOverlay({ id: "focus-reporter", component: FocusReporter });
  app.slots.experimental_sidebarNavigation({
    id: "workspaces", title: "JB Flow workspaces", placement: "list",
    description: "Workspace tabs with projects, threads, sections and tools.",
    component: WorkspaceNavigation,
  });
  app.slots.experimental_appOverlay({ id: "workspace-route", component: WorkspaceRouteBridge });
  app.slots.settingsSection({ id: "workspaces", title: "Workspaces", component: WorkspaceSettings });
  app.slots.experimental_threadAction({
    id: "workspace", title: "Workspace", icon: "Folder", group: "organize",
    useData: () => ({ ...useWorkspaces(), enabled: useSettings().values?.workspaces === true }),
    item: ({ thread, data }) => !data.enabled ? null : ({
      label: "Move to workspace", icon: "Folder",
      choices: { items: [
        { id: "auto", label: "Automatic (from parent, section or project)" },
        ...data.state.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name })),
        { id: "unassigned", label: "No workspace" },
      ] },
      run: async ({ value }) => {
        if (!value) return;
        await data.rpc.call("workspace_assign", { threadId: thread.id, workspaceId: value === "auto" || value === "unassigned" ? null : value, automatic: value === "auto" });
        await data.refresh();
      },
    }),
  });
  app.slots.experimental_threadList({
    id: "triage",
    title: "Triage",
    description:
      "Needs me on top, then lanes, project chips, tags, snooze and keyboard triage.",
    component: TriageThreadList,
  });
  app.slots.experimental_threadHeaderAction({
    id: "status",
    title: "Thread status",
    component: ({ threadId }) => <ThreadStatusHeader threadId={threadId} />,
  });
  app.slots.threadPanelAction({
    id: "prs",
    title: "Pull requests",
    icon: "GitPullRequest",
    component: PullRequestsTab,
    run: ({ openPanel }) => {
      openPanel({ title: "Pull requests" });
    },
  });
  app.slots.experimental_appOverlay({ id: "command-host", component: CommandHost });
  app.slots.experimental_appOverlay({ id: "palette", component: PaletteHost });
  app.slots.experimental_appOverlay({ id: "catch-up", component: CatchUpHost });
  const inThread = ({ threadId }: { threadId: string | null }) => threadId !== null;
  app.commands.register({
    id: "palette",
    title: "Open JB Flow palette",
    run: () => {
      window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
    },
  });
  app.commands.register({
    id: "catch-up",
    title: "Catch up on unread threads",
    defaultShortcut: { key: "c", alt: true, shift: true },
    isAvailable: () => catchUpEnabled,
    run: () => {
      window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT));
    },
  });
  app.commands.register({
    id: "snooze",
    title: "Snooze this thread…",
    defaultShortcut: { key: "s", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ threadId }) => {
      if (threadId) window.dispatchEvent(new CustomEvent(SNOOZE_EVENT, { detail: threadId }));
    },
  });
  app.commands.register({
    id: "next-needs-me",
    title: "Open the next thread that needs me",
    defaultShortcut: { key: "n", alt: true, shift: true },
    run: async () => {
      await commandRpc?.call("next_needs_me", { archiveThreadId: null });
    },
  });
  app.commands.register({
    id: "archive-next",
    title: "Archive this thread and open the next that needs me",
    defaultShortcut: { key: "e", alt: true, shift: true },
    isAvailable: inThread,
    run: async ({ threadId }) => {
      await commandRpc?.call("next_needs_me", { archiveThreadId: threadId });
    },
  });
  app.commands.register({
    id: "dev-servers",
    title: "Start dev servers",
    defaultShortcut: { key: "d", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ openPanel }) => {
      openPanel({ actionId: "dev-servers", title: "Scripts", params: { autorun: "dev" } });
    },
  });
  app.commands.register({
    id: "pull-requests",
    title: "Show this thread's pull requests",
    defaultShortcut: { key: "p", alt: true, shift: true },
    isAvailable: inThread,
    run: ({ openPanel }) => {
      openPanel({ actionId: "prs", title: "Pull requests" });
    },
  });
  app.commands.register({
    id: "watch-ci",
    title: "Watch CI and reviews for this thread's PRs",
    defaultShortcut: { key: "w", alt: true, shift: true },
    isAvailable: inThread,
    run: async ({ threadId }) => {
      if (threadId) await commandRpc?.call("thread_watch_ci", { threadId });
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "snooze",
    title: "Snooze",
    component: ({ threadId }) => <SnoozeHeaderAction threadId={threadId} />,
  });
  app.slots.threadPanelAction({
    id: "dev-servers",
    title: "Start dev servers",
    icon: "Play",
    component: RepoCommandsPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Scripts", params: { autorun: "dev" } });
    },
  });
  app.slots.threadPanelAction({
    id: "repo-commands",
    title: "Scripts",
    icon: "ListView",
    component: RepoCommandsPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Scripts" });
    },
  });
  app.slots.settingsSection({
    id: "repo-commands",
    title: "Repo commands",
    description: "Per-project buttons for the thread side panel.",
    component: RepoCommandsSettings,
  });
  // Banners render in registration order: the reply choices sit above the monitor.
  app.composer.customize({
    id: "decision-chips",
    banners: [{ id: "decision-chips", chrome: "bare", component: DecisionChipsBanner }],
  });
  app.composer.customize({
    id: "live-activity",
    banners: [{ id: "live-activity", chrome: "bare", component: () => {
      const { state } = useFlowState();
      return <LiveActivityBanner runningSince={state?.running ?? {}} trackedPrs={state?.threadPrs ?? {}} watches={state?.watching ?? {}} />;
    } }],
  });
  app.slots.homepageSection({
    id: "unreleased",
    title: "Unreleased",
    component: UnreleasedSection,
  });
  app.slots.homepageSection({
    id: "your-move",
    title: "Your move",
    component: () => {
      const { state } = useFlowState();
      return <YourMoveSection lead={<CatchUpHomeEntry flow={state} />} />;
    },
  });
  app.slots.homepageSection({
    id: "stale-digest",
    title: "Stale threads",
    component: DigestSection,
  });
  app.slots.settingsSection({
    id: "lanes",
    title: "Triage lanes",
    description: "Sections the Triage list uses as numbered lanes.",
    component: LaneSettings,
  });
  app.slots.settingsSection({
    id: "area-tags",
    title: "Area tags",
    description: "Convert area sections into multi-valued tags.",
    component: MigrationSettings,
  });
});
