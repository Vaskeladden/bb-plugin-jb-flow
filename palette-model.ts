// The palette's model: query parsing, fuzzy matching, ranking, the triage home
// shown for an empty query, frecency and shortcut matching. Pure (no React, no
// SDK at runtime) so node:test covers it; palette.tsx renders the sections this
// returns and owns every side effect.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { PrStatus } from "./prs";
import type { FlowState } from "./server";
import { threadState, type ThreadStateId } from "./thread-states.ts";

export type Range = [start: number, end: number];

// --- query ---------------------------------------------------------------------

export type Scope = "all" | "threads" | "actions" | "prs" | "places" | "files";
/** A first character that narrows the palette, like `>` in an editor. */
export const SCOPE_PREFIX: Record<string, Exclude<Scope, "all">> = { ">": "actions", "#": "prs", "@": "places", "/": "files" };
export const SCOPE_LABEL: Record<Exclude<Scope, "all">, string> = {
  // Reached from a group's "Show all" row: every thread and message match, uncapped.
  threads: "Threads & messages",
  actions: "Actions",
  prs: "Pull requests",
  places: "Workspaces & projects",
  files: "Files",
};

export type Filter = ThreadStateId | "snoozed" | "unread" | "pinned" | "pr";
const FILTER_WORDS: Record<string, Filter> = {
  needs: "needs",
  "needs-me": "needs",
  me: "needs",
  running: "running",
  working: "running",
  autopilot: "autopilot",
  auto: "autopilot",
  waiting: "autopilot",
  ready: "ready",
  done: "ready",
  snoozed: "snoozed",
  unread: "unread",
  pinned: "pinned",
  pr: "pr",
  prs: "pr",
};
export const FILTER_HINTS = ["is:needs", "is:running", "is:autopilot", "is:ready", "is:snoozed", "is:unread", "is:pinned", "is:pr"] as const;

export type Query = { text: string; tokens: string[]; filters: Filter[] };

/** `is:` words become filters; everything else is free text, matched word by word. */
export function parseQuery(raw: string): Query {
  const filters: Filter[] = [];
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/).filter(Boolean)) {
    const filter = /^is:(.+)$/i.exec(word)?.[1];
    const known = filter === undefined ? undefined : FILTER_WORDS[filter.toLowerCase()];
    if (known) {
      if (!filters.includes(known)) filters.push(known);
    } else words.push(word);
  }
  const text = words.join(" ");
  return { text, tokens: words.map((word) => word.toLowerCase()), filters };
}

// --- matching ------------------------------------------------------------------

const BOUNDARY = /[\s\-_/.:#()[\]{}'"`,·]/;

function wordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  if (BOUNDARY.test(previous)) return true;
  const current = text[index]!;
  // camelCase and PascalCase humps.
  return previous === previous.toLowerCase() && previous !== previous.toUpperCase() && current !== current.toLowerCase();
}

function initials(token: string, text: string): Range[] | null {
  const ranges: Range[] = [];
  let next = 0;
  for (let index = 0; index < text.length && next < token.length; index++) {
    if (wordStart(text, index) && text[index]!.toLowerCase() === token[next]) {
      ranges.push([index, index + 1]);
      next++;
    }
  }
  return next === token.length ? ranges : null;
}

export type TokenMatch = { score: number; ranges: Range[] };

/**
 * One lower-case word against one text. Best first: the whole text, its start,
 * a word start, anywhere, the initials of its words, then its letters in order
 * when they sit close together. `strict` stops after "anywhere": loose letters
 * find something in any long text (a thread's 40 PR titles), so only titles
 * get them.
 */
