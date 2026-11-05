import assert from "node:assert/strict";
import { test } from "node:test";
import { needsMe, studioStatus, studioThreads } from "./studio-model.ts";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { FlowState } from "./server";

const thread = (id: string, changes: Partial<PluginSidebarThread> = {}) => ({
  id,
  projectId: "p1",
  displayTitle: id,
  status: "idle" as const,
  indicator: "none" as const,
  hasPendingInteraction: false,
  isUnread: false,
  isPinned: false,
  isHidden: false,
  isArchived: false,
  updatedAt: 1,
  ...changes,
});
const workflow = (changes: Partial<FlowState> = {}) => ({
  awaiting: {},
  watching: {},
  threadPrs: {},
  snoozes: {},
  waitingOthers: {},
  ...changes,
});
const pr = (
  attention: "checks_failed" | "ready_to_merge" | "merged",
  state: "open" | "merged" = "open",
) => ({
  repo: "acme/app",
  number: 1,
  title: "Change",
  url: "https://github.com/acme/app/pull/1",
  state,
  attention,
  base: "main",
  head: "feature",
  stackedOn: null,
  checkedAt: 0,
});

test("input and error states take priority over running and ready PRs", () => {
  assert.equal(
    studioStatus(
      thread("a", { hasPendingInteraction: true, status: "active" }),
      null,
    ),
    "attention",
  );
  assert.equal(
    studioStatus(thread("a", { status: "error" }), null),
    "attention",
  );
  assert.equal(
    studioStatus(
      thread("a"),
      workflow({
        threadPrs: { a: [pr("ready_to_merge"), pr("checks_failed")] },
      }),
    ),
    "attention",
  );
});

test("the next action decides attention, not read state", () => {
  // Unread alone is only bold: no question, no attention.
  assert.equal(studioStatus(thread("a", { isUnread: true }), null), "idle");
  // A question waits for you whether or not you have read it.
  for (const isUnread of [true, false]) {
    assert.equal(
      studioStatus(thread("a", { isUnread }), workflow({ awaiting: { a: 1 } })),
      "attention",
    );
  }
});

test("Needs me keeps read failures and read questions", () => {
  assert.equal(needsMe(thread("a", { status: "error", isUnread: false }), {}), true);
  assert.equal(needsMe(thread("a", { isUnread: false }), { a: 1 }), true);
  assert.equal(needsMe(thread("a", { isUnread: true }), {}), false);
  // A running thread's old question is not waiting on you yet.
  assert.equal(needsMe(thread("a", { status: "active" }), { a: 1 }), false);
});

test("ready, watching, settled and ordinary idle work remain distinct", () => {
  assert.equal(
    studioStatus(
      thread("a"),
      workflow({ threadPrs: { a: [pr("ready_to_merge")] } }),
    ),
    "review",
  );
  assert.equal(
    studioStatus(
      thread("a"),
      workflow({ threadPrs: { a: [pr("merged", "merged")] } }),
    ),
    "done",
  );
  assert.equal(
    studioStatus(
      thread("a"),
      workflow({ watching: { a: { kind: "ci", label: "Watching checks" } } }),
    ),
    "waiting",
  );
  assert.equal(
    studioStatus(thread("a"), workflow({ waitingOthers: { a: 1 } })),
    "waiting",
  );
  assert.equal(
    studioStatus(thread("a", { status: "starting" }), null),
    "running",
  );
  assert.equal(studioStatus(thread("a"), null), "idle");
});

test("overview excludes hidden/archived work, combines filters and never mutates the source", () => {
  const threads = [
    thread("hidden", { isHidden: true }),
    thread("archived", { isArchived: true }),
    thread("other", { projectId: "p2", status: "active" }),
    thread("Match title", { status: "active" }),
    thread("idle"),
  ];
  assert.deepEqual(
    studioThreads(threads, null, {
      project: "p1",
      query: " MATCH ",
      filter: "running",
    }).map((item) => item.id),
    ["Match title"],
  );
  assert.equal(threads[0].id, "hidden");
  assert.equal(
    studioThreads(threads, null, { project: "all", query: "", filter: "all" })
      .length,
    3,
  );
});

test("attention leads pinned work; ties use pin, recency and stable ID order", () => {
  const threads = [
    thread("pinned", { isPinned: true, updatedAt: 100 }),
    thread("older", { updatedAt: 3 }),
    thread("needs", { hasPendingInteraction: true }),
    thread("newer", { updatedAt: 4 }),
    thread("active", { status: "active" }),
  ];
  assert.deepEqual(
    studioThreads(threads, null, {
      project: "all",
      query: "",
      filter: "all",
    }).map((item) => item.id),
    ["needs", "active", "pinned", "newer", "older"],
  );
});
