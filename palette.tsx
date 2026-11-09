// The JB Flow palette: one search over threads, messages, PRs, workspaces,
// projects and actions, with a triage home for an empty query and an action
// list for any thread (Tab). It opens on the key bb's own thread search is
// bound to (⌘K by default) while the Palette setting is on, and from the
// "Open JB Flow palette" command either way. Ranking lives in palette-model.ts.
import "./palette.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { toast } from "sonner";
import {
  experimental_copyToClipboard as copyToClipboard,
  experimental_usePluginId as usePluginId,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useThreadActions as useThreadActions,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread, PluginThreadActionEntry, PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import type { FlowState, rpcContract } from "./server";
import {
  DEFAULT_SEARCH_SHORTCUT,
  FILTER_HINTS,
  SCOPE_LABEL,
  SCOPE_PREFIX,
  ago,
  home,
  matchesShortcut,
  parseQuery,
  pushRecent,
  recordUse,
  search,
  searchShortcuts,
  serverHits,
  shortcutLabel,
  type Frecency,
  type PaletteAction,
  type PaletteInput,
  type PaletteItem,
  type Platform,
  type Range,
  type Scope,
  type Section,
  type ServerHit,
  type Shortcut,
} from "./palette-model";
import { resolveLanes } from "./lanes";
import { CATCH_UP_EVENT, buildQueue, needsYou } from "./catch-up-model";
import { SNOOZE_PRESETS, formatWhen, parseWhen } from "./when";
import { switchWorkspace, useSelectedWorkspace, useWorkspaces } from "./workspace-client";
import { inWorkspace, workspaceForThread } from "./workspaces";
import { PR_TONE, StatusIcon, ThreadPreviewCard, attentionLabel, prGlyph, rowStatus, runInfo, threadPrs, useNow, useThreadPreview } from "./ui-extras";
import type { RowStatus } from "./ui-extras";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Glyph } from "@/components/ui/glyph";
import { Icon } from "@/components/ui/icon";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Opens the palette; the command and anything else in this window dispatch it. */
export const PALETTE_EVENT = "jb-flow:palette";
const FRECENCY_KEY = "jb-flow.palette.frecency";
const RECENT_KEY = "jb-flow.palette.recent";
// bb's own "a modal is open" test: its shortcuts stand down while one is.
const MODAL_OPEN = '[aria-modal="true"]:not([inert]):not([inert] *):not([data-state="closed"])';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* The palette works without persistence. */
  }
}

export function currentPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = (nav.userAgentData?.platform || nav.platform || nav.userAgent || "").toLowerCase();
  if (name.includes("mac") || name.includes("iphone") || name.includes("ipad")) return "mac";
  return name.includes("win") ? "windows" : "linux";
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// --- opening -------------------------------------------------------------------------

/**
 * Open state for the palette. While `enabled`, the keys bb's "Search threads"
 * is bound to open it instead (rebinding moves the takeover; unbinding ends
 * it). The same keys close it either way. Also remembers the threads you visit
 * for the Recent section.
 */