export function matchToken(token: string, text: string, strict = false): TokenMatch | null {
  if (!token || !text) return null;
  const lower = text.toLowerCase();
  const first = lower.indexOf(token);
  if (first >= 0) {
    let at = first;
    for (let index = first; index >= 0; index = lower.indexOf(token, index + 1)) {
      if (wordStart(text, index)) {
        at = index;
        break;
      }
    }
    const base = lower.length === token.length ? 100 : at === 0 ? 85 : wordStart(text, at) ? 70 : 45;
    return { score: base + Math.min(token.length, 12), ranges: [[at, at + token.length]] };
  }
  if (strict || token.length < 2) return null;
  const acronym = initials(token, text);
  if (acronym) return { score: 60, ranges: acronym };
  const ranges: Range[] = [];
  let from = 0;
  for (const char of token) {
    const index = lower.indexOf(char, from);
    if (index < 0) return null;
    const last = ranges.at(-1);
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
    from = index + 1;
  }
  const span = ranges.at(-1)![1] - ranges[0]![0];
  if (span > token.length * 2 + 3) return null;
  return { score: Math.max(8, 30 - (span - token.length) * 2 - ranges.length), ranges };
}

export type Field = { key: string; text: string; weight: number; strict?: boolean };
export type FieldsMatch = { score: number; ranges: Record<string, Range[]> };

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Every word must match some field; each counts its best weighted field. The
 * score is the average per word, plus a bonus when all words hit the first
 * field (the title), so "fix billing" prefers the thread called that.
 */
export function matchFields(tokens: readonly string[], fields: readonly Field[]): FieldsMatch | null {
  if (tokens.length === 0) return { score: 0, ranges: {} };
  let total = 0;
  let allFirst = true;
  const ranges: Record<string, Range[]> = {};
  for (const token of tokens) {
    let best: { field: Field; match: TokenMatch } | null = null;
    for (const field of fields) {
      const match = matchToken(token, field.text, field.strict);
      if (match && (best === null || match.score * field.weight > best.match.score * best.field.weight)) best = { field, match };
    }
    if (best === null) return null;
    if (best.field !== fields[0]) allFirst = false;
    total += best.match.score * best.field.weight;
    (ranges[best.field.key] ??= []).push(...best.match.ranges);
  }
  for (const key of Object.keys(ranges)) ranges[key] = mergeRanges(ranges[key]!);
  return { score: total / tokens.length + (allFirst ? 15 : 0), ranges };
}

// --- frecency and recents --------------------------------------------------------

export type Frecency = Record<string, { count: number; last: number }>;
const HALF_LIFE_MS = 3 * 86_400_000;

function frecencyWeight(entry: Frecency[string] | undefined, now: number): number {
  if (!entry) return 0;
  return entry.count * 0.5 ** (Math.max(0, now - entry.last) / HALF_LIFE_MS);
}

/** Up to 25 points for things you pick often and lately; halves every three days. */
export function frecencyBoost(entry: Frecency[string] | undefined, now: number): number {
  const weight = frecencyWeight(entry, now);
  return weight <= 0 ? 0 : Math.min(25, 10 * Math.log2(1 + weight));
}

export function recordUse(frecency: Frecency, id: string, now: number, limit = 200): Frecency {
  const next: Frecency = { ...frecency, [id]: { count: frecencyWeight(frecency[id], now) + 1, last: now } };
  const ids = Object.keys(next);
  if (ids.length <= limit) return next;
  ids.sort((a, b) => frecencyWeight(next[b], now) - frecencyWeight(next[a], now));
  return Object.fromEntries(ids.slice(0, limit).map((key) => [key, next[key]!]));
}

export function pushRecent(recent: readonly string[], id: string, limit = 20): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, limit);
}

// --- inputs and items -----------------------------------------------------------

export type PaletteThread = Pick<
  PluginSidebarThread,
  | "id"
  | "projectId"
  | "displayTitle"
  | "sectionId"
  | "status"
  | "indicator"
  | "hasPendingInteraction"
  | "isUnread"
  | "isPinned"
  | "isHidden"
  | "isArchived"
  | "updatedAt"
  | "latestAttentionAt"
