import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread, PluginThreadActionEntry } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";
import type { WorkspaceState } from "./workspaces";
import { selectWorkspace, setWorkspacesEnabled } from "./workspace-client";
import { forgetPaletteQuery } from "./palette";
import { publishNavPages } from "./nav-pages";
import { CATCH_UP_EVENT } from "./catch-up-model";

const NOW = Date.now();

const baseState: FlowState = {
  projectShortNames: {},
  stripProjectPrefixes: [],
  awaiting: {},
  promised: {},
  waitingOthers: {},
  sectionOrder: [],
  machines: { hosts: [], threadHosts: {}, environmentHosts: {}, localHostId: null },
  laneSections: {},
  sectionProjects: {},
  threadPrs: {},
  running: {},
  watching: {},
  snoozedSectionId: null,
  snoozes: {},
  tags: {},
};

function thread(id: string, title: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id,
    title,
    displayTitle: title,
    titleFallback: null,
    projectId: "p1",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/p1/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    lastReadAt: null,
    latestAttentionAt: NOW - 3_600_000,
    ...overrides,
  };
}

const projects = [
  { id: "p1", name: "web-app", isPersonal: false, href: "/projects/p1", settingsHref: "/projects/p1/settings" },
  { id: "p2", name: "billing-api", isPersonal: false, href: "/projects/p2", settingsHref: "/projects/p2/settings" },
];

const threads = [
  thread("a", "Fix billing export", { hasPendingInteraction: true }),
  thread("b", "Deploy the worker", { status: "active", projectId: "p2" }),
  thread("c", "Mail templates"),
  thread("e", "Worktree thread", {
    environment: { id: "env1", name: null, branchName: "feat/worktree", path: "/work/acme", isWorktree: true, providerId: null, workspaceDisplayKind: null },
  }),
];

type MountOptions = {
  settings?: Record<string, boolean>;
  state?: Partial<FlowState>;
  workspaces?: WorkspaceState;
  keybindings?: unknown[] | null;
  search?: (args: { query: string }) => unknown;
  threadActions?: RenderSlotOptions["threadActions"];
  rpc?: Record<string, (input: never) => unknown>;
  context?: { threadId?: string | null; projectId?: string | null };
  threads?: PluginSidebarThread[];
  files?: (args: { query?: string; environmentId?: string }) => unknown;
  openFilePreview?: () => boolean;
  threadOpen?: (args: unknown) => Promise<unknown>;
};

async function mount(options: MountOptions = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const overlay = app.appOverlays.find((item) => item.id === "palette")!;
  const state = { ...baseState, ...options.state };
  return renderSlot(
    overlay,
    {},
    {
      settings: { palette: true, ...options.settings },
      rpc: {
        state_get: () => state,
        workspaces_get: () => options.workspaces ?? { workspaces: [], threadWorkspaces: {} },
        decision_options: () => ({ groups: [] }),
        snooze: (input: { threadId: string; until?: number }) => ({ until: input.until ?? NOW, note: null, fromSectionId: null, snoozedAt: NOW }),
        thread_reply: () => ({ ok: true }),
        next_needs_me: () => ({ opened: null }),
        ...options.rpc,
      } as never,
      sidebarThreads: { status: "ready", threads: options.threads ?? threads, projects, sections: [] },
      context: options.context,
      threadActions: options.threadActions,
      openUrl: () => true,
      openFilePreview: options.openFilePreview ?? (() => true),
      sdk: {
        subscribe: (() => () => {}) as never,
        system: {
          config: (async () => (options.keybindings === null ? Promise.reject(new Error("offline")) : { keybindings: options.keybindings ?? [{ command: "thread.search", shortcut: { key: "k", mod: true, meta: false, control: false, alt: false, shift: false } }] })) as never,
        },
        threads: {
          search: (async (args: { query: string }) => options.search?.(args) ?? { active: { results: [], total: 0 }, archived: { results: [], total: 0 } }) as never,
          open: (options.threadOpen ?? (async () => ({ delivered: 1 }))) as never,
        },
        projects: {
          files: (async (args: { query?: string; environmentId?: string }) => options.files?.(args) ?? { files: [], truncated: false }) as never,
        },
      },
      realtimeConnectionState: "connected",
    },
  );
}

/** ⌘K on macOS; returns whether the palette took the key (default prevented). */
const pressSearchKey = (key = "k") => !fireEvent.keyDown(window, { key, code: `Key${key.toUpperCase()}`, metaKey: true });

async function openPalette(slot: Awaited<ReturnType<typeof mount>>) {
  await waitFor(() => expect(pressSearchKey()).toBe(true));
  return slot.findByRole("combobox");
}

