import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
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
      // The sidebar writes the merged section order once when a section is new to it.
      section_order_set: () => ({ ok: true }),
    },
    sidebarThreads: { status: "ready", threads: rows,
      projects: [{ id: "project", name: "Example", isPersonal: false, href: "/projects/project", settingsHref: "/projects/project/settings" }],
      sections: [{ id: "bugs", name: "🐛 bugs", createdAt: 1, updatedAt: 1 }, { id: "features", name: "🚀 features", createdAt: 2, updatedAt: 2 }] },
  });
}

const heading = (title: string) => Array.from(document.querySelectorAll<HTMLElement>("[data-jb-flow-section-header]")).find((node) => node.textContent?.includes(title))!;
const clickOnly = (title: string) => fireEvent.click(within(heading(title)).getByRole("button", { name: "Bare" }));

it("Bare hides other sections, keeps Pinned, and Alle / Vis alle restore them after reload", async () => {
  const rows = [thread("bug"), thread("feature", null, { sectionId: "features" }), thread("loose", null, { sectionId: null }), thread("pin", null, { sectionId: "features", isPinned: true })];
  let slot = await sidebar(null, rows);
  await waitFor(() => expect(heading("🐛 bugs")).toBeTruthy());
  clickOnly("🐛 bugs");
  expect(heading("🚀 features")).toBeUndefined();
  expect(heading("Unassigned")).toBeUndefined();
  expect(heading("Pinned")).toBeTruthy();
  expect(slot.getByText("Bare 🐛 bugs", { exact: false })).toBeTruthy();
  expect(within(heading("🐛 bugs")).getByRole("button", { name: "Alle" })).toBeTruthy();
  slot.unmount();
  slot = await sidebar(null, rows);
  await waitFor(() => expect(heading("🐛 bugs")).toBeTruthy());
  expect(heading("🚀 features")).toBeUndefined();
  fireEvent.click(within(heading("🐛 bugs")).getByRole("button", { name: "Alle" }));
  expect(heading("🚀 features")).toBeTruthy();
  expect(heading("Unassigned")).toBeTruthy();
  clickOnly("Unassigned");
  expect(heading("🐛 bugs")).toBeUndefined();
  expect(slot.getByRole("link", { name: /loose/ })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Vis alle" }));
  expect(heading("🐛 bugs")).toBeTruthy();
  expect(heading("🚀 features")).toBeTruthy();
});

it("keeps collapse and drop targets intact, and a state filter cannot hide the chosen empty section", async () => {
  const slot = await sidebar(null, [thread("bug"), thread("running", null, { sectionId: "features", status: "active" })]);
  await waitFor(() => expect(heading("🐛 bugs")).toBeTruthy());
  const collapse = within(heading("🐛 bugs")).getByRole("button", { expanded: false });
  fireEvent.click(collapse);
  expect(slot.getByRole("link", { name: /bug/ })).toBeTruthy();
  const section = heading("🐛 bugs").closest("section")!;
  const attrs = section.getAttributeNames().filter((name) => name.startsWith("data-"));
  expect(attrs.length).toBeGreaterThanOrEqual(2);
  clickOnly("🐛 bugs");
  fireEvent.click(slot.getByRole("button", { name: /^Running/ }));
  expect(heading("🐛 bugs")).toBeTruthy();
  expect(heading("🚀 features")).toBeUndefined();
  expect(slot.queryByRole("link", { name: /running/ })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Vis alle" }));
  expect(heading("🐛 bugs")).toBeTruthy();
  expect(heading("🚀 features")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Running/ }));
  expect(within(heading("🐛 bugs")).getByRole("button", { expanded: true })).toBeTruthy();
  for (const attr of attrs) expect(heading("🐛 bugs").closest("section")!.getAttribute(attr)).toBe(section.getAttribute(attr));
});

it("section switches can hide every section and Vis alle recovers the list", async () => {
  const slot = await sidebar(null, [thread("bug")]);
  await waitFor(() => expect(heading("🐛 bugs")).toBeTruthy());
  fireEvent.contextMenu(heading("🐛 bugs"));
  fireEvent.keyDown(slot.getByRole("menuitem", { name: "Seksjoner" }), { key: "ArrowRight" });
  const features = await slot.findByRole("menuitemcheckbox", { name: "🚀 features" });
  expect(features.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(features);
  expect(heading("🚀 features")).toBeUndefined();
  fireEvent.click(slot.getByRole("button", { name: "Vis alle" }));
  expect(heading("🚀 features")).toBeTruthy();
  slot.unmount();
  localStorage.setItem("jb-flow:triage:hidden-sections", JSON.stringify(["bugs", "features", "__active", "snoozed"]));
  const empty = await sidebar(null, [thread("bug")]);
  await waitFor(() => expect(empty.getByRole("button", { name: "Vis alle" })).toBeTruthy());
  expect(heading("🐛 bugs")).toBeUndefined();
  fireEvent.click(empty.getByRole("button", { name: "Vis alle" }));
  expect(heading("🐛 bugs")).toBeTruthy();
});

it("ignores broken stored data and handles disabled browser storage", async () => {
  localStorage.setItem("jb-flow:triage:hidden-sections", "broken");
  const slot = await sidebar(null, [thread("bug")]);
  await waitFor(() => expect(heading("🐛 bugs")).toBeTruthy());
  expect(heading("🚀 features")).toBeTruthy();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
  try {
    clickOnly("🐛 bugs");
    expect(heading("🚀 features")).toBeUndefined();
    fireEvent.click(slot.getByRole("button", { name: "Vis alle" }));
    expect(heading("🚀 features")).toBeTruthy();
  } finally { write.mockRestore(); }
});