> & { environment: { branchName: string | null } | null };
export type PalettePr = Pick<PrStatus, "repo" | "number" | "title" | "url" | "state" | "attention">;
export type PaletteFlow = Pick<FlowState, "awaiting" | "running" | "watching" | "snoozes" | "tags"> &
  Partial<Pick<FlowState, "promised" | "waitingOthers">> & {
  threadPrs: Record<string, readonly PalettePr[]>;
};
/** An action the palette can rank; palette.tsx keeps what it runs, by id. */
export type PaletteAction = { id: string; title: string; keywords?: string; thread?: boolean };
export type Snippet = { text: string; ranges: Range[] };
/** A thread bb's full-text search found, with the message that matched. */
export type ServerHit = {
  threadId: string;
  title: string;
  projectId: string;
  archived: boolean;
  updatedAt: number;
  snippet: Snippet | null;
};

export type PaletteInput = {
  threads: readonly PaletteThread[];
  projects: readonly { id: string; name: string; isPersonal: boolean }[];
  sections: readonly { id: string; name: string }[];
  /** Empty while the Workspaces setting is off. */
  workspaces: readonly { id: string; name: string }[];
  /** Each thread's workspace id, null for none. */
  workspaceOf: Readonly<Record<string, string | null>>;
  /** The workspace tab: null is All, "unassigned" is No workspace. */
  selectedWorkspace: string | null;
  flow: PaletteFlow | null;
  currentThreadId: string | null;
  recent: readonly string[];
  frecency: Frecency;
  actions: readonly PaletteAction[];
  server: readonly ServerHit[] | null;
  /** The open thread's checkout files matching the query, from bb's quick open; null outside the files scope. */
  files: readonly { name: string; path: string }[] | null;
  now: number;
};

export type PaletteItem =
  | {
      kind: "thread";
      id: string;
      threadId: string;
      ranges: Record<string, Range[]>;
      snippet: Snippet | null;
      /** What full-text search knows, for threads this window hasn't loaded (archived ones). */
      server: ServerHit | null;
    }
  | { kind: "pr"; id: string; threadId: string; pr: PalettePr; ranges: Record<string, Range[]> }
  | { kind: "workspace"; id: string; workspaceId: string | null; name: string; ranges: Record<string, Range[]> }
  | { kind: "project"; id: string; projectId: string; name: string; compose: boolean; ranges: Record<string, Range[]> }
  | { kind: "action"; id: string; actionId: string; title: string; ranges: Record<string, Range[]> }
  | { kind: "file"; id: string; path: string; name: string; ranges: Record<string, Range[]> }
  /** "Show all": the rest of a capped group, in its own scope. */
  | { kind: "more"; id: string; scope: Exclude<Scope, "all">; label: string }
  | { kind: "compose"; id: "compose"; prompt: string };

export type GroupId =
  | "needs"
  | "running"
  | "pr-attention"
  | "recent"
  | "this-thread"
  | "threads"
  | "messages"
  | "archived"
  | "prs"
  | "places"
  | "actions"
  | "pages"
  | "files"
  | "compose";
export const GROUP_TITLE: Record<GroupId, string> = {
  needs: "Needs you",
  running: "Running",
  "pr-attention": "PRs to act on",
  recent: "Recent",
  "this-thread": "This thread",
  threads: "Threads",
  messages: "Messages",
  archived: "Archived",
  prs: "Pull requests",
  places: "Workspaces & projects",
  actions: "Actions",
  pages: "Dashboards & pages",
  files: "Files",
  compose: "New thread",
};
export type Section = { id: GroupId; title: string; items: PaletteItem[] };

/** Worst first, so what most needs attention leads. */
export const PR_ATTENTION_RANK: Record<string, number> = {
  conflicts: 0,
  checks_failed: 1,
  changes_requested: 2,
  blocked: 3,
  checks_pending: 4,
  review_requested: 5,
  ready_to_merge: 6,
  draft: 7,
  none: 8,
  merged: 9,
  closed: 10,
};
const ACTIONABLE = new Set(["conflicts", "checks_failed", "changes_requested", "ready_to_merge"]);