const options = (slot: Awaited<ReturnType<typeof mount>>) => slot.getAllByRole("option").map((row) => row.textContent ?? "");

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  setWorkspacesEnabled(false);
  sessionStorage.clear();
  forgetPaletteQuery();
  vi.restoreAllMocks();
});

describe("palette shortcut", () => {
  it("takes bb's search key only while the setting is on", async () => {
    const off = await mount({ settings: { palette: false } });
    await act(async () => {});
    expect(pressSearchKey()).toBe(false);
    expect(off.queryByRole("combobox")).toBeNull();
    off.unmount();

    const on = await mount();
    const input = await openPalette(on);
    expect(input).toBeTruthy();
    // The same key closes it again.
    expect(pressSearchKey()).toBe(true);
    await waitFor(() => expect(on.queryByRole("combobox")).toBeNull());
  });

  it("stands down while another dialog is open", async () => {
    const slot = await mount();
    await act(async () => {});
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    expect(pressSearchKey()).toBe(false);
    dialog.remove();
    await openPalette(slot);
  });

  it("follows a rebound search key and opens from the command", async () => {
    const slot = await mount({
      keybindings: [{ command: "thread.search", shortcut: { key: "j", mod: true, meta: false, control: false, alt: false, shift: false } }],
    });
    await waitFor(() => expect(pressSearchKey("j")).toBe(true));
    expect(await slot.findByRole("combobox")).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("combobox")).toBeNull());
    expect(pressSearchKey("k")).toBe(false);
    act(() => {
      window.dispatchEvent(new CustomEvent("jb-flow:palette"));
    });
    expect(await slot.findByRole("combobox")).toBeTruthy();
  });

  it("assumes ⌘K when bb's config can't be read", async () => {
    const slot = await mount({ keybindings: null });
    await openPalette(slot);
  });
});

describe("palette results", () => {
  it("opens on a triage home; Enter opens and ⌘Enter splits", async () => {
    const slot = await mount();
    await openPalette(slot);
    expect(slot.getByRole("group", { name: "Needs you" })).toBeTruthy();
    expect(slot.getByRole("group", { name: "Running" })).toBeTruthy();
    expect(options(slot)[0]).toContain("Fix billing export");
    fireEvent.keyDown(slot.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "a" }));

    await openPalette(slot);
    fireEvent.keyDown(slot.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(slot.getByRole("combobox"), { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "b", options: { split: true } }),
    );
  });

  it("searches titles and messages and offers a new thread from the query", async () => {
    const search = vi.fn(() => ({
      active: {
        total: 1,
        results: [
          {
            matches: [{ text: "update the invoice footer", sourceKind: "user_message", sourceSeq: 3, highlightRanges: [{ start: 11, end: 18 }] }],
            thread: { id: "c", title: "Mail templates", titleFallback: null, projectId: "p1", archivedAt: null, updatedAt: NOW },
          },
        ],
      },
      archived: { total: 0, results: [] },
    }));
    const slot = await mount({ search, context: { projectId: "p1" } });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "invoice" } });
    expect(await slot.findByRole("group", { name: "Messages" })).toBeTruthy();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "invoice" }));
    expect(slot.getByText("invoice").tagName).toBe("MARK");
    expect(options(slot).at(-1)).toContain("New thread: “invoice”");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
        method: "toCompose",
        options: { projectId: "p1", initialPrompt: "invoice", focusPrompt: true },
      }),
    );
  });

  it("narrows to PRs with # and opens the PR", async () => {
    const pr = { repo: "acme/web-app", number: 42, title: "Speed up exports", url: "https://github.com/acme/web-app/pull/42", state: "open" as const, attention: "checks_failed" as const, base: "main", head: "feat", stackedOn: null, checkedAt: NOW };
    const slot = await mount({ state: { threadPrs: { a: [pr] } } });
    const input = await openPalette(slot);
    await waitFor(() => expect(slot.getByRole("group", { name: "PRs to act on" })).toBeTruthy());
    fireEvent.change(input, { target: { value: "#42" } });
    expect(slot.getByRole("button", { name: /Pull requests/ })).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("42");
    expect(options(slot)[0]).toContain("#42 Speed up exports");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "openUrl", url: pr.url }));
  });

  it("switches workspace from @", async () => {
    setWorkspacesEnabled(true);
    const workspaces: WorkspaceState = {
      workspaces: [{ id: "ops", name: "Ops", projectIds: ["p2"], sectionIds: [], pluginIds: [], sectionOrder: [] }],
      threadWorkspaces: {},
    };
    const slot = await mount({ settings: { workspaces: true }, workspaces });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "@ops" } });
    await waitFor(() => expect(options(slot)[0]).toContain("Switch to Ops"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sessionStorage.getItem("jb-flow-workspace")).toBe("ops"));
    // No thread remembered there yet: a new thread in its first project.
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toCompose", options: { projectId: "p2" } });
  });
});

