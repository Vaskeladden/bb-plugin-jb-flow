import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MONITOR_COLLAPSE_KEY } from "./monitor-collapse";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import {
  ActivityCard,
  LiveActivityBanner,
  elapsed,
  type ActivityData,
  type ActivityTask,
} from "./live-activity";

type Timeline = Awaited<
  ReturnType<ReturnType<typeof useSdk>["threads"]["timeline"]>
>;
const task: ActivityTask = {
  id: "task1",
  itemId: "i1",
  kind: "work",
  workKind: "workflow",
  threadId: "t1",
  turnId: null,
  description: "Run scorecard with the fix",
  startedAt: 1000,
  createdAt: 1000,
  completedAt: null,
  status: "pending",
  taskStatus: "running",
  taskType: "local_agent",
  model: "gpt-6.1-sol",
  error: null,
  summary: "Comparing baseline rows",
  sourceSeqStart: 1,
  sourceSeqEnd: 2,
  workflowName: null,
  usage: { durationMs: 1000, toolUses: 7, totalTokens: 1250 },
  workflow: {
    phases: [],
    agents: [
      {
        index: 1,
        attempt: 1,
        label: "Verify scorecard",
        state: "running",
        model: "gpt-6.1-sol",
        cached: false,
        lastProgressAt: 2000,
        lastToolName: "exec_command",
        lastToolSummary: "Checking 42 baseline rows",
      },
    ],
  },
};
const data: ActivityData = {
  activeBackgroundCommands: [task],
  goal: null,
  activeWorkflows: [],
  rows: [],
  pendingTodos: {
    sourceSeq: 2,
    updatedAt: 2000,
    items: [
      { id: "step1", status: "completed", text: "Apply fix" },
      { id: "step2", status: "in_progress", text: "Run validation" },
    ],
  },
};
const snapshot: Timeline = {
  ...data,
  completedTurnDisplay: "flat",
  activePromptMode: null,
  activeThinking: null,
  contextBoundarySeq: 0,
  goal: null,
  maxSeq: 2,
  modelFallback: null,
  providerCommands: [],
  sessionOptions: null,
  timelinePage: {
    historySnapshot: "test",
    olderCursor: null,
    olderRowsSourceSeqEnd: null,
    returnedSegmentCount: 1,
  },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.removeItem(MONITOR_COLLAPSE_KEY);
  vi.unstubAllGlobals();
});

it("shows real descriptions and elapsed time, with model, tool use and workflow details", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data,
      running: false,
      startedAt: 1000,
      now: 279000,
      updatedAt: 278000,
      connected: true,
    },
  );
  expect(slot.getAllByText("Run scorecard with the fix")[0]).toBeTruthy();
  expect(slot.getByLabelText("Elapsed time").textContent).toBe("4m 38s");
  expect(slot.getByText("1 background agent")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  expect(slot.getByText("7 tool calls")).toBeTruthy();
  expect(slot.getByText("1,250 tokens")).toBeTruthy();
  expect(slot.getByText("Checking 42 baseline rows")).toBeTruthy();
  expect(
    slot
      .getByRole("progressbar", { name: /workflow steps complete/ })
      .getAttribute("value"),
  ).toBe("0");
  fireEvent.click(slot.getByRole("button", { name: "Less" }));
  expect(
    slot.getByRole("button", { name: "Details" }).getAttribute("aria-expanded"),
  ).toBe("false");
  slot.lifecycle.unmount();
});

it("stops claiming live updates when disconnected, and keeps the idle monitor", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data,
      running: false,
      startedAt: 1000,
      now: 2000,
      updatedAt: 1000,
      connected: false,
    },
  );
  expect(slot.getByText("Reconnecting")).toBeTruthy();
  expect(slot.getByText("Showing last received activity")).toBeTruthy();
  slot.lifecycle.unmount();
  const idle = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 0,
      updatedAt: 0,
      connected: true,
    },
  );
  expect(idle.getByRole("region", { name: "Agent activity" })).toBeTruthy();
  expect(idle.getByText("Idle")).toBeTruthy();
  idle.lifecycle.unmount();
});