const DAY_MS = 86_400_000;
const busy = (thread: PaletteThread) => thread.status === "active" || thread.status === "starting";
const visible = (thread: PaletteThread) => !thread.isHidden && !thread.isArchived;
const stateOf = (thread: PaletteThread, flow: PaletteFlow | null) => threadState(thread, flow).state;
const attention = (thread: PaletteThread, flow: PaletteFlow | null) => stateOf(thread, flow) === "needs";

function passes(thread: PaletteThread, filters: readonly Filter[], flow: PaletteFlow | null): boolean {
  return filters.every((filter) => {
    switch (filter) {
      case "needs":
      case "running":
      case "autopilot":
      case "ready":
        // The thread's one state (thread-states.ts); snoozed threads have none.
        return flow?.snoozes[thread.id] === undefined && stateOf(thread, flow) === filter;
      case "snoozed":
        return flow?.snoozes[thread.id] !== undefined;
      case "unread":
        return thread.isUnread;
      case "pinned":
        return thread.isPinned;
      case "pr":
        return (flow?.threadPrs[thread.id]?.length ?? 0) > 0;
    }
  });
}

type Scored = { item: PaletteItem; score: number };

function indexes(input: PaletteInput) {
  return {
    projects: new Map(input.projects.map((project) => [project.id, project])),
    sections: new Map(input.sections.map((section) => [section.id, section.name])),
    workspaces: new Map(input.workspaces.map((workspace) => [workspace.id, workspace.name])),
    threads: new Map(input.threads.map((thread) => [thread.id, thread])),
  };
}

function threadFields(thread: PaletteThread, input: PaletteInput, index: ReturnType<typeof indexes>): Field[] {
  const project = index.projects.get(thread.projectId);
  const workspace = input.workspaceOf[thread.id];
  return [
    { key: "title", text: thread.displayTitle, weight: 1 },
    { key: "project", text: project && !project.isPersonal ? project.name : "", weight: 0.6, strict: true },
    { key: "branch", text: thread.environment?.branchName ?? "", weight: 0.55, strict: true },
    { key: "prs", text: (input.flow?.threadPrs[thread.id] ?? []).map((pr) => `#${pr.number} ${pr.title}`).join(" · "), weight: 0.7, strict: true },
    { key: "tags", text: (input.flow?.tags[thread.id] ?? []).join(" "), weight: 0.6, strict: true },
    { key: "workspace", text: workspace ? (index.workspaces.get(workspace) ?? "") : "", weight: 0.5, strict: true },
    { key: "section", text: thread.sectionId ? (index.sections.get(thread.sectionId) ?? "") : "", weight: 0.45, strict: true },
  ];
}

/** Ranking nudges on top of the text match: what you use, where you are, what's waiting. */
function threadBoost(thread: PaletteThread, input: PaletteInput): number {
  let boost = frecencyBoost(input.frecency[`thread:${thread.id}`], input.now);
  const selected = input.selectedWorkspace;
  if (selected !== null && (input.workspaceOf[thread.id] ?? null) === (selected === "unassigned" ? null : selected)) boost += 12;
  if (attention(thread, input.flow)) boost += 8;
  else if (busy(thread)) boost += 4;
  const age = input.now - thread.updatedAt;
  boost += age < DAY_MS ? 6 : age < 7 * DAY_MS ? 3 : 0;
  // You're already there.
  if (thread.id === input.currentThreadId) boost -= 10;
  return boost;
}

const threadItem = (threadId: string, ranges: Record<string, Range[]> = {}, snippet: Snippet | null = null, server: ServerHit | null = null): PaletteItem => ({
  kind: "thread",
  id: `thread:${threadId}`,
  threadId,
  ranges,
  snippet,
  server,
});

function prItems(input: PaletteInput, index: ReturnType<typeof indexes>): { pr: PalettePr; threadId: string }[] {
  const items: { pr: PalettePr; threadId: string }[] = [];
  const seen = new Set<string>();
  for (const [threadId, prs] of Object.entries(input.flow?.threadPrs ?? {})) {
    if (index.threads.get(threadId)?.isHidden) continue;
    for (const pr of prs) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      items.push({ pr, threadId });
    }
  }
  return items;
}