describe("palette thread actions", () => {
  const archive = vi.fn();
  const hostActions = (): readonly PluginThreadActionEntry[] => [
    { key: "bb--core/archive", pluginId: "bb--core", group: "manage", action: { label: "Archive", icon: "Archive", run: async () => archive() } },
    { key: "test-plugin/workspace", pluginId: "test-plugin", group: "organize", action: { label: "Workspace", icon: "Layers", run: async () => {} } },
  ];

  it("snoozes from typed text with Tab, then steps back with Escape", async () => {
    const slot = await mount({ threadActions: hostActions });
    const input = await openPalette(slot);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await slot.findByRole("button", { name: /Fix billing export/ })).toBeTruthy();
    // Our own thread action isn't listed twice.
    expect(options(slot).some((text) => text.includes("Workspace"))).toBe(false);
    fireEvent.change(input, { target: { value: "tomorrow" } });
    expect(options(slot)[0]).toMatch(/^Snooze until /);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(slot.queryByRole("button", { name: /Fix billing export/ })).toBeNull();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "tomorrow" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "snooze")).toBe(true));
    expect(slot.inspection.rpcCalls.find((call) => call.method === "snooze")?.input).toMatchObject({ threadId: "a", when: "tomorrow" });
  });

  it("answers a numbered decision and runs bb's own actions", async () => {
    const slot = await mount({
      threadActions: hostActions,
      rpc: { decision_options: () => ({ groups: [{ mode: "choice", question: "", options: [{ n: 1, text: "Ship it", recommended: true }, { n: 2, text: "Wait", recommended: false }] }] }) },
    });
    let input = await openPalette(slot);
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "reply" } });
    await waitFor(() => expect(options(slot)[0]).toContain("Reply 1: Ship it"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "thread_reply")?.input).toEqual({ threadId: "a", text: "1" }));

    input = await openPalette(slot);
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "archive" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(archive).toHaveBeenCalled());
  });

  it("answers a go-list step with go and its number", async () => {
    const slot = await mount({
      rpc: { decision_options: () => ({ groups: [{ mode: "go", question: "", options: [{ n: 1, text: "Ship it", recommended: true }, { n: 2, text: "Tidy the docs", recommended: false }] }] }) },
    });
    const input = await openPalette(slot);
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "reply" } });
    await waitFor(() => expect(options(slot)[0]).toContain("Reply 1: Ship it"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.rpcCalls.find((call) => call.method === "thread_reply")?.input).toEqual({ threadId: "a", text: "go 1" }));
  });
});

describe("palette scopes and memory", () => {
  it("searches the open thread's checkout with / and previews a file", async () => {
    const files = vi.fn(() => ({ files: [{ name: "palette.tsx", path: "src/palette.tsx" }, { name: "README.md", path: "README.md" }], truncated: false }));
    const slot = await mount({ context: { threadId: "e", projectId: "p1" }, files });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "/" } });
    expect(slot.getByRole("button", { name: /Files/ })).toBeTruthy();
    expect(slot.getByText("Type to search this thread's files")).toBeTruthy();
    fireEvent.change(input, { target: { value: "pal" } });
    await waitFor(() => expect(files).toHaveBeenLastCalledWith(expect.objectContaining({ query: "pal", environmentId: "env1", projectId: "p1" })));
    await waitFor(() => expect(options(slot)[0]).toContain("palette.tsx"));
    expect(options(slot)[0]).toContain("src");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({
        method: "experimental_openFilePreview",
        options: { target: { kind: "workspace", environmentId: "env1", path: "src/palette.tsx" } },
      }),
    );
  });

  it("opens a file in the thread's panel when the overlay can't preview it", async () => {
    const open = vi.fn(async () => ({ delivered: 1 }));
    const slot = await mount({
      context: { threadId: "e", projectId: "p1" },
      files: () => ({ files: [{ name: "README.md", path: "README.md" }], truncated: false }),
      openFilePreview: () => false,
      threadOpen: open,
    });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.change(input, { target: { value: "read" } });
    await waitFor(() => expect(options(slot)[0]).toContain("README.md"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(open).toHaveBeenCalledWith({ threadId: "e", file: { source: "workspace", path: "README.md", lineNumber: null } }));
  });

  it("explains the files scope without an open thread", async () => {
    const slot = await mount();
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "/" } });
    expect(slot.getByText("Open a thread to search its checkout's files")).toBeTruthy();
  });

  it("caps a long group with Show all, which lists the rest", async () => {
    const many = Array.from({ length: 10 }, (_, index) => thread(`t${index}`, `Task ${index}`));
    const slot = await mount({ threads: many });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "task" } });
    expect(options(slot).filter((text) => text.startsWith("Task"))).toHaveLength(8);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(slot.getByRole("option", { selected: true }).textContent).toContain("Show all 10 threads");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slot.getByRole("button", { name: /Threads & messages/ })).toBeTruthy();
    expect(options(slot).filter((text) => text.startsWith("Task"))).toHaveLength(10);
  });

  it("keeps a closed query for a quick reopen, but not after running something", async () => {
    const slot = await mount();
    let input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "deploy" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("combobox")).toBeNull());
    input = await openPalette(slot);
    expect((input as HTMLInputElement).value).toBe("deploy");
    expect(options(slot)[0]).toContain("Deploy the worker");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "b" }));
    input = await openPalette(slot);
    expect((input as HTMLInputElement).value).toBe("");
  });
});