it("uses event-driven snapshots and unsubscribes/aborts on unmount", async () => {
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_args: unknown) => unsubscribe);
  const timeline = vi.fn(async () => snapshot);
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: { t1: { since: 1000 } } },
    {
      settings: { threadMonitor: true },
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { subscribe, threads: { timeline } },
    },
  );
  await slot.findByRole("region", { name: "Agent activity" });
  expect(timeline).toHaveBeenCalledTimes(1);
  expect(subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ event: "thread:changed", threadId: "t1" }),
  );
  const changed = subscribe.mock.calls[0][0] as { callback: () => void };
  await act(async () => {
    changed.callback();
    changed.callback();
    changed.callback();
    await new Promise((resolve) => setTimeout(resolve, 800));
  });
  expect(timeline).toHaveBeenCalledTimes(2);
  const call = timeline.mock.calls[0] as unknown as [{ signal: AbortSignal }];
  slot.lifecycle.unmount();
  expect(call[0].signal.aborted).toBe(true);
  expect(unsubscribe).toHaveBeenCalledTimes(4);
});

it("falls back to native callouts on snapshot failure and never fetches when disabled", async () => {
  const timeline = vi.fn(async (): Promise<Timeline> => {
    throw new Error("offline");
  });
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      settings: { threadMonitor: true },
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { subscribe: () => () => {}, threads: { timeline } },
    },
  );
  await waitFor(() => expect(timeline).toHaveBeenCalledTimes(1));
  expect(
    slot
      .getByRole("region", { name: "Agent activity" })
      .hasAttribute("data-jb-flow-live-activity"),
  ).toBe(false);
  slot.lifecycle.unmount();
  timeline.mockClear();
  const disabled = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      settings: { threadMonitor: false },
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: true },
      sdk: { threads: { timeline } },
    },
  );
  expect(timeline).not.toHaveBeenCalled();
  disabled.lifecycle.unmount();
});

it("formats time without negative values or invented percentages", () => {
  expect(elapsed(-1000)).toBe("0s");
  expect(elapsed(61000)).toBe("1m 1s");
  expect(elapsed(3661000)).toBe("1h 1m");
});

it("shows workflows without a primary run and deduplicates shared task rows", () => {
  const workflow = {
    ...task,
    id: "wf1",
    taskType: "workflow",
    workflowName: "Scorecard",
  };
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: {
        ...data,
        activeBackgroundCommands: [workflow],
        activeWorkflows: [workflow],
      },
      running: false,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
    },
  );
  expect(slot.getByText("1 workflow")).toBeTruthy();
  expect(slot.queryByText("1 command")).toBeNull();
  slot.lifecycle.unmount();
});

it("distinguishes stopping and waiting from active execution", () => {
  for (const phase of ["waiting", "stopping"] as const) {
    const slot = renderSlot(
      { component: ActivityCard },
      {
        data,
        running: true,
        startedAt: 1000,
        now: 2000,
        updatedAt: 2000,
        connected: true,
        phase,
      },
    );
    expect(
      slot.getByText(
        phase === "waiting" ? "Waiting for your input" : "Stopping agent…",
      ),
    ).toBeTruthy();
    expect(
      slot
        .getByRole("region", { name: "Agent activity" })
        .getAttribute("data-active"),
    ).toBe("false");
    slot.lifecycle.unmount();
  }
});