const prItem = (pr: PalettePr, threadId: string, ranges: Record<string, Range[]> = {}): PaletteItem => ({
  kind: "pr",
  id: `pr:${pr.url}`,
  threadId,
  pr,
  ranges,
});
const prRank = (pr: PalettePr) => PR_ATTENTION_RANK[pr.attention] ?? 9;

// --- the empty query: a triage home ------------------------------------------------

/** What needs you, what's running, PRs to act on, where you've been, and this thread's actions. */
export function home(input: PaletteInput): Section[] {
  const index = indexes(input);
  const seen = new Set<string>();
  const live = input.threads.filter(visible);
  const take = (threads: readonly PaletteThread[], limit: number) =>
    threads
      .filter((thread) => !seen.has(thread.id))
      .slice(0, limit)
      .map((thread) => {
        seen.add(thread.id);
        return threadItem(thread.id);
      });
  const sections: Section[] = [];
  const add = (id: GroupId, items: PaletteItem[]) => {
    if (items.length > 0) sections.push({ id, title: GROUP_TITLE[id], items });
  };
  add(
    "needs",
    take(
      live
        .filter((thread) => attention(thread, input.flow) && input.flow?.snoozes[thread.id] === undefined)
        .sort((a, b) => a.latestAttentionAt - b.latestAttentionAt),
      5,
    ),
  );
  const since = (thread: PaletteThread) => input.flow?.running[thread.id]?.since ?? thread.updatedAt;
  add("running", take(live.filter(busy).sort((a, b) => since(a) - since(b)), 5));
  add(
    "pr-attention",
    prItems(input, index)
      .filter(({ pr }) => (pr.state === "open" || pr.state === "draft") && ACTIONABLE.has(pr.attention))
      .sort((a, b) => prRank(a.pr) - prRank(b.pr))
      .slice(0, 5)
      .map(({ pr, threadId }) => prItem(pr, threadId)),
  );
  const recent = input.recent
    .map((id) => index.threads.get(id))
    .filter((thread): thread is PaletteThread => thread !== undefined && visible(thread) && thread.id !== input.currentThreadId);
  // Before you've been anywhere, the latest threads stand in.
  const fallback = [...live].filter((thread) => thread.id !== input.currentThreadId).sort((a, b) => b.updatedAt - a.updatedAt);
  add("recent", take(recent.length > 0 ? recent : fallback, 6));
  if (input.currentThreadId !== null) {
    add(
      "this-thread",
      input.actions
        .filter((action) => action.thread)
        .slice(0, 8)
        .map((action) => ({ kind: "action", id: `action:${action.id}`, actionId: action.id, title: action.title, ranges: {} })),
    );
  }
  return sections;
}

// --- search ------------------------------------------------------------------------

const PRIORITY: GroupId[] = ["pages", "threads", "prs", "places", "actions", "messages", "archived"];
/** Where a capped group's "Show all" row leads. */
const MORE: Partial<Record<GroupId, { scope: Exclude<Scope, "all">; noun: string }>> = {
  threads: { scope: "threads", noun: "threads" },
  messages: { scope: "threads", noun: "message matches" },
  archived: { scope: "threads", noun: "archived matches" },
  prs: { scope: "prs", noun: "pull requests" },
  places: { scope: "places", noun: "workspaces and projects" },
  actions: { scope: "actions", noun: "actions" },
  pages: { scope: "actions", noun: "pages" },
};

/**
 * One ranked list across kinds. Groups follow their best hit; a new thread
 * from the query always comes last. A scope shows one kind, uncapped.
 */