describe("palette preview", () => {
  it("previews the selected thread beside the results on wide windows", async () => {
    // Last in this file: the media-query store caches the stub.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 1100px)",
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const preview = vi.fn((input: { threadId: string }) => ({
      goal: input.threadId === "a" ? "Ship the export fix" : "Roll out the worker",
      done: "",
      next: "Review the diff",
      blocked: "",
      latest: "",
      prompts: 3,
    }));
    const slot = await mount({ rpc: { thread_preview: preview as never } });
    const input = await openPalette(slot);
    const pane = await slot.findByRole("complementary", { name: "Preview" });
    expect(await within(pane).findByText("Ship the export fix")).toBeTruthy();
    expect(within(pane).getByText(/3 prompts/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(await within(pane).findByText("Roll out the worker")).toBeTruthy();
    // Not a thread: tips instead.
    fireEvent.change(input, { target: { value: ">" } });
    expect(await within(pane).findByText("Tips")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("finds a sidebar page such as a dashboard by its name, above threads, and opens it", async () => {
    const page = (id: string, label: string) =>
      ({ id, label, icon: { kind: "plugin", pluginId: "x", icon: null }, action: { kind: "plugin" }, isDisabled: false, isVisible: false, isLoading: false, pluginId: "x", shortcut: null, badge: null }) as never;
    const opened: string[] = [];
    publishNavPages([page("__bb__/new-thread", "New thread"), page("vaskeladden-bb/errors", "Errors")], (id, split) => opened.push(`${id}:${split}`));
    const slot = await mount({ threads: [...threads, thread("e", "Errors in billing")] });
    const input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "errors" } });
    await waitFor(() => expect(options(slot)[0]).toContain("Errors"));
    expect(options(slot).some((row) => row.includes("New thread") && !row.includes("“"))).toBe(false);
    const row = slot.getAllByRole("option")[0]!;
    expect(row.textContent).not.toContain("billing");
    fireEvent.click(row);
    await waitFor(() => expect(opened).toEqual(["vaskeladden-bb/errors:false"]));
    // ⌘↵ opens it beside the current view, like ⌘-clicking its icon.
    const again = await openPalette(slot);
    fireEvent.change(again, { target: { value: "errors" } });
    await waitFor(() => expect(options(slot)[0]).toContain("Errors"));
    fireEvent.keyDown(again, { key: "Enter", metaKey: true });
    await waitFor(() => expect(opened).toContain("vaskeladden-bb/errors:true"));
    publishNavPages([], () => {});
  });

  it("offers Catch up with the unread count while it's on, and opens it", async () => {
    const unread = [
      thread("a", "Fix billing export", { hasPendingInteraction: true, isUnread: true }),
      thread("c", "Mail templates", { isUnread: true }),
    ];
    const off = await mount({ threads: unread });
    let input = await openPalette(off);
    fireEvent.change(input, { target: { value: "catch up" } });
    expect(options(off).some((row) => row.includes("Catch up on unread threads"))).toBe(false);
    cleanup();

    const slot = await mount({ threads: unread, settings: { catchUp: true } });
    input = await openPalette(slot);
    fireEvent.change(input, { target: { value: "catch up" } });
    const row = await waitFor(() => {
      const found = slot.getAllByRole("option").find((option) => option.textContent?.includes("Catch up on unread threads"));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.textContent).toContain("2 unread · 1 needs you");
    const opened = vi.fn();
    window.addEventListener(CATCH_UP_EVENT, opened);
    fireEvent.click(row);
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    window.removeEventListener(CATCH_UP_EVENT, opened);
  });
});