it("consolidates a goal and merged PR with separate plan, budget and context meters", () => {
  const goal = {
    objective: "Ship the first Windows release",
    sourceSeq: 2,
    updatedAt: 2000,
    status: "active" as const,
    tokensUsed: 25000,
    tokenBudget: 100000,
    timeUsedSeconds: 1172,
  };
  const clear = vi.fn(async () => {});
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: {
        ...data,
        goal,
        contextWindowUsage: {
          estimated: false,
          usedTokens: 40000,
          modelContextWindow: 200000,
        },
      },
      running: true,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
      onClearGoal: clear,
      prs: [
        {
          number: 1439,
          title: "Release Windows",
          url: "https://github.com/acme/app/pull/1439",
          state: "merged",
          attention: "merged",
        },
      ],
      branchPrUrl: "https://github.com/acme/app/pull/1439",
    },
  );
  expect(slot.getByRole("link", { name: /1439.*Merged/ })).toBeTruthy();
  expect(
    slot
      .getByRole("progressbar", { name: "Plan complete" })
      .getAttribute("value"),
  ).toBe("1");
  expect(
    slot
      .getByRole("progressbar", { name: "Goal token budget used" })
      .getAttribute("value"),
  ).toBe("25000");
  expect(
    slot.getByRole("progressbar", { name: "Context used" }).getAttribute("max"),
  ).toBe("200000");
  expect(
    slot
      .getByRole("region", { name: "Agent activity" })
      .getAttribute("data-jb-flow-goal"),
  ).toBe("true");
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  expect(
    slot.getByRole("button", { name: "Clear goal" }).getAttribute("type"),
  ).toBe("button");
  slot.lifecycle.unmount();
});

it("keeps read-only PR summaries available when idle and rejects unsafe links", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 2000,
      updatedAt: 2000,
      connected: true,
      prs: [
        {
          number: 1,
          title: "Merged",
          url: "https://github.com/acme/app/pull/1",
          state: "merged",
          attention: "merged",
        },
        {
          number: 2,
          title: "Unsafe",
          url: "javascript:alert(1)",
          state: "open",
          attention: "none",
        },
      ],
    },
  );
  expect(slot.getByText("Idle")).toBeTruthy();
  expect(slot.getAllByRole("link")).toHaveLength(1);
  slot.lifecycle.unmount();
});

it("shows indeterminate activity when completion totals are unknown", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: true,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
    },
  );
  expect(
    slot
      .getByRole("progressbar", { name: "Live activity in progress" })
      .hasAttribute("aria-valuenow"),
  ).toBe(false);
  slot.lifecycle.unmount();
});

it("preserves goal controls and reports failed actions without submitting the composer", async () => {
  const clear = vi.fn(async () => {
    throw new Error("Could not clear goal");
  });
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: {
        ...data,
        goal: {
          objective: "Ship release",
          sourceSeq: 2,
          updatedAt: 2000,
          status: "active",
          tokensUsed: 100,
          tokenBudget: null,
          timeUsedSeconds: 20,
        },
      },
      running: true,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
      onClearGoal: clear,
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  fireEvent.click(slot.getByRole("button", { name: "Clear goal" }));
  expect(await slot.findByRole("alert")).toBeTruthy();
  expect(clear).toHaveBeenCalledTimes(1);
  slot.lifecycle.unmount();
});

