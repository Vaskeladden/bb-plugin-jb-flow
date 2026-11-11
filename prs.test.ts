import assert from "node:assert/strict";
import { test } from "node:test";
import { createdPrs, orderStack, type PrStatus } from "./prs.ts";

const pr = (number: number, base: string, head: string, repo = "o/a"): PrStatus => ({
  repo, number, title: `#${number}`, url: "", state: "open", attention: "review_requested",
  base, head, stackedOn: null, checkedAt: 0,
});

test("stacked PRs are ordered base-first", () => {
  const ordered = orderStack([pr(3, "feat-b", "feat-c"), pr(1, "dev", "feat-a"), pr(2, "feat-a", "feat-b")]);
  assert.deepEqual(ordered.map((p) => [p.number, p.stackedOn]), [[1, null], [2, 1], [3, 2]]);
});

test("a dev→main release PR is not a stack parent", () => {
  const ordered = orderStack([pr(10, "main", "dev"), pr(11, "dev", "fix-x")]);
  assert.deepEqual(ordered.map((p) => p.stackedOn), [null, null]);
});

test("same branch names in different repos don't stack", () => {
  const ordered = orderStack([pr(1, "dev", "feat", "o/a"), pr(2, "feat", "feat-2", "o/b")]);
  assert.deepEqual(ordered.map((p) => p.stackedOn), [null, null]);
});

test("PRs a thread created, from commands, tools and its own words", () => {
  const url = "https://github.com/acme/web-app/pull/12";
  const ref = [{ repo: "acme/web-app", number: 12 }];
  assert.deepEqual(createdPrs({ type: "commandExecution", command: "gh pr create --fill", aggregatedOutput: url }), ref);
  assert.deepEqual(createdPrs({ type: "commandExecution", command: "gh pr view 12", aggregatedOutput: url }), []);
  assert.deepEqual(createdPrs({ type: "toolCall", tool: "create_pull_request", status: "completed", result: { html_url: url } }), ref);
  assert.deepEqual(createdPrs({ type: "toolCall", tool: "get_pull_request", status: "completed", result: { html_url: url } }), []);
  assert.deepEqual(createdPrs({ type: "agentMessage", text: `Opened ${url} with the fix.` }), ref);
  assert.deepEqual(createdPrs({ type: "agentMessage", text: `The PR is up: [#12](${url})` }), ref);
  assert.deepEqual(createdPrs({ type: "agentMessage", text: `I reviewed ${url}; two comments.` }), []);
});

