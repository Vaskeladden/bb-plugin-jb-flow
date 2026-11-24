import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { collectPluginAppRegistrations } from "@get-bb/plugin-sdk/internal/plugin-app-collector";
import type { PluginAppDefinition, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

function thread(id: string, status: PluginSidebarThread["status"]): PluginSidebarThread {
  return {
    id,
    title: id,
    displayTitle: id,
    titleFallback: null,
    projectId: "p1",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status,
    runtimeStatus: status,
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: null,
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
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: 0,
    latestAttentionAt: 0,
  } as PluginSidebarThread;
}

const threads = [thread("focused", "active"), thread("other", "active"), thread("quiet", "idle")];

/** The command exactly as bb's collector registers it from the plugin app. */
async function stopCommand() {
  const definition = (await import("./app")).default as PluginAppDefinition;
  const command = collectPluginAppRegistrations(definition).commandPaletteActions.find((item) => item.id === "stop-agent");
  if (command?.target !== "app") throw new Error("stop-agent is not registered as an app command");
  return command;
}

async function mountHost(stops: string[]) {
  const app = await loadPluginApp(() => import("./app"));
  const overlay = app.appOverlays.find((item) => item.id === "stop-agent")!;
  return renderSlot(overlay as never, {} as never, {
    rpc: {
      thread_stop: (input: { threadId: string }) => {
        stops.push(input.threadId);
        return { ok: true };
      },
    } as never,
    sidebarThreads: { status: "ready", threads, projects: [], sections: [] },
  });
}

const context = (threadId: string | null) => ({ threadId, projectId: "p1", openPanel: () => false });

afterEach(cleanup);

describe("Stop this thread's agent", () => {
  it("is registered with ⌘⇧⌫ as its default, rebindable shortcut", async () => {
    const command = await stopCommand();
    expect(command.title).toBe("Stop this thread's agent");
    expect(command.defaultShortcut).toEqual({ key: "Backspace", mod: true, shift: true, alt: false, control: false, meta: false });
  });

  it("is available only in a running thread and stops only the focused one", async () => {
    const stops: string[] = [];
    await mountHost(stops);
    const command = await stopCommand();
    await waitFor(() => expect(command.isAvailable!(context("focused"))).toBe(true));
    expect(command.isAvailable!(context("quiet"))).toBe(false);
    expect(command.isAvailable!(context(null))).toBe(false);

    await command.run(context("focused"));
    await command.run(context("quiet"));
    await command.run(context(null));
    expect(stops).toEqual(["focused"]);
  });
});