const savedMonitor = {
  threadId: "t1",
  latest: "A newer ordinary reply",
  latestAt: 3000,
  replyHash: "hash",
  report: {
    goal: "Ship the monitor",
    done: "Built the view",
    next: "Review the design",
    blocked: "Waiting for feedback",
    capturedAt: 1000,
    milestones: [
      { label: "Implementation", percent: 100 },
      { label: "Review", percent: 60 },
    ],
  },
};
it("keeps a dated idle report and milestone bars with newer replies in Details", () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: 1000,
      now: 61000,
      updatedAt: 61000,
      connected: true,
      monitor: savedMonitor,
    },
  );
  expect(slot.getByText("Ship the monitor")).toBeTruthy();
  expect(
    Array.from(
      slot
        .getByRole("region", { name: "Agent activity" })
        .querySelectorAll(".jf-monitor-steps dt"),
    ).map((node) => node.textContent),
  ).toEqual(["Done", "Next", "Goal", "Blocked"]);
  expect(slot.getByText("Review the design")).toBeTruthy();
  expect(slot.getByText("Waiting for feedback")).toBeTruthy();
  // Milestone bars live in Details; the main view has a one-line summary.
  expect(slot.queryByRole("progressbar", { name: "Review" })).toBeNull();
  expect(slot.getByText(/1\/2 milestones done/)).toBeTruthy();
  expect(slot.queryByLabelText("Elapsed time")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Details" }));
  expect(
    slot.getByRole("progressbar", { name: "Review" }).getAttribute("value"),
  ).toBe("60");
  expect(slot.getByText("A newer ordinary reply")).toBeTruthy();
  slot.lifecycle.unmount();
});
it("requests the actual Status prompt only on click and leaves the composer draft untouched", async () => {
  const request = vi.fn(async () => ({ ok: true }));
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      settings: { threadMonitor: true },
      composer: {
        scope: { kind: "thread", threadId: "t1" },
        isRunning: false,
        text: "My unsent draft",
      },
      sdk: {
        subscribe: () => () => {},
        threads: {
          timeline: async () => ({
            ...snapshot,
            activeBackgroundCommands: [],
            pendingTodos: null,
          }),
        },
      },
      rpc: { thread_status: () => savedMonitor, thread_reply: request },
    },
  );
  await slot.findByText("Review the design");
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole("button", { name: "Status" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request.mock.calls[0]).toEqual([
    expect.objectContaining({
      threadId: "t1",
      text: expect.stringContaining("**Goal:**"),
    }),
  ]);
  fireEvent.click(slot.getByRole("button", { name: "Donkey" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]).toEqual([
    expect.objectContaining({
      threadId: "t1",
      text: expect.stringContaining("**Decision needed:**"),
    }),
  ]);
  expect(slot.inspection.composer.text).toBe("My unsent draft");
  slot.lifecycle.unmount();
});
it("does not leak a saved report into another thread while its snapshot is loading", async () => {
  const slot = renderSlot(
    { component: LiveActivityBanner },
    { runningSince: {} },
    {
      settings: { threadMonitor: true },
      composer: { scope: { kind: "thread", threadId: "t1" }, isRunning: false },
      sdk: {
        subscribe: () => () => {},
        threads: {
          timeline: async () => ({
            ...snapshot,
            activeBackgroundCommands: [],
            pendingTodos: null,
          }),
        },
      },
      rpc: { thread_status: () => savedMonitor },
    },
  );
  await slot.findByText("Review the design");
  await slot.behavior.setComposerScope({ kind: "thread", threadId: "t2" });
  expect(slot.queryByText("Review the design")).toBeNull();
  slot.lifecycle.unmount();
});

it("keeps the saved report and reports a failed status request inline", async () => {
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 61000,
      updatedAt: 61000,
      connected: false,
      monitor: savedMonitor,
      monitorStale: true,
      onRequestStatus: async () => {
        throw new Error("offline");
      },
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Status" }));
  await slot.findByRole("alert");
  expect(slot.getByText("Review the design")).toBeTruthy();
  expect(
    slot.getByText("Status refresh unavailable · showing saved information"),
  ).toBeTruthy();
  expect(
    slot
      .getByRole("button", { name: "Status" })
      .hasAttribute("disabled"),
  ).toBe(false);
  slot.lifecycle.unmount();
});

