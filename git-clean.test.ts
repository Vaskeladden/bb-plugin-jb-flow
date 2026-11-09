import assert from "node:assert/strict";
import { test } from "node:test";
import { isClean } from "./git-clean.ts";

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