export function search(input: PaletteInput, scope: Scope, raw: string): Section[] {
  const query = parseQuery(raw);
  const { tokens, filters } = query;
  const empty = tokens.length === 0;
  const index = indexes(input);
  const groups = new Map<GroupId, Scored[]>();
  const push = (group: GroupId, scored: Scored) => {
    const list = groups.get(group) ?? [];
    list.push(scored);
    groups.set(group, list);
  };

  if (scope === "all" || scope === "threads") {
    const listed = new Map<string, Scored>();
    for (const thread of input.threads) {
      if (!visible(thread) || !passes(thread, filters, input.flow)) continue;
      const match = matchFields(tokens, threadFields(thread, input, index));
      if (match === null) continue;
      const scored = { item: threadItem(thread.id, match.ranges), score: match.score + threadBoost(thread, input) };
      listed.set(thread.id, scored);
      push("threads", scored);
    }
    if (!empty) {
      input.server?.forEach((hit, order) => {
        const known = index.threads.get(hit.threadId);
        const already = listed.get(hit.threadId);
        if (already) {
          if (already.item.kind === "thread" && already.item.snippet === null && hit.snippet) already.item.snippet = hit.snippet;
          return;
        }
        if (known?.isHidden || (filters.length > 0 && (known === undefined || !passes(known, filters, input.flow)))) return;
        const archived = hit.archived || known?.isArchived === true;
        const score = 30 - order + (known ? threadBoost(known, input) : 0);
        push(archived ? "archived" : "messages", { item: threadItem(hit.threadId, {}, hit.snippet, hit), score });
      });
    }
  }

  if (scope === "prs" || (scope === "all" && !empty && filters.length === 0)) {
    for (const { pr, threadId } of prItems(input, index)) {
      const open = pr.state === "open" || pr.state === "draft";
      if (empty) {
        push("prs", { item: prItem(pr, threadId), score: (open ? 100 : 40) - prRank(pr) });
        continue;
      }
      const fields: Field[] = [
        // PR titles run long; loose letters would find most of them.
        { key: "title", text: `#${pr.number} ${pr.title}`, weight: 1, strict: true },
        { key: "repo", text: pr.repo, weight: 0.5, strict: true },
        { key: "thread", text: index.threads.get(threadId)?.displayTitle ?? "", weight: 0.4, strict: true },
        { key: "attention", text: pr.attention.replace(/_/g, " "), weight: 0.4, strict: true },
      ];
      const match = matchFields(tokens, fields);
      if (match === null) continue;
      const exact = tokens.some((token) => token.replace(/^#/, "") === String(pr.number)) ? 40 : 0;
      push("prs", { item: prItem(pr, threadId, match.ranges), score: match.score + exact + (open ? 5 : 0) });
    }
  }

  if (scope === "places" || (scope === "all" && !empty && filters.length === 0)) {
    const places: { item: PaletteItem; text: string; keyword: string; order: number }[] = [];
    if (input.workspaces.length > 0) {
      for (const workspace of input.workspaces)
        places.push({ item: { kind: "workspace", id: `workspace:${workspace.id}`, workspaceId: workspace.id, name: workspace.name, ranges: {} }, text: workspace.name, keyword: "workspace switch", order: places.length });
      places.push({ item: { kind: "workspace", id: "workspace:all", workspaceId: null, name: "All workspaces", ranges: {} }, text: "All workspaces", keyword: "workspace switch", order: places.length });
      places.push({ item: { kind: "workspace", id: "workspace:unassigned", workspaceId: "unassigned", name: "No workspace", ranges: {} }, text: "No workspace", keyword: "workspace switch", order: places.length });
    }
    for (const project of input.projects) {
      places.push({ item: { kind: "project", id: `project:${project.id}`, projectId: project.id, name: project.name, compose: false, ranges: {} }, text: project.name, keyword: "project open", order: places.length });
      places.push({ item: { kind: "project", id: `project-new:${project.id}`, projectId: project.id, name: project.name, compose: true, ranges: {} }, text: project.name, keyword: "new thread project", order: places.length });
    }
    for (const place of places) {
      const boost = frecencyBoost(input.frecency[place.item.id], input.now);
      if (empty) {
        // Listing every project twice reads as noise; "New thread in …" shows once you type.
        if (place.item.kind === "project" && place.item.compose) continue;
        push("places", { item: place.item, score: boost - place.order / 100 });
        continue;
      }
      const match = matchFields(tokens, [
        { key: "title", text: place.text, weight: 1 },
        { key: "keyword", text: place.keyword, weight: 0.35, strict: true },
      ]);
      if (match === null) continue;
      const item = { ...place.item, ranges: match.ranges } as PaletteItem;
      // Starting a thread in a project is a step further than opening it.
      const compose = item.kind === "project" && item.compose ? -6 : 0;
      push("places", { item, score: match.score + boost + compose });
    }
  }

  if (scope === "files") {
    // bb's quick open already ranked these; keep its order and highlight what matches.
    input.files?.forEach((file, order) => {
      const match = matchFields(tokens, [
        { key: "title", text: file.name, weight: 1 },
        { key: "path", text: file.path, weight: 0.7, strict: true },
      ]);
      push("files", { item: { kind: "file", id: `file:${file.path}`, path: file.path, name: file.name, ranges: match?.ranges ?? {} }, score: 1000 - order });
    });
  }

  if (scope === "actions" || (scope === "all" && !empty && filters.length === 0)) {
    input.actions.forEach((action, order) => {
      const item: PaletteItem = { kind: "action", id: `action:${action.id}`, actionId: action.id, title: action.title, ranges: {} };
      const boost = frecencyBoost(input.frecency[item.id], input.now);
      if (empty) {
        push("actions", { item, score: boost - order / 100 });
        return;
      }
      // Moving the thread only when the query asks for it: typing a section's
      // name («bugs») to find its page must never move the current thread.
      if (/^(?:lane|section):/.test(action.id) && !tokens.some((token) => /^(?:move|mv|flytt)/i.test(token))) return;
      // A dashboard or page whose name you typed beats any thread: it is the
      // one place with that name. Its name must really match, not loose letters.
      if (action.id.startsWith("page:")) {
        const page = matchFields(tokens, [{ key: "title", text: action.title, weight: 1, strict: true }]);
        if (page === null) return;
        push("pages", { item: { ...item, ranges: page.ranges }, score: page.score + boost + 1000 });
        return;
      }
      const match = matchFields(tokens, [
        { key: "title", text: action.title, weight: 1 },
        { key: "keywords", text: action.keywords ?? "", weight: 0.6, strict: true },
      ]);
      if (match === null) return;
      push("actions", { item: { ...item, ranges: match.ranges }, score: match.score + boost });
    });
  }

  const cap: Record<GroupId, number> = {
    needs: 5,
    running: 5,
    "pr-attention": 5,
    recent: 6,
    "this-thread": 8,
    threads: empty ? 50 : 8,
    messages: 6,
    archived: 4,
    prs: 5,
    places: 6,
    actions: 6,
    pages: 4,
    files: 50,
    compose: 1,
  };
  const ranked = [...groups.entries()].map(([id, list]) => {
    list.sort((a, b) => b.score - a.score);
    const limit = scope === "all" ? cap[id] : 50;
    const items = list.slice(0, limit).map((scored) => scored.item);
    const more = scope === "all" ? MORE[id] : undefined;
    if (more && list.length > limit) {
      items.push({ kind: "more", id: `more:${id}`, scope: more.scope, label: `Show all ${list.length} ${more.noun}` });
    }
    return { id, best: list[0]!.score, items };
  });
  ranked.sort((a, b) => b.best - a.best || PRIORITY.indexOf(a.id) - PRIORITY.indexOf(b.id));
  const sections: Section[] = ranked.map(({ id, items }) => ({ id, title: GROUP_TITLE[id], items }));
  if (scope === "all" && query.text.length > 0) {
    sections.push({ id: "compose", title: GROUP_TITLE.compose, items: [{ kind: "compose", id: "compose", prompt: query.text }] });
  }
  return sections;
}

/** Full-text search results in the shape the palette ranks: one row per thread, a message snippet when one matched. */
export function serverHits(response: {
  active: { results: readonly SearchResult[] };
  archived: { results: readonly SearchResult[] };
}): ServerHit[] {
  const hits: ServerHit[] = [];
  for (const [group, archived] of [
    [response.active, false],
    [response.archived, true],
  ] as const) {
    for (const result of group.results) {
      const thread = result.thread;
      if (thread.visibility === "hidden") continue;
      const message = result.matches.find((match) => match.sourceKind !== "title" && match.sourceKind !== "title_fallback");
      hits.push({
        threadId: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        projectId: thread.projectId,
        archived: archived || thread.archivedAt !== null,
        updatedAt: thread.updatedAt,
        snippet: message ? { text: message.text, ranges: message.highlightRanges.map(({ start, end }) => [start, end] as Range) } : null,
      });
    }
  }
  return hits;
}
type SearchResult = {
  matches: readonly { text: string; sourceKind: string; highlightRanges: readonly { start: number; end: number }[] }[];
  thread: {
    id: string;
    title: string | null;
    titleFallback: string | null;
    projectId: string;
    archivedAt: number | null;
    updatedAt: number;
    visibility?: string;
  };
};

// --- display helpers -----------------------------------------------------------------

export function ago(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  if (elapsed < 35 * DAY_MS) return `${Math.floor(elapsed / (7 * DAY_MS))}w ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- shortcuts -------------------------------------------------------------------------

export type Shortcut = { key: string; mod?: boolean; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean };
export type Platform = "mac" | "windows" | "linux";
export const DEFAULT_SEARCH_SHORTCUT: Shortcut = { key: "k", mod: true };
type Keybinding = { command: string; shortcut: Shortcut; when?: { all?: readonly string[]; none?: readonly string[] } };
const PLATFORM_FLAG: Record<Platform, string> = { mac: "macPlatform", windows: "windowsPlatform", linux: "linuxPlatform" };

/**
 * The keys bb's "Search threads" is bound to on this platform. The palette
 * takes over exactly those, so a rebinding moves it and unbinding turns it off.
 * Without bb's config (older hosts, a failed read) it assumes the default.
 */
export function searchShortcuts(keybindings: readonly Keybinding[] | null | undefined, platform: Platform): Shortcut[] {
  if (!keybindings) return [DEFAULT_SEARCH_SHORTCUT];
  const mine = PLATFORM_FLAG[platform];
  const others = Object.values(PLATFORM_FLAG).filter((flag) => flag !== mine);
  return keybindings
    .filter(
      (binding) =>
        binding.command === "thread.search" &&
        !(binding.when?.all ?? []).some((flag) => others.includes(flag)) &&
        !(binding.when?.none ?? []).includes(mine),
    )
    .map((binding) => binding.shortcut);
}

export type KeyLike = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export function matchesShortcut(event: KeyLike, shortcut: Shortcut, platform: Platform): boolean {
  const meta = shortcut.meta === true || (shortcut.mod === true && platform === "mac");
  const control = shortcut.control === true || (shortcut.mod === true && platform !== "mac");
  if (event.metaKey !== meta || event.ctrlKey !== control) return false;
  if (event.altKey !== (shortcut.alt === true) || event.shiftKey !== (shortcut.shift === true)) return false;
  const key = shortcut.key.toLowerCase();
  if (event.key.toLowerCase() === key) return true;
  // Option and Shift change `key` ("˚", "K"); the physical key still matches.
  if (/^[a-z]$/.test(key)) return event.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}`;
  return false;
}

export function shortcutLabel(shortcut: Shortcut, platform: Platform): string {
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key.replace(/^Arrow/, "");
  if (platform === "mac") {
    return [
      shortcut.control ? "⌃" : "",
      shortcut.alt ? "⌥" : "",
      shortcut.shift ? "⇧" : "",
      shortcut.mod || shortcut.meta ? "⌘" : "",
      key,
    ].join("");
  }
  return [
    shortcut.mod || shortcut.control ? "Ctrl" : "",
    shortcut.alt ? "Alt" : "",
    shortcut.shift ? "Shift" : "",
    shortcut.meta ? "Meta" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