it("starts mobile monitors as a compact row and expands the entire body on demand", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 61000,
      updatedAt: 61000,
      connected: true,
      monitor: savedMonitor,
    },
  );
  const region = slot.getByRole("region", { name: "Agent activity" });
  expect(region.getAttribute("data-collapsed")).toBe("true");
  expect(slot.queryByRole("progressbar", { name: "Review" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Details" })).toBeNull();
  expect(slot.getByText("Idle")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Expand monitor" }));
  expect(region.getAttribute("data-collapsed")).toBe("false");
  expect(slot.getByText("Review the design")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Details" })).toBeTruthy();
  expect(localStorage.getItem(MONITOR_COLLAPSE_KEY)).toBe("false");
  slot.lifecycle.unmount();
});
it("remembers collapse on this device across thread navigation and synchronizes split panes", () => {
  const props = {
    data,
    running: true,
    startedAt: 1000,
    now: 2000,
    updatedAt: 2000,
    connected: true,
  };
  const first = renderSlot({ component: ActivityCard }, props);
  const second = renderSlot({ component: ActivityCard }, props);
  fireEvent.click(
    first.getAllByRole("button", { name: "Collapse monitor" })[0]!,
  );
  expect(document.querySelectorAll('[data-collapsed="true"]')).toHaveLength(2);
  expect(localStorage.getItem(MONITOR_COLLAPSE_KEY)).toBe("true");
  first.lifecycle.unmount();
  second.lifecycle.unmount();
  const nextThread = renderSlot({ component: ActivityCard }, props);
  expect(
    nextThread
      .getByRole("button", { name: "Expand monitor" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  nextThread.lifecycle.unmount();
});
it("still collapses and expands when browser storage is blocked", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data,
      running: true,
      startedAt: 1000,
      now: 2000,
      updatedAt: 2000,
      connected: true,
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Collapse monitor" }));
  fireEvent.click(slot.getByRole("button", { name: "Expand monitor" }));
  expect(slot.getByRole("button", { name: "Collapse monitor" })).toBeTruthy();
  slot.lifecycle.unmount();
  spy.mockRestore();
});

it("calls out an outdated report with a prominent Update status, and stays quiet when it is current", async () => {
  const base = {
    data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
    running: false,
    startedAt: null,
    updatedAt: 61000,
    connected: true,
    onRequestStatus: async () => {},
  };
  // A reply well after the report makes it outdated; one at the same time does not.
  const outdated = renderSlot(
    { component: ActivityCard },
    { ...base, now: 200_000, monitor: { ...savedMonitor, latestAt: 150_000 } },
  );
  expect(outdated.getByText("· out of date").getAttribute("title")).toBe("The agent replied after this report");
  expect(outdated.getAllByRole("button", { name: "Status" })).toHaveLength(1);
  outdated.lifecycle.unmount();

  const current = renderSlot(
    { component: ActivityCard },
    { ...base, now: 61_000, monitor: { ...savedMonitor, latestAt: 1000 } },
  );
  expect(current.queryByText("· out of date")).toBeNull();
  // Current: a quiet Refresh instead of the prominent Update status.
  expect(current.getByRole("button", { name: "Status" })).toBeTruthy();
  current.lifecycle.unmount();
});

it("shows auto-prompt in a menu and switches continue-after-limit from there", async () => {
  const toggle = vi.fn(async () => {});
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 61000,
      updatedAt: 61000,
      connected: true,
      monitor: { ...savedMonitor, latestAt: 1000 },
      autoContinue: { enabled: false, scheduledAt: null },
      onToggleAutoContinue: toggle,
    },
  );
  const trigger = slot.getByRole("button", { name: /Auto-prompt/ });
  expect(trigger.textContent).toContain("off");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  const item = await waitFor(() => document.body.querySelector('[role="menuitemcheckbox"]') as HTMLElement);
  expect(item.textContent).toContain("Continue after a usage limit resets");
  fireEvent.click(item);
  await waitFor(() => expect(toggle).toHaveBeenCalledWith(true));
  slot.lifecycle.unmount();
});
it("lists watches in the auto-prompt menu and stops one when unticked", async () => {
  const cancel = vi.fn(async () => {});
  const slot = renderSlot(
    { component: ActivityCard },
    {
      data: { ...data, activeBackgroundCommands: [], pendingTodos: null },
      running: false,
      startedAt: null,
      now: 61000,
      updatedAt: 61000,
      connected: true,
      monitor: { ...savedMonitor, latestAt: 1000 },
      autoContinue: { enabled: true, scheduledAt: null },
      onToggleAutoContinue: async () => {},
      watches: [
        { kind: "ci", key: "t1:acme/web-app#12", label: "web-app#12 checks" },
        { kind: "release", key: "t1@web-app", label: "next web-app release" },
      ],
      onCancelWatch: cancel,
    },
  );
  const trigger = slot.getByRole("button", { name: /Auto-prompt/ });
  expect(trigger.textContent).toContain("· 3");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  await waitFor(() => expect(document.body.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(3));
  const release = Array.from(document.body.querySelectorAll('[role="menuitemcheckbox"]')).find((el) =>
    el.textContent?.includes("next web-app release"),
  ) as HTMLElement;
  fireEvent.click(release);
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ kind: "release", key: "t1@web-app" })));
  slot.lifecycle.unmount();
});
