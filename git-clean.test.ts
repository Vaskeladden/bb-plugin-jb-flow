import assert from "node:assert/strict";
import { test } from "node:test";
import { inMergedPr, isClean, needsLandedCheck } from "./git-clean.ts";

const status = (uncommitted: boolean, mergeBase: { hasCommittedUnmergedChanges: boolean; squashMergeCheckComplete?: boolean } | null) =>
  ({ outcome: "available", workspace: { workingTree: { hasUncommittedChanges: uncommitted }, mergeBase } }) as never;

test("clean means nothing uncommitted and nothing the default branch lacks", () => {
  assert.equal(isClean(status(false, { hasCommittedUnmergedChanges: false })), true);
  assert.equal(isClean(status(true, { hasCommittedUnmergedChanges: false })), false);
  assert.equal(isClean(status(false, { hasCommittedUnmergedChanges: true })), false);
  // Not sure yet (squash check unfinished, no merge base, no answer): not Done.
  assert.equal(isClean(status(false, { hasCommittedUnmergedChanges: false, squashMergeCheckComplete: false })), null);
  assert.equal(isClean(status(false, null)), null);
  assert.equal(isClean(null), null);
});

const statusOf = (uncommitted: boolean, unmerged: boolean, headSha: string | null = "abc") =>
  ({ outcome: "available", workspace: { workingTree: { hasUncommittedChanges: uncommitted }, mergeBase: { hasCommittedUnmergedChanges: unmerged }, checkout: { headSha } } }) as never;

test("only committed-but-unmerged work is asked about on GitHub, by the branch's last commit", () => {
  assert.equal(needsLandedCheck(statusOf(false, true)), "abc");
  assert.equal(needsLandedCheck(statusOf(true, true)), null); // uncommitted work: never Done
  assert.equal(needsLandedCheck(statusOf(false, false)), null); // already clean
  assert.equal(needsLandedCheck(null), null);
});

test("a commit counts as landed when a merged PR contains it", () => {
  assert.ok(inMergedPr([{ number: 6434, merged_at: "2026-11-10T10:00:00Z" }]));
  assert.ok(!inMergedPr([{ number: 4967, state: "open", merged_at: null }]));
  assert.ok(!inMergedPr([]));
  assert.ok(!inMergedPr({ message: "Not Found" }));
});
