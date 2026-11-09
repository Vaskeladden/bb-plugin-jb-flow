import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { buildThreadTree, filterThreadTree, flattenThreadTree } from "./thread-tree";
import { selectWorkspace } from "./workspace-client";
import type { FlowState } from "./server";

function thread(id: string, parentThreadId: string | null = null, extra: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, parentThreadId, projectId: "project", title: id, titleFallback: null, displayTitle: id,
    href: `/projects/project/threads/${id}`, sectionId: "bugs", status: "idle", runtimeStatus: "idle",
    isHidden: false, isArchived: false, isUnread: false, isPinned: false,
    hasPendingInteraction: false, indicator: "idle", indicatorLabel: "Idle",
    createdAt: 10, updatedAt: Date.now(), environment: null, host: null,
    ...extra,
  } as PluginSidebarThread;
}

afterEach(() => { cleanup(); localStorage.clear(); selectWorkspace(null); vi.unstubAllGlobals(); });

it("builds nested families across worktrees/sections without hiding orphans or cyclic links", () => {
  const rows = [thread("child", "parent", { sectionId: "elsewhere" }), thread("parent"), thread("grandchild", "child"), thread("orphan", "missing"), thread("cycle-a", "cycle-b"), thread("cycle-b", "cycle-a")];
  const tree = buildThreadTree(rows);
  expect(tree.map((node) => node.thread.id)).toEqual(["parent", "orphan", "cycle-a"]);
  expect(tree[0].children[0].children[0].thread.id).toBe("grandchild");
  expect(flattenThreadTree(tree).map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  expect(flattenThreadTree(filterThreadTree(tree, (row) => row.id === "grandchild")).map((row) => row.id)).toEqual(["parent", "child", "grandchild"]);
});

async function sidebar(activeThreadId: string | null = "parent", rows = [
  thread("parent"), thread("child", "parent", { status: "active", isUnread: true }),
  thread("grandchild", "child", { hasPendingInteraction: true }), thread("other", "parent"),
], flow: Partial<FlowState> = {}) {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.threadLists.find((slot) => slot.id === "triage")!, {
    activeThreadId, activeProjectId: "project", onNavigate: vi.fn(), isCompactViewport: false, searchQuery: "",
  }, {
    rpc: {
      state_get: () => ({ projectShortNames: {}, stripProjectPrefixes: [], awaiting: {}, promised: {}, waitingOthers: {}, sectionOrder: [], laneSections: {}, sectionProjects: {}, threadPrs: {}, running: {}, watching: {}, snoozedSectionId: null, snoozes: {}, tags: {}, machines: { hosts: [], localHostId: null, environmentHosts: {}, threadHosts: {} }, ...flow }),
      workspaces_get: () => ({ workspaces: [], threadWorkspaces: {} }),
    },
    sidebarThreads: { status: "ready", threads: rows,
      projects: [{ id: "project", name: "Example", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }],
      sections: [{ id: "bugs", name: "Bugs", createdAt: 1, updatedAt: 1 }] },
  });
}

it("shows child rows under the active parent, keeps status visible when collapsed and navigates independently", async () => {
  const slot = await sidebar();
  await waitFor(() => expect(slot.getByRole("button", { name: "Collapse child threads of parent" })).toBeTruthy());
  const root = document.querySelector('[data-jb-flow-branch="parent"]')!;
  const children = within(root as HTMLElement).getByRole("list", { name: "Child threads of parent" });
  expect(within(children).getByRole("link", { name: /child/ })).toBeTruthy();
  expect(slot.getByLabelText("3 child threads · 1 running · 1 need attention · 1 unread")).toBeTruthy();
  const toggle = slot.getByRole("button", { name: "Collapse child threads of parent" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("link", { name: /^other/ })).toBeNull();
  expect(slot.getByLabelText("3 child threads · 1 running · 1 need attention · 1 unread")).toBeTruthy();
  expect(slot.inspection.navigateCalls).toHaveLength(0);
  fireEvent.click(toggle);
  const child = document.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="child"]')!;
  fireEvent.click(child);
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "child" });
  fireEvent.keyDown(child, { key: "ArrowRight" });
  expect(document.querySelector('[data-sidebar-thread-id="grandchild"]')).toBeTruthy();
  const grandchild = document.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="grandchild"]')!;
  fireEvent.keyDown(grandchild, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(child);
});