export function usePaletteTrigger(enabled: boolean) {
  const sdk = useSdk();
  const context = useBbContext();
  const [open, setOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([DEFAULT_SEARCH_SHORTCUT]);
  const live = useRef({ open, shortcuts, enabled });
  live.current = { open, shortcuts, enabled };

  useEffect(() => {
    let cancelled = false;
    const platform = currentPlatform();
    const load = () => {
      Promise.resolve()
        .then(() => sdk.system.config())
        .then(
          (config) => {
            if (!cancelled) setShortcuts(searchShortcuts(config.keybindings, platform));
          },
          () => undefined,
        );
    };
    load();
    let unsubscribe = () => {};
    try {
      unsubscribe = sdk.subscribe({ event: "system:config-changed", callback: load });
    } catch {
      /* Without change events the binding read at open stays. */
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sdk]);

  useEffect(() => {
    const platform = currentPlatform();
    // Capture phase, before bb's own listener, which skips handled events.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const state = live.current;
      if (!state.shortcuts.some((shortcut) => matchesShortcut(event, shortcut, platform))) return;
      if (state.open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (!state.enabled || document.querySelector(MODAL_OPEN)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (context.threadId) writeJson(RECENT_KEY, pushRecent(readJson<string[]>(RECENT_KEY, []), context.threadId));
  }, [context.threadId]);

  const close = useCallback(() => setOpen(false), []);
  return { open, close, shortcut: shortcuts[0] ?? null };
}

// --- entries: what an action row runs ------------------------------------------------

type Entry = {
  id: string;
  title: string;
  detail?: string;
  keywords?: string;
  icon: ReactNode;
  destructive?: boolean;
  /** Listed under "This thread" on the home. */
  thread?: boolean;
  /** Always first, unfiltered: built from what you typed. */
  pinned?: boolean;
  run?: () => unknown;
  /** Opens a sub-list instead of running. */
  open?: () => Mode;
  /** The query a sub-list starts with. */
  query?: string;
};
type ThreadInfo = {
  id: string;
  title: string;
  projectId: string;
  sectionId: string | null;
  busy: boolean;
  isUnread: boolean;
  isPinned: boolean;
  archivedAt: number | null;
  status: PluginSidebarThread["status"];
};
type Mode = { kind: "thread"; thread: ThreadInfo } | { kind: "list"; title: string; entries: readonly Entry[] };
type Level = { mode: Mode; back: { query: string; scope: Scope; activeId: string | null } };

const info = (thread: PluginSidebarThread): ThreadInfo => ({
  id: thread.id,
  title: thread.displayTitle,
  projectId: thread.projectId,
  sectionId: thread.sectionId,
  busy: thread.status === "active" || thread.status === "starting",
  isUnread: thread.isUnread,
  isPinned: thread.isPinned,
  archivedAt: thread.archivedAt,
  status: thread.status,
});
const infoFromHit = (hit: ServerHit): ThreadInfo => ({
  id: hit.threadId,
  title: hit.title,
  projectId: hit.projectId,
  sectionId: null,
  busy: false,
  isUnread: false,
  isPinned: false,
  archivedAt: hit.archived ? hit.updatedAt : null,
  status: "idle",
});
const NO_TARGET: PluginThreadActionTarget = {
  id: "",
  projectId: "",
  parentThreadId: null,
  archivedAt: null,
  pinnedAt: null,
  sectionId: null,
  isUnread: false,
  status: "idle",
  environment: null,
};
function target(thread: ThreadInfo | null, sidebar: PluginSidebarThread | undefined): PluginThreadActionTarget {
  if (thread === null) return NO_TARGET;
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: sidebar?.parentThreadId ?? null,
    archivedAt: thread.archivedAt,
    pinnedAt: sidebar?.pinnedAt ?? null,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: sidebar?.environment?.id ? { id: sidebar.environment.id, path: sidebar.environment.path } : null,
  };
}

/** `answer` is what picking it sends: the number, or "go 2" for a go-list. */
type Reply = { n: number; text: string; recommended: boolean; answer: string };

/** The numbered choices a thread's last reply offers, for one-key answers. */
function useReplies(threadId: string | null): Reply[] {
  const rpc = useRpc<typeof rpcContract>();
  const [replies, setReplies] = useState<{ threadId: string; options: Reply[] } | null>(null);
  useEffect(() => {
    if (threadId === null) return;
    let live = true;
    rpc.call("decision_options", { threadId }).then(
      (result) => {
        if (live) {
          // One key answers one group: the decision when there is one, else the steps.
          const group = result.groups.find((candidate) => candidate.mode === "choice") ?? result.groups[0];
          const options = (group?.options ?? []).map((option) => ({ ...option, answer: group?.mode === "go" ? `go ${option.n}` : String(option.n) }));
          setReplies({ threadId, options });
        }
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, threadId]);
  return replies?.threadId === threadId ? replies.options : [];
}

/** bb's full-text search over titles and messages, debounced like bb's own. */
function useServerSearch(text: string, enabled: boolean, limit: number): ServerHit[] | null {
  const sdk = useSdk();
  const [result, setResult] = useState<{ query: string; hits: ServerHit[] } | null>(null);
  const query = text.trim();
  const searchable = enabled && query.replace(/\s/g, "").length >= 2;
  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() => sdk.threads.search({ query, limitPerGroup: String(limit), signal: controller.signal }))
        .then(
          (response) => {
            if (!controller.signal.aborted) setResult({ query, hits: serverHits(response) });
          },
          () => undefined,
        );
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [limit, query, sdk, searchable]);
  if (!searchable || result === null) return null;
  // Keep the last results while a longer query loads, so rows don't flicker.
  return query.toLowerCase().startsWith(result.query.toLowerCase()) ? result.hits : null;
}

type FileHit = { name: string; path: string };

/** bb's quick-open file search in one checkout; null while there's nothing to show. */
function useFileSearch(projectId: string | null, environmentId: string | null, text: string, enabled: boolean): FileHit[] | null {
  const sdk = useSdk();
  const [result, setResult] = useState<{ key: string; files: FileHit[] } | null>(null);
  const query = text.trim();
  const key = `${environmentId}\n${query}`;
  // bb's file search lists nothing for an empty query; the palette asks you to type instead.
  const searchable = enabled && projectId !== null && environmentId !== null && query !== "";
  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() => sdk.projects.files({ projectId: projectId!, environmentId: environmentId!, query, limit: "50", signal: controller.signal }))
        .then(
          (response) => {
            if (!controller.signal.aborted) setResult({ key, files: response.files });
          },
          () => {
            if (!controller.signal.aborted) setResult({ key, files: [] });
          },
        );
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [environmentId, key, projectId, query, sdk, searchable]);
  if (!searchable || result === null) return null;
  // The previous list stays up while the next query loads.
  return result.files;
}

/**
 * A query you close without running anything comes back if you reopen within
 * this long, so a quick ⌘K, Escape, ⌘K doesn't lose it.
 */
const REOPEN_MS = 30_000;
let reopen: { query: string; scope: Scope; at: number } | null = null;
/** Forget a kept query (tests, so one test's query doesn't open the next). */
export function forgetPaletteQuery() {
  reopen = null;
}

// --- the palette ---------------------------------------------------------------------

export function Palette({
  flow,
  onClose,
  shortcut,
}: {
  flow: FlowState | null;
  onClose: () => void;
  shortcut: Shortcut | null;
}) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const pluginId = usePluginId();
  const { threads, projects, sections: threadSections } = useSidebarThreads();
  const settings = useSettings().values;
  const workspacesOn = settings?.workspaces === true;
  const catchUpOn = settings?.catchUp === true;
  const { state: workspaceState, refresh: refreshWorkspaces } = useWorkspaces();
  const selectedWorkspace = useSelectedWorkspace();
  const now = useNow(30_000);
  const platform = useMemo(currentPlatform, []);
  // Room for a preview of the selected thread beside the results.
  const wide = useMediaQuery("(min-width: 1100px)");
  const mod = platform === "mac" ? "⌘" : "Ctrl+";

  const [restored] = useState(() => {
    const kept = reopen !== null && Date.now() - reopen.at < REOPEN_MS ? reopen : null;
    reopen = null;
    return kept;
  });
  const [query, setQuery] = useState(restored?.query ?? "");
  const [scope, setScope] = useState<Scope>(restored?.scope ?? "all");
  const [levels, setLevels] = useState<Level[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [frecency, setFrecency] = useState<Frecency>(() => readJson<Frecency>(FRECENCY_KEY, {}));
  const recent = useMemo(() => readJson<string[]>(RECENT_KEY, []), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const level = levels.at(-1) ?? null;
  // Closing without running keeps the top-level query for REOPEN_MS.
  const ran = useRef(false);
  const latest = useRef({ query, scope, levels });
  latest.current = { query, scope, levels };
  useEffect(
    () => () => {
      if (ran.current) return;
      const top = latest.current.levels[0]?.back ?? latest.current;
      if (top.query.trim() || top.scope !== "all") reopen = { query: top.query, scope: top.scope, at: Date.now() };
    },
    [],
  );

  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const workspaceOf = useMemo(
    () => Object.fromEntries(threads.map((thread) => [thread.id, workspaceForThread(thread, workspaceState, threads)])),
    [threads, workspaceState],
  );
  const workspaces = workspacesOn ? workspaceState.workspaces : [];
  const lanes = useMemo(() => resolveLanes(threadSections, flow?.laneSections), [threadSections, flow?.laneSections]);
  const current = context.threadId ? (threadsById.get(context.threadId) ?? null) : null;
  const parsed = parseQuery(query);
  const server = useServerSearch(parsed.text, level === null && (scope === "all" || scope === "threads"), scope === "threads" ? 50 : 20);
  const checkout = current?.environment?.id ?? null;
  const files = useFileSearch(current?.projectId ?? null, checkout, query, level === null && scope === "files");
  const serverById = useMemo(() => new Map((server ?? []).map((hit) => [hit.threadId, hit])), [server]);

  const modeThread = level?.mode.kind === "thread" ? level.mode.thread : null;
  const currentInfo = useMemo(() => (current ? info(current) : null), [current]);
  // The hook needs a thread even before Tab picks one; a real one keeps other
  // plugins' per-thread data loaders from seeing a made-up id.
  const fallback = current ?? threads[0];
  const modeTarget = useMemo(
    () =>
      modeThread
        ? target(modeThread, threadsById.get(modeThread.id))
        : fallback
          ? target(info(fallback), fallback)
          : NO_TARGET,
    [modeThread, threadsById, fallback],
  );
  const modeHostActions = useThreadActions(modeTarget);
  const currentReplies = useReplies(current && flow?.awaiting[current.id] !== undefined ? current.id : null);
  const modeReplies = useReplies(modeThread?.id ?? null);

  const done = useCallback(
    (work: () => unknown, success?: string) => {
      ran.current = true;
      onClose();
      // After the dialog unmounts and focus is back, like bb's own palette.
      window.setTimeout(() => {
        Promise.resolve()
          .then(work)
          .then(
            () => {
              if (success) toast.success(success);
            },
            (cause: unknown) => toast.error(errorText(cause)),
          );
      }, 0);
    },
    [onClose],
  );

  const projectName = (projectId: string) => projectsById.get(projectId)?.name ?? "this project";
  // No project in view: leave the choice to bb's new-thread screen rather than guess.
  const composeProject = context.projectId ?? current?.projectId ?? null;

  /** Everything you can do to one thread: replies, snooze, moves, PRs, then bb's and other plugins' actions. */
  const threadEntries = (thread: ThreadInfo, replies: readonly Reply[], hostActions: readonly PluginThreadActionEntry[], typed: string): Entry[] => {
    const entries: Entry[] = [];
    const id = thread.id;
    const snoozeText = typed.replace(/^\s*(snooze|until|for)\b\s*(until|for)?\s*/i, "").trim();
    if (snoozeText) {
      try {
        const until = parseWhen(snoozeText);
        entries.push({
          id: "snooze:typed",
          title: `Snooze until ${formatWhen(until)}`,
          icon: <Glyph name="alarm" />,
          pinned: true,
          run: () => rpc.call("snooze", { threadId: id, when: snoozeText, note: null, until }).then(() => toast.success(`Snoozed until ${formatWhen(until)}`)),
        });
      } catch {
        /* Not a time; the other rows still filter on it. */
      }
    }
    const tag = /^\s*tag\s+(.+)$/i.exec(typed)?.[1]?.trim();
    const tags = flow?.tags[id] ?? [];
    if (tag) {
      entries.push({
        id: "tag:typed",
        title: `Add tag “${tag.slice(0, 40)}”`,
        icon: <Glyph name="tag" />,
        pinned: true,
        run: () => rpc.call("tags_set", { threadId: id, tags: [...tags.filter((other) => other !== tag), tag.slice(0, 40)].slice(0, 10) }),
      });
    }
    entries.push(
      { id: "open", title: "Open", icon: <Icon name="MessageSquare" />, run: () => navigate.toThread(id) },
      { id: "open-split", title: "Open in split view", icon: <Icon name="Columns2" />, run: () => navigate.toThread(id, { split: true }) },
    );
    for (const reply of replies) {
      entries.push({
        id: `reply:${reply.n}`,
        title: `Reply ${reply.n}: ${reply.text}`,
        detail: reply.recommended ? "Recommended" : undefined,
        keywords: "reply answer choose option decision",
        icon: <Icon name="CornerDownLeft" />,
        run: () => rpc.call("thread_reply", { threadId: id, text: reply.answer }),
      });
    }
    const snoozed = flow?.snoozes[id];
    if (snoozed) {
      entries.push({
        id: "unsnooze",
        title: "Wake now",
        detail: `Snoozed until ${formatWhen(snoozed.until)}`,
        keywords: "unsnooze snooze",
        icon: <Glyph name="alarm" />,
        run: () => rpc.call("unsnooze", { threadId: id }),
      });
    }
    for (const preset of SNOOZE_PRESETS) {
      entries.push({
        id: `snooze:${preset.when}`,
        title: `Snooze: ${preset.label}`,
        keywords: `snooze later remind ${preset.when}`,
        icon: <Glyph name="alarm" />,
        run: () => {
          const until = parseWhen(preset.when);
          return rpc.call("snooze", { threadId: id, when: preset.when, note: null, until }).then(() => toast.success(`Snoozed until ${formatWhen(until)}`));
        },
      });
    }
    if (thread.busy) {
      entries.push({ id: "stop", title: "Stop run", keywords: "cancel halt", icon: <Icon name="Square" />, run: () => rpc.call("thread_stop", { threadId: id }) });
    }
    const prs = flow?.threadPrs[id] ?? [];
    if (prs.some((pr) => pr.state === "open" || pr.state === "draft")) {
      entries.push({
        id: "watch-ci",
        title: "Watch CI and reviews",
        keywords: "pull request checks wait",
        icon: <Glyph name="hourglass" />,
        run: () => rpc.call("thread_watch_ci", { threadId: id }),
      });
    }
    for (const pr of prs) {
      entries.push({
        id: `pr:${pr.url}`,
        title: `Open PR #${pr.number}: ${pr.title}`,
        detail: attentionLabel(pr.attention),
        keywords: `pull request github ${pr.repo}`,
        icon: <Glyph name={prGlyph(pr)} className={PR_TONE[pr.attention]} />,
        run: () => openUrl(pr.url),
      });
    }
    for (const lane of lanes) {
      if (lane.sectionId === thread.sectionId) continue;
      entries.push({
        id: `lane:${lane.id}`,
        title: `Move to ${lane.title}`,
        keywords: "lane section move",
        icon: <Glyph name="folderMove" />,
        run: () => rpc.call("thread_move", { threadId: id, sectionId: lane.sectionId, via: "palette" }),
      });
    }
    const laneSections = new Set(lanes.map((lane) => lane.sectionId));
    for (const section of threadSections) {
      if (laneSections.has(section.id) || section.id === thread.sectionId || section.id === flow?.snoozedSectionId) continue;
      entries.push({
        id: `section:${section.id}`,
        title: `Move to ${section.name}`,
        keywords: "section move",
        icon: <Glyph name="folderMove" />,
        run: () => rpc.call("thread_move", { threadId: id, sectionId: section.id, via: "palette" }),
      });
    }
    if (workspaces.length > 0) {
      const assign = (workspaceId: string | null, automatic: boolean) => () =>
        rpc.call("workspace_assign", { threadId: id, workspaceId, automatic }).then(() => refreshWorkspaces());
      for (const workspace of workspaces) {
        if (workspaceOf[id] === workspace.id) continue;
        entries.push({ id: `workspace:${workspace.id}`, title: `Move to workspace ${workspace.name}`, keywords: "workspace", icon: <Icon name="Layers" />, run: assign(workspace.id, false) });
      }
      entries.push(
        { id: "workspace:auto", title: "Workspace: automatic", keywords: "workspace move", icon: <Icon name="Layers" />, run: assign(null, true) },
        { id: "workspace:none", title: "Move to No workspace", keywords: "workspace", icon: <Icon name="Layers" />, run: assign(null, false) },
      );
    }
    for (const existing of tags) {
      entries.push({
        id: `untag:${existing}`,
        title: `Remove tag “${existing}”`,
        keywords: "tag untag",
        icon: <Glyph name="tag" />,
        run: () => rpc.call("tags_set", { threadId: id, tags: tags.filter((other) => other !== existing) }),
      });
    }
    entries.push({ id: "copy-id", title: "Copy thread ID", keywords: "clipboard", icon: <Icon name="Copy" />, run: () => copyToClipboard({ text: id }) });
    for (const entry of hostActions) {
      // Ours are listed above with their choices spelled out; Open in split leads.
      if (entry.pluginId === pluginId || entry.key === "bb--core/split") continue;
      const action = entry.action;
      if (action.disabled) continue;
      const base = {
        id: `host:${entry.key}`,
        detail: action.detail,
        icon: <Icon name={action.icon} />,
        destructive: action.variant === "destructive",
      };
      const choices = action.choices;
      if (choices) {
        entries.push({
          ...base,
          title: `${action.label}…`,
          open: () => ({
            kind: "list",
            title: choices.heading ?? action.label,
            entries: choices.items
              .filter((choice) => !choice.disabled)
              .map((choice) => ({
                id: `host:${entry.key}:${choice.id}`,
                title: choice.label,
                detail: choice.selected ? "Current" : undefined,
                icon: <Icon name={choice.icon ?? action.icon} />,
                run: () => action.run(choice.id),
              })),
          }),
        });
      } else entries.push({ ...base, title: action.label, run: () => action.run() });
    }
    return entries;
  };

  const openUrl = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  /** Actions that aren't about one result: triage, new threads, this thread. */
  const appEntries = useMemo((): Entry[] => {
    const entries: Entry[] = [];
    if (currentInfo) {
      const here = currentInfo;
      for (const reply of currentReplies) {
        entries.push({
          id: `current-reply:${reply.n}`,
          title: `Reply ${reply.n}: ${reply.text}`,
          detail: reply.recommended ? "Recommended" : "This thread",
          keywords: "reply answer choose option decision",
          icon: <Icon name="CornerDownLeft" />,
          thread: true,
          run: () => rpc.call("thread_reply", { threadId: here.id, text: reply.answer }),
        });
      }
      entries.push(
        { id: "current-snooze", title: "Snooze this thread…", keywords: "later remind", icon: <Glyph name="alarm" />, thread: true, open: () => ({ kind: "thread", thread: here }), query: "snooze " },
        {
          id: "archive-next",
          title: "Archive this thread and open the next that needs me",
          keywords: "done triage inbox",
          icon: <Icon name="Archive" />,
          thread: true,
          run: () => rpc.call("next_needs_me", { archiveThreadId: here.id }),
        },
      );
      if ((flow?.threadPrs[here.id] ?? []).length > 0) {
        entries.push(
          { id: "current-watch-ci", title: "Watch CI and reviews for this thread's PRs", keywords: "pull request checks wait", icon: <Glyph name="hourglass" />, thread: true, run: () => rpc.call("thread_watch_ci", { threadId: here.id }) },
          { id: "current-prs", title: "Show this thread's pull requests", keywords: "pr panel", icon: <Icon name="GitPullRequest" />, thread: true, run: () => navigate.openThreadPanel({ actionId: "prs", title: "Pull requests" }) },
        );
      }
      entries.push(
        { id: "current-dev", title: "Start dev servers", keywords: "scripts run dev", icon: <Icon name="Play" />, thread: true, run: () => navigate.openThreadPanel({ actionId: "dev-servers", title: "Scripts", params: { autorun: "dev" } }) },
        { id: "current-all", title: "All actions for this thread…", keywords: "menu more pin rename archive", icon: <Icon name="ListView" />, thread: true, open: () => ({ kind: "thread", thread: here }) },
      );
    }
    entries.push(
      { id: "next-needs-me", title: "Open the next thread that needs me", keywords: "triage inbox", icon: <Glyph name="question" />, run: () => rpc.call("next_needs_me", { archiveThreadId: null }) },
    );
    if (catchUpOn) {
      const unread = buildQueue(threads, flow, (thread) => inWorkspace(thread, selectedWorkspace, workspaceState, threads));
      const need = unread.filter((entry) => needsYou(entry.tier)).length;
      entries.push({
        id: "catch-up",
        title: "Catch up on unread threads",
        detail: unread.length ? `${unread.length} unread${need ? ` · ${need} need${need === 1 ? "s" : ""} you` : ""}` : "All caught up",
        keywords: "unread inbox read cards triage swipe",
        icon: <Icon name="MailOpen" />,
        run: () => window.dispatchEvent(new CustomEvent(CATCH_UP_EVENT)),
      });
    }
    entries.push(
      {
        id: "new-thread",
        title: composeProject ? `New thread in ${projectName(composeProject)}` : "New thread",
        keywords: "compose start create",
        icon: <Icon name="MessageSquarePlus" />,
        run: () => navigate.toCompose({ ...(composeProject ? { projectId: composeProject } : {}), focusPrompt: true }),
      },
      { id: "studio", title: "Open Studio", keywords: "overview board", icon: <Icon name="Layers" />, run: () => navigate.toPluginPanel("studio") },
    );
    return entries;
    // projectName reads projectsById, a dependency here.
  }, [currentInfo, currentReplies, flow, rpc, navigate, composeProject, projectsById, catchUpOn, threads, selectedWorkspace, workspaceState]);

  // --- what to list ---
  const levelEntries: readonly Entry[] | null =
    level === null
      ? null
      : level.mode.kind === "thread"
        ? threadEntries(level.mode.thread, modeReplies, modeHostActions, query)
        : level.mode.entries;
  const entriesById = new Map<string, Entry>((levelEntries ?? appEntries).map((entry) => [entry.id, entry]));
  const input: PaletteInput = {
    threads,
    projects,
    sections: threadSections,
    workspaces,
    workspaceOf,
    selectedWorkspace,
    flow,
    currentThreadId: context.threadId,
    recent,
    frecency,
    actions: appEntries.map((entry): PaletteAction => ({ id: entry.id, title: entry.title, keywords: entry.keywords, thread: entry.thread })),
    server,
    files,
    now,
  };
  let sections: Section[];
  if (levelEntries !== null) {
    const pinned = levelEntries.filter((entry) => entry.pinned);
    const ranked = search({ ...input, actions: levelEntries.filter((entry) => !entry.pinned) }, "actions", query)[0]?.items ?? [];
    const items: PaletteItem[] = [
      ...pinned.map((entry): PaletteItem => ({ kind: "action", id: `action:${entry.id}`, actionId: entry.id, title: entry.title, ranges: {} })),
      ...ranked,
    ];
    sections = items.length ? [{ id: "actions", title: level?.mode.kind === "thread" ? level.mode.thread.title : (level?.mode.title ?? ""), items }] : [];
  } else {
    sections = query.trim() === "" && scope === "all" ? home(input) : search(input, scope, query);
  }
  const rows = sections.flatMap((section) => section.items);
  const activeIndex = Math.max(0, rows.findIndex((row) => row.id === activeId));
  const active = rows[activeIndex] ?? null;
  const previewThreadId =
    level?.mode.kind === "thread"
      ? level.mode.thread.id
      : active?.kind === "thread" || active?.kind === "pr"
        ? active.threadId
        : null;

  useEffect(() => {
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listId]);

  // --- moving between levels ---
  const enter = (mode: Mode, startQuery = "") => {
    setLevels((all) => [...all, { mode, back: { query, scope, activeId: active?.id ?? null } }]);
    setQuery(startQuery);
    setScope("all");
    setActiveId(null);
    inputRef.current?.focus();
  };
  const back = () => {
    const last = levels.at(-1);
    if (!last) return false;
    setLevels((all) => all.slice(0, -1));
    setQuery(last.back.query);
    setScope(last.back.scope);
    setActiveId(last.back.activeId);
    return true;
  };

  const threadFor = (threadId: string): ThreadInfo | null => {
    const sidebar = threadsById.get(threadId);
    if (sidebar) return info(sidebar);
    const hit = serverById.get(threadId);
    return hit ? infoFromHit(hit) : null;
  };

  /** Tab: a level deeper, for things that have one. */
  const drill = (item: PaletteItem | null): boolean => {
    if (item === null) return false;
    if (item.kind === "thread" || item.kind === "pr") {
      const thread = threadFor(item.threadId);
      if (thread) enter({ kind: "thread", thread });
      return thread !== null;
    }
    if (item.kind === "action") {
      const entry = entriesById.get(item.actionId);
      if (!entry?.open) return false;
      enter(entry.open(), entry.query);
      return true;
    }
    if (item.kind === "compose") {
      enter({
        kind: "list",
        title: `New thread: “${item.prompt}”`,
        entries: projects.map((project) => ({
          id: `compose:${project.id}`,
          title: `In ${project.name}`,
          icon: <Icon name="MessageSquarePlus" />,
          run: () => navigate.toCompose({ projectId: project.id, initialPrompt: item.prompt, focusPrompt: true }),
        })),
      });
      return true;
    }
    return false;
  };

  const remember = (id: string) => {
    setFrecency((before) => {
      const next = recordUse(before, id, Date.now());
      writeJson(FRECENCY_KEY, next);
      return next;
    });
  };

  const run = (item: PaletteItem | null, secondary: boolean) => {
    if (item === null) return;
    remember(item.id);
    switch (item.kind) {
      case "thread":
        done(() => navigate.toThread(item.threadId, secondary ? { split: true } : undefined));
        return;
      case "pr":
        done(() => (secondary ? navigate.toThread(item.threadId) : openUrl(item.pr.url)));
        return;
      case "workspace":
        done(() => switchWorkspace(item.workspaceId, { state: workspaceState, threads, projects, currentThreadId: context.threadId, navigate }));
        return;
      case "project":
        done(() => (item.compose ? navigate.toCompose({ projectId: item.projectId, focusPrompt: true }) : navigate.toProject(item.projectId)));
        return;
      case "compose":
        if (secondary) {
          drill(item);
          return;
        }
        done(() => navigate.toCompose({ ...(composeProject ? { projectId: composeProject } : {}), initialPrompt: item.prompt, focusPrompt: true }));
        return;
      case "file": {
        if (checkout === null || current === null) return;
        const options = { target: { kind: "workspace" as const, environmentId: checkout, path: item.path }, location: null };
        const threadId = current.id;
        done(async () => {
          if (secondary) {
            if (!navigate.experimental_openFileExternally(options)) throw new Error("No editor is set up to open files from BB.");
            return;
          }
          // An app overlay has no preview panel of its own (bb declines), so the
          // file opens in the thread's panel the way `bb thread open <path>` does.
          if (navigate.experimental_openFilePreview(options)) return;
          const { delivered } = await sdk.threads.open({ threadId, file: { source: "workspace", path: item.path, lineNumber: null } });
          if (delivered === 0) throw new Error("No BB window took the file; open the thread and try again.");
        });
        return;
      }
      case "more":
        setScope(item.scope);
        setActiveId(null);
        return;
      case "action": {
        const entry = entriesById.get(item.actionId);
        if (!entry) return;
        if (entry.open) {
          enter(entry.open(), entry.query);
          return;
        }
        if (entry.run) done(entry.run);
      }
    }
  };

  const onQuery = (value: string) => {
    const prefix = SCOPE_PREFIX[value[0] ?? ""];
    if (level === null && scope === "all" && prefix) {
      setScope(prefix);
      setQuery(value.slice(1));
    } else setQuery(value);
    setActiveId(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const field = event.currentTarget;
    const caretAtEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    const caretAtStart = field.selectionStart === 0 && field.selectionEnd === 0;
    const move = (delta: number) => {
      event.preventDefault();
      if (rows.length === 0) return;
      setActiveId(rows[(activeIndex + delta + rows.length) % rows.length]!.id);
    };
    switch (event.key) {
      case "ArrowDown":
        move(1);
        return;
      case "ArrowUp":
        move(-1);
        return;
      case "PageDown":
        event.preventDefault();
        if (rows.length) setActiveId(rows[Math.min(rows.length - 1, activeIndex + 8)]!.id);
        return;
      case "PageUp":
        event.preventDefault();
        if (rows.length) setActiveId(rows[Math.max(0, activeIndex - 8)]!.id);
        return;
      case "Enter":
        event.preventDefault();
        run(active, platform === "mac" ? event.metaKey : event.ctrlKey);
        return;
      case "Tab":
        // Focus stays in the palette either way.
        event.preventDefault();
        if (event.shiftKey) back();
        else drill(active);
        return;
      case "ArrowRight":
        if (caretAtEnd && drill(active)) event.preventDefault();
        return;
      case "ArrowLeft":
        if (caretAtStart && level !== null) {
          event.preventDefault();
          back();
        }
        return;
      case "Backspace":
        if (field.value === "" && (level !== null || scope !== "all")) {
          event.preventDefault();
          if (!back()) setScope("all");
        }
        return;
      case "Escape":
        if (level !== null) {
          event.preventDefault();
          back();
        }
        return;
    }
  };

  const chip = level !== null ? (level.mode.kind === "thread" ? level.mode.thread.title : level.mode.title) : scope !== "all" ? SCOPE_LABEL[scope] : null;
  const placeholder =
    level?.mode.kind === "thread"
      ? "Snooze tomorrow, move, reply, tag …, archive…"
      : level !== null
        ? "Filter…"
        : scope === "files"
          ? "Search files in this thread's checkout…"
          : scope === "all"
          ? "Search threads, messages, PRs, workspaces and actions…"
          : `Search ${SCOPE_LABEL[scope].toLowerCase()}…`;
  const hint = rowHint(active, entriesById, mod);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        hideCloseButton
        className={cn("jf-palette top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:rounded-xl", wide ? "max-w-[1000px]" : "max-w-[680px]")}
        onEscapeKeyDown={(event) => {
          if (levels.length > 0) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
          // A query kept from a moment ago: typing replaces it, arrows keep it.
          if (restored) inputRef.current?.select();
        }}
      >
        <DialogTitle className="sr-only">JB Flow palette</DialogTitle>
        <DialogDescription className="sr-only">
          Arrow keys choose, Enter opens, {mod}Enter opens in a split, Tab shows actions, Escape goes back or closes.
        </DialogDescription>
        <div className="jf-palette-input">
          <Icon name="Search" className="jf-palette-search-icon" />
          {chip !== null ? (
            <button
              type="button"
              className="jf-palette-chip"
              onClick={() => {
                if (!back()) setScope("all");
                inputRef.current?.focus();
              }}
              title={level !== null ? "Back (Shift+Tab)" : "Search everything (Backspace)"}
            >
              <span className="jf-palette-chip-label">{chip}</span>
              <Icon name="X" className="size-3" />
            </button>
          ) : null}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? `${listId}-${activeIndex}` : undefined}
            aria-label="Search the JB Flow palette"
            placeholder={placeholder}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {shortcut ? <kbd className="jf-palette-kbd" title="Closes the palette">{shortcutLabel(shortcut, platform)}</kbd> : null}
        </div>
        <div className={cn("jf-palette-body", wide && "jf-palette-body-split")}>
        <div id={listId} role="listbox" aria-label="Results" className="jf-palette-list">
          {rows.length === 0 ? (
            <p className="jf-palette-empty">{level !== null
                ? "No matching actions"
                : scope === "prs"
                  ? "No tracked pull requests"
                  : scope === "files"
                    ? checkout === null
                      ? "Open a thread to search its checkout's files"
                      : query.trim() === ""
                        ? "Type to search this thread's files"
                        : files === null
                        ? "Searching files…"
                        : "No matching files"
                    : "Nothing matches"}</p>
          ) : null}
          {(() => {
            let index = -1;
            return sections.map((section) => (
              <div key={section.id} role="group" aria-label={section.title} className="jf-palette-group">
                <div className="jf-palette-heading" aria-hidden="true">
                  {section.title}
                </div>
                {section.items.map((item) => {
                  index += 1;
                  const at = index;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${at}`}
                      role="option"
                      aria-selected={at === activeIndex}
                      data-jf-palette-kind={item.kind}
                      className="jf-palette-row"
                      onPointerMove={() => {
                        if (activeId !== item.id) setActiveId(item.id);
                      }}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={(event) => run(item, event.metaKey || event.ctrlKey)}
                    >
                      <Row
                        item={item}
                        entry={item.kind === "action" ? entriesById.get(item.actionId) : undefined}
                        flow={flow}
                        thread={item.kind === "thread" || item.kind === "pr" ? threadsById.get(item.threadId) : undefined}
                        project={(projectId) => projectsById.get(projectId)}
                        workspaceName={(threadId) => workspaces.find((workspace) => workspace.id === workspaceOf[threadId])?.name ?? null}
                        currentWorkspace={selectedWorkspace}
                        composeProject={composeProject ? projectName(composeProject) : null}
                        now={now}
                      />
                      {at === activeIndex && hint ? <span className="jf-palette-row-hint">{hint}</span> : null}
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
        {wide ? (
          <aside className="jf-palette-preview" aria-label="Preview">
            {previewThreadId !== null ? (
              <PalettePreview
                key={previewThreadId}
                threadId={previewThreadId}
                flow={flow}
                thread={threadsById.get(previewThreadId)}
                hit={serverById.get(previewThreadId)}
                project={(projectId) => projectsById.get(projectId)}
                section={(sectionId) => threadSections.find((section) => section.id === sectionId)?.name ?? null}
                workspace={workspaces.find((workspace) => workspace.id === workspaceOf[previewThreadId])?.name ?? null}
                now={now}
              />
            ) : (
              <PaletteTips mod={mod} />
            )}
          </aside>
        ) : null}
        </div>
        <div className="jf-palette-footer" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd> choose <kbd>↵</kbd> open <kbd>{mod}↵</kbd> split <kbd>⇥</kbd> actions <kbd>esc</kbd> {level ? "back" : "close"}
          </span>
          {level === null && scope === "all" ? (
            <span className="jf-palette-scopes">
              <kbd>&gt;</kbd> actions <kbd>#</kbd> PRs <kbd>@</kbd> places <kbd>/</kbd> files <span title={FILTER_HINTS.join(" ")}>is:needs …</span>
            </span>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function rowHint(item: PaletteItem | null, entries: ReadonlyMap<string, Entry>, mod: string): string | null {
  if (item === null) return null;
  switch (item.kind) {
    case "thread":
      return "↵ open  ⇥ actions";
    case "pr":
      return `↵ open PR  ${mod}↵ thread`;
    case "compose":
      return "↵ start  ⇥ project";
    case "file":
      return `↵ preview  ${mod}↵ editor`;
    case "more":
      return "↵ show";
    case "action":
      return entries.get(item.actionId)?.open ? "↵ more" : "↵ run";
    default:
      return "↵ go";
  }
}

// --- rows ------------------------------------------------------------------------------

function Highlight({ text, ranges }: { text: string; ranges: readonly Range[] | undefined }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="jf-palette-mark">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

type RowProps = {
  item: PaletteItem;
  entry: Entry | undefined;
  flow: FlowState | null;
  thread: PluginSidebarThread | undefined;
  project: (projectId: string) => { name: string; isPersonal: boolean } | undefined;
  workspaceName: (threadId: string) => string | null;
  currentWorkspace: string | null;
  composeProject: string | null;
  now: number;
};

function Row(props: RowProps) {
  const { item } = props;
  switch (item.kind) {
    case "thread":
      return <ThreadRow {...props} item={item} />;
    case "pr": {
      const { pr } = item;
      return (
        <>
          <span className="jf-palette-icon">
            <Glyph name={prGlyph(pr)} className={cn("size-4", PR_TONE[pr.attention])} />
          </span>
          <span className="jf-palette-main">
            <span className="jf-palette-title">
              <Highlight text={`#${pr.number} ${pr.title}`} ranges={item.ranges.title} />
            </span>
            <span className="jf-palette-meta">
              <span>{pr.repo}</span>
              <span className={PR_TONE[pr.attention]}>{attentionLabel(pr.attention)}</span>
              {props.thread ? <span className="truncate">{props.thread.displayTitle}</span> : null}
            </span>
          </span>
        </>
      );
    }
    case "workspace":
      return (
        <Simple icon={<Icon name="Layers" />} title={<>Switch to <Highlight text={item.name} ranges={item.ranges.title} /></>} detail={(item.workspaceId ?? null) === props.currentWorkspace ? "Current" : "Workspace"} />
      );
    case "project":
      return item.compose ? (
        <Simple icon={<Icon name="MessageSquarePlus" />} title={<>New thread in <Highlight text={item.name} ranges={item.ranges.title} /></>} detail="Project" />
      ) : (
        <Simple icon={<Icon name="Folder" />} title={<Highlight text={item.name} ranges={item.ranges.title} />} detail="Project" />
      );
    case "compose":
      return <Simple icon={<Icon name="MessageSquarePlus" />} title={<>New thread: “{item.prompt}”</>} detail={props.composeProject ? `in ${props.composeProject}` : undefined} />;
    case "file": {
      const folder = item.path.slice(0, Math.max(0, item.path.length - item.name.length)).replace(/\/$/, "");
      return (
        <>
          <span className="jf-palette-icon">
            <Icon name="FileText" />
          </span>
          <span className="jf-palette-main">
            <span className="jf-palette-title">
              <Highlight text={item.name} ranges={item.ranges.title} />
            </span>
            {folder ? <span className="jf-palette-meta jf-palette-path">{folder}</span> : null}
          </span>
        </>
      );
    }
    case "more":
      return <Simple icon={<Icon name="ArrowRight" />} title={item.label} />;
    case "action": {
      const entry = props.entry;
      return (
        <Simple
          icon={entry?.icon ?? <Icon name="Zap" />}
          title={<Highlight text={item.title} ranges={item.ranges.title} />}
          detail={entry?.detail}
          destructive={entry?.destructive}
        />
      );
    }
  }
}

function Simple({ icon, title, detail, destructive }: { icon: ReactNode; title: ReactNode; detail?: string; destructive?: boolean }) {
  return (
    <>
      <span className={cn("jf-palette-icon", destructive && "text-destructive")}>{icon}</span>
      <span className="jf-palette-main">
        <span className={cn("jf-palette-title", destructive && "text-destructive")}>{title}</span>
      </span>
      {detail ? <span className="jf-palette-detail">{detail}</span> : null}
    </>
  );
}

const PR_GLYPHS = new Set<string>(["pr", "prDraft", "prClosed", "merged"]);

/** The Triage row icon for a thread, or a plain dot for one this window hasn't loaded. */
function threadStatus(
  thread: PluginSidebarThread | undefined,
  hit: ServerHit | null | undefined,
  flow: FlowState | null,
  prs: ReturnType<typeof threadPrs>,
  now: number,
): RowStatus {
  if (!thread) return { glyph: "dot", tone: "text-muted-foreground/40", label: hit?.archived ? "Archived" : "Thread" };
  const busy = thread.status === "active" || thread.status === "starting";
  return rowStatus(thread, busy, flow?.watching[thread.id], prs, busy ? runInfo(flow?.running[thread.id], now) : null);
}

function ThreadRow({ item, flow, thread, project, workspaceName, now }: RowProps & { item: Extract<PaletteItem, { kind: "thread" }> }) {
  const { pullRequest } = useSidebarThreadPullRequest(item.threadId);
  const title = thread?.displayTitle ?? item.server?.title ?? "Untitled thread";
  const projectId = thread?.projectId ?? item.server?.projectId ?? "";
  const owner = project(projectId);
  const prs = threadPrs(flow?.threadPrs[item.threadId], pullRequest);
  const status = threadStatus(thread, item.server, flow, prs, now);
  const snooze = flow?.snoozes[item.threadId];
  const tags = flow?.tags[item.threadId] ?? [];
  const workspace = workspaceName(item.threadId);
  const branch = thread?.environment?.branchName ?? null;
  const pr = prs[0];
  return (
    <>
      <span className="jf-palette-icon">
        <StatusIcon status={status} />
      </span>
      <span className="jf-palette-main">
        <span className="jf-palette-title">
          <Highlight text={title} ranges={item.ranges.title} />
        </span>
        <span className="jf-palette-meta">
          {owner && !owner.isPersonal ? <span><Highlight text={owner.name} ranges={item.ranges.project} /></span> : null}
          {workspace ? <span>{workspace}</span> : null}
          {pr ? (
            <span className={PR_TONE[pr.attention]}>
              #{pr.number} {attentionLabel(pr.attention)}
              {prs.length > 1 ? ` +${prs.length - 1}` : ""}
            </span>
          ) : null}
          {tags.map((tag) => (
            <span key={tag} className="jf-palette-tag">
              #{tag}
            </span>
          ))}
          {snooze ? <span>Snoozed until {formatWhen(snooze.until)}</span> : null}
          {item.server?.archived || thread?.isArchived ? <span>Archived</span> : null}
          <span>{ago(thread?.updatedAt ?? item.server?.updatedAt ?? now, now)}</span>
          {/* Last and shortened: branch names run long. */}
          {branch ? <span className="jf-palette-branch"><Highlight text={branch} ranges={item.ranges.branch} /></span> : null}
        </span>
        {item.snippet ? (
          <span className="jf-palette-snippet">
            <Highlight text={item.snippet.text} ranges={item.snippet.ranges} />
          </span>
        ) : null}
      </span>
      {/* The PR chip already says what a PR status would. */}
      {thread && status.label !== "Idle" && !PR_GLYPHS.has(status.glyph) ? <span className="jf-palette-detail">{status.label}</span> : null}
    </>
  );
}

// --- preview pane ------------------------------------------------------------------------

/** What the selected thread is about, beside the results on wide windows. */
function PalettePreview({
  threadId,
  flow,
  thread,
  hit,
  project,
  section,
  workspace,
  now,
}: {
  threadId: string;
  flow: FlowState | null;
  thread: PluginSidebarThread | undefined;
  hit: ServerHit | undefined;
  project: (projectId: string) => { name: string; isPersonal: boolean } | undefined;
  section: (sectionId: string) => string | null;
  workspace: string | null;
  now: number;
}) {
  const { pullRequest } = useSidebarThreadPullRequest(threadId);
  const updatedAt = thread?.updatedAt ?? hit?.updatedAt ?? 0;
  // Arrowing past a row shouldn't fetch it.
  const preview = useThreadPreview(threadId, updatedAt, 150);
  const prs = threadPrs(flow?.threadPrs[threadId], pullRequest);
  const owner = project(thread?.projectId ?? hit?.projectId ?? "");
  const details = [
    owner && !owner.isPersonal ? owner.name : null,
    workspace,
    thread?.sectionId ? section(thread.sectionId) : null,
    thread?.environment?.branchName ? `⎇ ${thread.environment.branchName}` : null,
    updatedAt ? `updated ${ago(updatedAt, now)}` : null,
    preview && preview.prompts > 0 ? `${preview.prompts} prompts` : null,
    ...(flow?.tags[threadId] ?? []).map((tag) => `#${tag}`),
  ].filter((detail): detail is string => Boolean(detail));
  return (
    <div className="jf-palette-preview-card space-y-2.5">
      <ThreadPreviewCard
        title={thread?.displayTitle ?? hit?.title ?? "Untitled thread"}
        status={threadStatus(thread, hit, flow, prs, now)}
        preview={preview}
        prs={prs}
        watching={flow?.watching[threadId]}
        snoozeUntil={flow?.snoozes[threadId]?.until}
        details={details}
        prLimit={6}
      />
    </div>
  );
}

/** Shown in the preview pane when the selection isn't a thread. */
function PaletteTips({ mod }: { mod: string }) {
  return (
    <div className="jf-palette-tips">
      <p className="jf-palette-tips-heading">Tips</p>
      <dl>
        <dt><kbd>&gt;</kbd></dt><dd>Actions</dd>
        <dt><kbd>#</kbd></dt><dd>Pull requests, or <code>#123</code> for one</dd>
        <dt><kbd>@</kbd></dt><dd>Workspaces and projects</dd>
        <dt><kbd>/</kbd></dt><dd>Files in this thread's checkout</dd>
        <dt><code>is:needs</code></dt><dd>Also <code>is:running</code>, <code>is:autopilot</code>, <code>is:ready</code>, <code>is:snoozed</code>, <code>is:unread</code>, <code>is:pinned</code>, <code>is:pr</code></dd>
        <dt><kbd>⇥</kbd></dt><dd>A thread's actions: reply, snooze <code>tomorrow</code>, <code>tag urgent</code>, move</dd>
        <dt><kbd>{mod}↵</kbd></dt><dd>Open a thread in a split</dd>
      </dl>
    </div>
  );
}
