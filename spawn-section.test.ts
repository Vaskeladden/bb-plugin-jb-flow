import assert from "node:assert/strict";
import { test } from "node:test";
import { automationCreator, sectionForNewThread, type PlacedThread } from "./spawn-section.ts";

const SNOOZED = "sec_snoozed";
const thread = (id: string, sectionId: string | null, parentThreadId: string | null = null, sourceThreadId: string | null = null): PlacedThread => ({ id, sectionId, parentThreadId, sourceThreadId });
const index = (...threads: PlacedThread[]) => new Map(threads.map((entry) => [entry.id, entry]));
const neverSnoozed = () => null;

test("a spawned thread goes to its parent's section", () => {
  const child = thread("child", null, "parent");
  assert.equal(sectionForNewThread(child, null, index(thread("parent", "sec_features"), child), SNOOZED, neverSnoozed), "sec_features");
});

test("a forked thread goes to the section of the thread it was forked from", () => {
  const fork = thread("fork", null, null, "source");
  assert.equal(sectionForNewThread(fork, null, index(thread("source", "sec_bugs"), fork), SNOOZED, neverSnoozed), "sec_bugs");
});

test("a thread created in a section stays there", () => {
  const child = thread("child", "sec_later", "parent");
  assert.equal(sectionForNewThread(child, null, index(thread("parent", "sec_features"), child), SNOOZED, neverSnoozed), null);
});

test("a child of a snoozed thread goes to the section its parent was snoozed from, never to Snoozed", () => {
  const child = thread("child", null, "parent");
  const threads = index(thread("parent", SNOOZED), child);
  assert.equal(sectionForNewThread(child, null, threads, SNOOZED, (id) => (id === "parent" ? "sec_infra" : null)), "sec_infra");
  assert.equal(sectionForNewThread(child, null, threads, SNOOZED, neverSnoozed), null);
});

test("a parent without a section passes the question on to its own parent", () => {
  const grandchild = thread("grandchild", null, "child");
  const threads = index(thread("root", "sec_campaigns"), thread("child", null, "root"), grandchild);
  assert.equal(sectionForNewThread(grandchild, null, threads, SNOOZED, neverSnoozed), "sec_campaigns");
});

test("an automation's run goes to the section of the thread that created the automation", () => {
  const run = thread("run", null);
  assert.equal(sectionForNewThread(run, "creator", index(thread("creator", "sec_triage"), run), SNOOZED, neverSnoozed), "sec_triage");
});

test("a thread from nowhere stays in Unassigned", () => {
  const alone = thread("alone", null);
  assert.equal(sectionForNewThread(alone, null, index(alone), SNOOZED, neverSnoozed), null);
  assert.equal(sectionForNewThread(thread("child", null, "gone"), null, index(), SNOOZED, neverSnoozed), null);
});

test("a parent loop ends in Unassigned instead of running forever", () => {
  const a = thread("a", null, "b");
  assert.equal(sectionForNewThread(a, null, index(a, thread("b", null, "a")), SNOOZED, neverSnoozed), null);
});

test("an automation's run finds its creator through the last run or the first message", () => {
  const automations = [
    { id: "auto_one", createdByThreadId: "thr_one", lastRunThreadId: "thr_old" },
    { id: "auto_two-x", createdByThreadId: "thr_two", lastRunThreadId: "thr_run" },
  ];
  assert.equal(automationCreator("thr_run", null, automations), "thr_two");
  assert.equal(automationCreator("thr_new", "[bb automation due:auto_one] Refresh the board", automations), "thr_one");
  assert.equal(automationCreator("thr_new", "[bb automation due:auto_two-x] Check", automations), "thr_two");
  assert.equal(automationCreator("thr_new", "Refresh the board", automations), null);
  assert.equal(automationCreator("thr_new", "[bb automation due:auto_gone] Check", automations), null);
});
