import assert from "node:assert/strict";
import { test } from "node:test";
import {
  frecencyBoost,
  home,
  matchToken,
  matchesShortcut,
  parseQuery,
  pushRecent,
  recordUse,
  search,
  searchShortcuts,
  serverHits,
  shortcutLabel,
  type PaletteInput,
  type PalettePr,
  type PaletteThread,
  type Section,
} from "./palette-model.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const thread = (id: string, displayTitle: string, changes: Partial<PaletteThread> = {}): PaletteThread => ({
  id,
  projectId: "p1",
  displayTitle,
  sectionId: null,
  status: "idle",
  indicator: "none",
  hasPendingInteraction: false,
  isUnread: false,
  isPinned: false,
  isHidden: false,
  isArchived: false,
  updatedAt: NOW - 10 * 24 * HOUR,
  latestAttentionAt: NOW - 10 * 24 * HOUR,
  environment: null,
  ...changes,
});

const pr = (number: number, attention: PalettePr["attention"], changes: Partial<PalettePr> = {}): PalettePr => ({
  repo: "acme/web-app",
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/web-app/pull/${number}`,
  state: "open",
  attention,
  ...changes,
});

const input = (changes: Partial<PaletteInput> = {}): PaletteInput => ({
  threads: [],
  projects: [
    { id: "p1", name: "web-app", isPersonal: false },
    { id: "p2", name: "billing-api", isPersonal: false },
  ],
  sections: [],
  workspaces: [],
  workspaceOf: {},
  selectedWorkspace: null,
  flow: { awaiting: {}, running: {}, watching: {}, snoozes: {}, tags: {}, threadPrs: {} },
  currentThreadId: null,
  recent: [],
  frecency: {},
  actions: [],
  server: null,
  files: null,
  now: NOW,
  ...changes,
});

const ids = (sections: readonly Section[]) => sections.map((section) => section.id);
const itemIds = (section: Section | undefined) => section?.items.map((item) => item.id) ?? [];
const group = (sections: readonly Section[], id: string) => sections.find((section) => section.id === id);

test("parseQuery splits is: filters from words", () => {
  assert.deepEqual(parseQuery("  Fix is:running  billing is:Needs is:bogus "), {
    text: "Fix billing is:bogus",
    tokens: ["fix", "billing", "is:bogus"],
    filters: ["running", "needs"],
  });
});

test("matchToken prefers word starts and keeps ranges on the original text", () => {
  assert.deepEqual(matchToken("bill", "Fix billing")?.ranges, [[4, 8]]);
  assert.ok(matchToken("bill", "Billing")!.score > matchToken("bill", "Fix billing")!.score);
  assert.ok(matchToken("ill", "Fix billing")!.score < matchToken("bill", "Fix billing")!.score);
  // Initials, then close letters in order; far-apart letters don't count.
  assert.deepEqual(matchToken("fb", "Fix billing")?.ranges, [[0, 1], [4, 5]]);
  assert.ok(matchToken("fxb", "fix billing") !== null);
  assert.equal(matchToken("zq", "Fix billing"), null);
  assert.equal(matchToken("fg", "xfooooooooooooog"), null);
});

test("loose letter matches only count in titles", () => {
  const flow = { ...input().flow!, threadPrs: { b: [pr(1, "merged", { title: "Pay all endpoints, then test everything" })] } };
  const threads = [thread("a", "Command palette"), thread("b", "Exports")];
  // "palette" is in no PR title as a word, though its letters are, in order.
  assert.deepEqual(itemIds(group(search(input({ threads, flow }), "all", "palette"), "threads")), ["thread:a"]);
  assert.equal(matchToken("plt", "Command palette") !== null, true);
  assert.equal(matchToken("plt", "Command palette", true), null);
  assert.equal(matchToken("palette", "feat(platform-addons): let the worker write"), null);
  const prs = { ...input().flow!, threadPrs: { b: [pr(872, "merged", { title: "platform-addons: let the sync worker write" }), pr(20, "merged", { title: "Palette: ⌘K" })] } };
  assert.deepEqual(itemIds(search(input({ threads, flow: prs }), "prs", "palette")[0]), ["pr:https://github.com/acme/web-app/pull/20"]);
});

test("a word-start title hit outranks a mid-word one", () => {
  const sections = search(
    input({ threads: [thread("a", "Unbilled invoices"), thread("b", "Billing export")] }),
    "all",
    "bill",
  );
  assert.deepEqual(itemIds(group(sections, "threads")), ["thread:b", "thread:a"]);
  const first = group(sections, "threads")!.items[0]!;
  assert.deepEqual(first.kind === "thread" && first.ranges, { title: [[0, 4]] });
});

test("threads match on project, branch, tags and PR numbers too", () => {
  const flow = { ...input().flow!, tags: { c: ["urgent"] }, threadPrs: { d: [pr(123, "checks_failed")] } };
  const threads = [
    thread("a", "Login", { projectId: "p2" }),
    thread("b", "Cleanup", { environment: { branchName: "feat/dark-mode" } }),
    thread("c", "Docs"),
    thread("d", "Export"),
  ];
  const find = (query: string) => itemIds(group(search(input({ threads, flow }), "all", query), "threads"));
  assert.deepEqual(find("billing"), ["thread:a"]);
  assert.deepEqual(find("dark"), ["thread:b"]);
  assert.deepEqual(find("urgent"), ["thread:c"]);
  assert.deepEqual(find("#123"), ["thread:d"]);
});

test("#123 finds the PR first in the PR scope", () => {
  const flow = { ...input().flow!, threadPrs: { d: [pr(12, "ready_to_merge"), pr(123, "checks_failed")] } };
  const sections = search(input({ threads: [thread("d", "Export")], flow }), "prs", "123");
  assert.deepEqual(ids(sections), ["prs"]);
  assert.equal(sections[0]!.items[0]!.id, "pr:https://github.com/acme/web-app/pull/123");
});

test("is: filters narrow threads and list them without text", () => {
  const flow = { ...input().flow!, snoozes: { b: { until: NOW + HOUR, note: null, fromSectionId: null, snoozedAt: NOW } } };
  const threads = [
    thread("a", "Deploy", { status: "active" }),
    thread("b", "Notes"),
    thread("c", "Question", { hasPendingInteraction: true }),
  ];
  const find = (query: string) => itemIds(group(search(input({ threads, flow }), "all", query), "threads"));
  assert.deepEqual(find("is:running"), ["thread:a"]);
  assert.deepEqual(find("is:snoozed"), ["thread:b"]);
  assert.deepEqual(find("is:needs"), ["thread:c"]);
  assert.deepEqual(find("is:needs deploy"), []);
  // Filters only apply to threads: no new-thread row for a bare filter.
  assert.equal(group(search(input({ threads, flow }), "all", "is:running"), "compose"), undefined);
});

test("scopes show one kind; actions keep their order without text", () => {
  const actions = [
    { id: "next", title: "Open the next thread that needs me" },
    { id: "new", title: "New thread" },
  ];
  assert.deepEqual(itemIds(search(input({ actions }), "actions", "")[0]), ["action:next", "action:new"]);
  const places = search(input({ workspaces: [{ id: "ws", name: "Client work" }] }), "places", "client");
  assert.deepEqual(ids(places), ["places"]);
  assert.deepEqual(itemIds(places[0]), ["workspace:ws"]);
  // Opening a project ranks above starting a thread in it; an empty scope lists each project once.
  assert.deepEqual(itemIds(search(input(), "places", "billing")[0]), ["project:p2", "project-new:p2"]);
  assert.deepEqual(itemIds(search(input(), "places", "")[0]), ["project:p1", "project:p2"]);
});

test("a new thread from the query is always offered last", () => {
  const sections = search(input({ threads: [thread("a", "Fix billing")] }), "all", "fix billing");
  assert.equal(sections.at(-1)!.id, "compose");
  assert.deepEqual(sections.at(-1)!.items[0], { kind: "compose", id: "compose", prompt: "fix billing" });
  assert.deepEqual(ids(search(input(), "all", "nothing matches this")), ["compose"]);
  assert.equal(group(search(input(), "actions", "new"), "compose"), undefined);
});

test("the current workspace, frecency and attention lift a thread", () => {
  const threads = [thread("a", "Report"), thread("b", "Report")];
  const plain = itemIds(group(search(input({ threads }), "all", "report"), "threads"));
  assert.deepEqual(plain, ["thread:a", "thread:b"]);
  const inWorkspace = input({ threads, workspaces: [{ id: "ws", name: "Ops" }], workspaceOf: { b: "ws" }, selectedWorkspace: "ws" });
  assert.deepEqual(itemIds(group(search(inWorkspace, "all", "report"), "threads")), ["thread:b", "thread:a"]);
  const used = input({ threads, frecency: { "thread:b": { count: 3, last: NOW - HOUR } } });
  assert.deepEqual(itemIds(group(search(used, "all", "report"), "threads")), ["thread:b", "thread:a"]);
  const waiting = input({ threads: [threads[0]!, thread("b", "Report", { indicator: "waiting-for-input" })] });
  assert.deepEqual(itemIds(group(search(waiting, "all", "report"), "threads")), ["thread:b", "thread:a"]);
});

test("server hits add a snippet to listed threads and append the rest", () => {
  const response = {
    active: {
      results: [
        { matches: [{ text: "Fix billing", sourceKind: "title", highlightRanges: [] }, { text: "the invoice total is wrong", sourceKind: "user_message", highlightRanges: [{ start: 4, end: 11 }] }], thread: { id: "a", title: "Fix billing", titleFallback: null, projectId: "p1", archivedAt: null, updatedAt: NOW } },
        { matches: [{ text: "send the invoice", sourceKind: "assistant_message", highlightRanges: [{ start: 9, end: 16 }] }], thread: { id: "b", title: "Mail", titleFallback: null, projectId: "p1", archivedAt: null, updatedAt: NOW } },
        { matches: [], thread: { id: "h", title: "Hidden", titleFallback: null, projectId: "p1", archivedAt: null, updatedAt: NOW, visibility: "hidden" } },
      ],
    },
    archived: {
      results: [{ matches: [], thread: { id: "z", title: null, titleFallback: "Old invoice run", projectId: "p2", archivedAt: NOW - HOUR, updatedAt: NOW - HOUR } }],
    },
  };
  const server = serverHits(response);
  assert.deepEqual(server.map((hit) => [hit.threadId, hit.archived]), [["a", false], ["b", false], ["z", true]]);
  assert.equal(server[2]!.title, "Old invoice run");
  const sections = search(input({ threads: [thread("a", "Invoice fixes"), thread("b", "Mail")], server }), "all", "invoice");
  const listed = group(sections, "threads")!.items[0]!;
  assert.equal(listed.kind === "thread" && listed.snippet?.text, "the invoice total is wrong");
  assert.deepEqual(itemIds(group(sections, "messages")), ["thread:b"]);
  assert.deepEqual(itemIds(group(sections, "archived")), ["thread:z"]);
});

test("home lists needs-you, running, PRs to act on, recent and this thread, without repeats", () => {
  const flow = {
    ...input().flow!,
    awaiting: { c: NOW - HOUR },
    running: { r: { since: NOW - HOUR, lastEventAt: NOW } },
    threadPrs: { p: [pr(7, "checks_failed"), pr(8, "checks_pending"), pr(9, "merged", { state: "merged" })] },
    // Its red PR is watched, so p is on autopilot, not Needs you.
    watching: { p: { kind: "ci" as const, label: "Watching web-app#7 (checks)" } },
    snoozes: { s: { until: NOW + HOUR, note: null, fromSectionId: null, snoozedAt: NOW } },
  };
  const threads = [
    thread("q", "Question", { hasPendingInteraction: true, latestAttentionAt: NOW - 2 * HOUR }),
    thread("c", "Asks you", { isUnread: true, latestAttentionAt: NOW - 3 * HOUR }),
    thread("s", "Snoozed ask", { hasPendingInteraction: true }),
    thread("r", "Deploying", { status: "active" }),
    thread("p", "Has PRs"),
    thread("x", "Archived", { isArchived: true }),
    thread("here", "Current"),
  ];
  const sections = home(
    input({
      threads,
      flow,
      currentThreadId: "here",
      recent: ["here", "q", "x", "p"],
      actions: [{ id: "snooze", title: "Snooze…", thread: true }, { id: "next", title: "Next" }],
    }),
  );
  assert.deepEqual(ids(sections), ["needs", "running", "pr-attention", "recent", "this-thread"]);
  assert.deepEqual(itemIds(group(sections, "needs")), ["thread:c", "thread:q"]);
  assert.deepEqual(itemIds(group(sections, "running")), ["thread:r"]);
  assert.deepEqual(itemIds(group(sections, "pr-attention")), ["pr:https://github.com/acme/web-app/pull/7"]);
  // q is already listed; the current thread and archived threads aren't recent.
  assert.deepEqual(itemIds(group(sections, "recent")), ["thread:p"]);
  assert.deepEqual(itemIds(group(sections, "this-thread")), ["action:snooze"]);
});

test("home falls back to the latest threads before any visit", () => {
  const threads = [thread("a", "Old", { updatedAt: NOW - 5 * HOUR }), thread("b", "New", { updatedAt: NOW - HOUR })];
  assert.deepEqual(itemIds(group(home(input({ threads })), "recent")), ["thread:b", "thread:a"]);
});

test("frecency grows with use and halves every three days", () => {
  const once = recordUse({}, "thread:a", NOW);
  const twice = recordUse(once, "thread:a", NOW);
  assert.ok(frecencyBoost(twice["thread:a"], NOW) > frecencyBoost(once["thread:a"], NOW));
  const fresh = frecencyBoost(once["thread:a"], NOW);
  const later = frecencyBoost(once["thread:a"], NOW + 3 * 24 * HOUR);
  assert.ok(later < fresh && later > 0);
  assert.equal(frecencyBoost(undefined, NOW), 0);
  const capped = ["a", "b", "c"].reduce((all, id, index) => recordUse(all, id, NOW + index, 2), {});
  assert.deepEqual(Object.keys(capped).sort(), ["b", "c"]);
  assert.deepEqual(pushRecent(["a", "b", "c"], "b", 2), ["b", "a"]);
});

test("searchShortcuts follows bb's binding for this platform", () => {
  assert.deepEqual(searchShortcuts(null, "mac"), [{ key: "k", mod: true }]);
  const bindings = [
    { command: "palette.open", shortcut: { key: "p", mod: true, shift: true } },
    { command: "thread.search", shortcut: { key: "k", mod: true } },
    { command: "thread.search", shortcut: { key: "j", control: true }, when: { all: ["windowsPlatform"] } },
  ];
  assert.deepEqual(searchShortcuts(bindings, "mac"), [{ key: "k", mod: true }]);
  assert.equal(searchShortcuts(bindings, "windows").length, 2);
  // Unbound: no takeover.
  assert.deepEqual(searchShortcuts([bindings[0]!], "mac"), []);
});

test("matchesShortcut maps Mod per platform and survives Option/Shift keys", () => {
  const event = (changes: Partial<Parameters<typeof matchesShortcut>[0]>) => ({ key: "k", code: "KeyK", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...changes });
  const modK = { key: "k", mod: true };
  assert.equal(matchesShortcut(event({ metaKey: true }), modK, "mac"), true);
  assert.equal(matchesShortcut(event({ ctrlKey: true }), modK, "mac"), false);
  assert.equal(matchesShortcut(event({ ctrlKey: true }), modK, "linux"), true);
  assert.equal(matchesShortcut(event({ metaKey: true, shiftKey: true, key: "K" }), modK, "mac"), false);
  assert.equal(matchesShortcut(event({ metaKey: true, altKey: true, key: "˚" }), { key: "k", mod: true, alt: true }, "mac"), true);
  assert.equal(shortcutLabel({ key: "k", mod: true, shift: true }, "mac"), "⇧⌘K");
  assert.equal(shortcutLabel({ key: "k", mod: true }, "windows"), "Ctrl+K");
});

test("a capped group ends with a Show all row into its scope", () => {
  const threads = Array.from({ length: 11 }, (_, index) => thread(`t${index}`, `Task ${index}`));
  const sections = search(input({ threads }), "all", "task");
  const listed = group(sections, "threads")!;
  assert.equal(listed.items.length, 9);
  assert.deepEqual(listed.items.at(-1), { kind: "more", id: "more:threads", scope: "threads", label: "Show all 11 threads" });
  // The scope itself lists them all, without the row.
  const all = search(input({ threads }), "threads", "task");
  assert.equal(all[0]!.items.length, 11);
  assert.equal(all[0]!.items.some((item) => item.kind === "more"), false);
  assert.equal(group(all, "compose"), undefined);
});

test("the files scope keeps bb's order and highlights names", () => {
  const files = [
    { name: "palette.tsx", path: "src/palette.tsx" },
    { name: "palette-model.ts", path: "src/palette-model.ts" },
    { name: "README.md", path: "README.md" },
  ];
  const sections = search(input({ files }), "files", "pal");
  assert.deepEqual(ids(sections), ["files"]);
  assert.deepEqual(itemIds(sections[0]), ["file:src/palette.tsx", "file:src/palette-model.ts", "file:README.md"]);
  const first = sections[0]!.items[0]!;
  assert.deepEqual(first.kind === "file" && first.ranges.title, [[0, 3]]);
  // Files only show in their own scope.
  assert.equal(group(search(input({ files }), "all", "pal"), "files"), undefined);
});