it("reveals a selected grandchild even when the saved family and section were collapsed", async () => {
  localStorage.setItem("jb-flow:collapsed", JSON.stringify({ "section:bugs": true, "thread:parent": true, "thread:child": true }));
  const slot = await sidebar("grandchild");
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="grandchild"]')?.getAttribute("aria-current")).toBe("page"));
  expect(slot.getByRole("button", { name: "Collapse child threads of parent" })).toBeTruthy();
});

it("finds a child that needs attention and keeps its ancestry without unrelated siblings", async () => {
  const slot = await sidebar();
  const needs = await slot.findByRole("button", { name: /Needs me/ });
  await waitFor(() => expect(needs.textContent).toContain("1"));
  fireEvent.click(needs);
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="grandchild"]')).toBeTruthy());
  expect(document.querySelector('[data-sidebar-thread-id="parent"]')).toBeTruthy();
  expect(document.querySelector('[data-sidebar-thread-id="child"]')).toBeTruthy();
  expect(document.querySelector('[data-sidebar-thread-id="other"]')).toBeNull();
});

it("does not hide a visible child when its parent is archived or hidden", async () => {
  const slot = await sidebar("child", [thread("parent", null, { isArchived: true }), thread("child", "parent"), thread("hidden", null, { isHidden: true }), thread("visible", "hidden")]);
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="child"]')).toBeTruthy());
  expect(document.querySelector('[data-sidebar-thread-id="parent"]')).toBeNull();
  expect(document.querySelector('[data-sidebar-thread-id="visible"]')).toBeTruthy();
  expect(slot.queryByRole("button", { name: /child threads/ })).toBeNull();
});

it("keeps a snoozed child in Snoozed and reveals it when opened", async () => {
  const slot = await sidebar("child", [thread("parent"), thread("child", "parent", { sectionId: "sleep" })], { snoozedSectionId: "sleep" });
  const snoozed = await slot.findByRole("list", { name: "Snoozed" });
  expect(within(snoozed).getByRole("link", { name: /child/ }).getAttribute("aria-current")).toBe("page");
  expect(slot.queryByRole("button", { name: /child threads of parent/ })).toBeNull();
});

it("remembers collapsed branches when returning from a filter", async () => {
  const slot = await sidebar();
  fireEvent.click(await slot.findByRole("button", { name: "Collapse child threads of parent" }));
  fireEvent.click(slot.getByRole("button", { name: /Needs me/ }));
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="grandchild"]')).toBeTruthy());
  fireEvent.click(slot.getByRole("button", { name: /Needs me/ }));
  await waitFor(() => expect(slot.getByRole("button", { name: "Expand child threads of parent" })).toBeTruthy());
  expect(document.querySelector('[data-sidebar-thread-id="child"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem("jb-flow:collapsed")!)["thread:parent"]).toBe(true);
});

it("does not offer archive for a Ready parent whose hidden child is still working", async () => {
  const slot = await sidebar(null, [
    thread("parent", null, { sectionId: null, updatedAt: Date.now() - 86_400_000 }),
    thread("child", "parent", { status: "active", isHidden: true }),
  ], { threadPrs: { parent: [{ repo: "acme/web-app", number: 1, title: "Fix", url: "https://github.com/acme/web-app/pull/1", state: "merged", attention: "merged", base: "main", head: "fix", stackedOn: null, checkedAt: 1 }] } });
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="parent"]')).toBeTruthy());
  fireEvent.click(await slot.findByRole("button", { name: /^Ready/ }));
  await waitFor(() => expect(document.querySelector('[data-sidebar-thread-id="parent"]')).toBeTruthy());
  expect(slot.queryByRole("button", { name: /^Archive/ })).toBeNull();
});

it("still offers Archive all under Ready for an idle family whose PRs are settled", async () => {
  const rows = [thread("parent", null, { sectionId: null, updatedAt: Date.now() - 86_400_000 }), thread("child", "parent", { sectionId: null, updatedAt: Date.now() - 86_400_000 })];
  const prs = [{ repo: "acme/web-app", number: 1, title: "Fix", url: "https://github.com/acme/web-app/pull/1", state: "merged" as const, attention: "merged" as const, base: "main", head: "fix", stackedOn: null, checkedAt: 1 }];
  const slot = await sidebar(null, rows, { threadPrs: { parent: prs, child: prs } });
  const ready = await slot.findByRole("button", { name: /^Ready/ });
  expect(ready.textContent).toBe("Ready2");
  fireEvent.click(ready);
  expect(slot.getByRole("button", { name: "Archive all" })).toBeTruthy();
  expect(document.querySelector('[data-sidebar-thread-id="child"]')).toBeTruthy();
});
