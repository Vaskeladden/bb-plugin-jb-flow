import assert from "node:assert/strict";
import { test } from "node:test";
import { nextMove, parseDecisionOptions } from "./decisions.ts";

test("parses a trailing decision list with a recommendation", () => {
  const options = parseDecisionOptions(
    "Both work.\n\n> **Decision needed:** which import path?\n> 1. **Keep sheets as-is** — fastest (recommended)\n> 2. Normalize columns — cleaner\n>\n> Reply with the number.\n\n_2026-10-04 11:15 CEST_",
  );
  assert.deepEqual(options.map((option) => [option.n, option.recommended]), [[1, true], [2, false]]);
  assert.equal(options[0]!.text, "Keep sheets as-is — fastest");
});

test("ignores lists that aren't at the end, or aren't choices", () => {
  assert.deepEqual(parseDecisionOptions("Steps:\n1. a\n2. b\n\nThen I merged it and everything is done. Lots more text here.\nMore.\nMore.\nMore.\nMore.\nMore.\nMore."), []);
  assert.deepEqual(parseDecisionOptions("Only one:\n1. this"), []);
});

test("preserves longer reply choices for the multiline cards while bounding output", () => {
  const text = "Build the next section and validate the result with the existing measurement before proceeding to the final review";
  assert.equal(parseDecisionOptions(`Choose an approach?\n1. ${text} (recommended)\n2. Stop here`)[0]?.text, text);
  assert.equal(parseDecisionOptions(`Choose an approach?\n1. ${"x".repeat(600)} (recommended)\n2. Stop here`)[0]?.text.length, 500);
});

test("a list of steps is not a choice, even near the end", () => {
  const steps = [
    "Manual fallback:",
    "",
    "1. Acme pushes the order as Draft.",
    "2. Finance verifies customer, amount and delivery method in the ledger.",
    "3. Finance changes it to Ready to Invoice in the GUI.",
    "4. The read-only reconciliation detects the assigned invoice number.",
    "",
    "The current branch implements the unsupported promotion path, so it should not ship as written.",
    "",
    "> **Recommended:** remove the promotion endpoint and keep Draft creation.",
    ">",
    "> Write **go** and I'll make that change.",
  ].join("\n");
  assert.deepEqual(parseDecisionOptions(steps), []);
  // Still a trailing list for the "needs me" check.
  assert.equal(parseDecisionOptions("Two things:\n1. Check the login.\n2. Remove the worktree.", { strict: false }).length, 2);
});

test("a list is a choice when the intro asks, an option is recommended, or the outro asks for a number", () => {
  assert.equal(parseDecisionOptions("Which should I do?\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Options:\n1. Merge now\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Next:\n1. Merge now (recommended)\n2. Wait for review").length, 2);
  assert.equal(parseDecisionOptions("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply with the number.").length, 2);
  assert.equal(parseDecisionOptions("Two ways forward:\n1. Merge now\n2. Wait for review").length, 2);
  assert.deepEqual(parseDecisionOptions("Steps:\n1. Merge now\n2. Wait for review"), []);
});

test("next-step lists you pick from with go are choices", () => {
  assert.equal(parseDecisionOptions("> **Recommended:** 1\n> 1. Check the nightly run\n> 2. Try the staging app\n>\n> Reply **go** for all, or **go 1,3**.").length, 2);
  assert.equal(parseDecisionOptions("> **Reply `go` for the next slice:**\n>\n> 1. Slim the reads\n> 2. Run the probe").length, 2);
});

test("next move: a status report's steps, answered with go or a number", () => {
  const head = "**Goal:** Ship it\n**Done:** Merged the fix\n\n### Next steps\n> [!TIP]\n";
  const go = nextMove(
    head + "> **Path forward:** check it, then tidy\n> 1. Check the nightly run (recommended)\n> 2. Tidy the docs\n>\n> Reply **go** for all, or **go 1,3**.\n\n_2026-10-24 11:30 CEST_",
  );
  assert.deepEqual(go, {
    groups: [
      {
        mode: "go",
        question: "check it, then tidy",
        options: [
          { n: 1, text: "Check the nightly run", recommended: true },
          { n: 2, text: "Tidy the docs", recommended: false },
        ],
      },
    ],
  });
  const choice = nextMove(head + "> **Decision needed:** which rollout?\n> 1. 10% today (recommended)\n> 2. Everyone on Monday\n>\n> Reply with the number.");
  assert.equal(choice.groups[0]!.mode, "choice");
  assert.deepEqual(choice.groups[0]!.options.map((option) => option.text), ["10% today", "Everyone on Monday"]);
});

test("next move without a report: a trailing list, go-list when it asks for go", () => {
  assert.equal(nextMove("> **Reply `go` for the next slice:**\n>\n> 1. Slim the reads\n> 2. Run the probe").groups[0]!.mode, "go");
  assert.equal(nextMove("Two ways forward:\n1. Merge now\n2. Wait for review\n\nReply **go** for all, or **go 2**.").groups[0]!.mode, "go");
  const choice = nextMove("Which should I do?\n1. Merge now\n2. Wait for review");
  assert.equal(choice.groups[0]!.mode, "choice");
  assert.equal(choice.groups[0]!.options.length, 2);
  assert.deepEqual(nextMove("All done, the PR is merged."), { groups: [] });
});

test("next move names the question of a list outside a report", () => {
  assert.equal(nextMove("Which should I do?\n1. Merge now\n2. Wait for review").groups[0]!.question, "Which should I do?");
  assert.equal(nextMove("> [!IMPORTANT]\n> **Decision needed:** Which database?\n> 1. Postgres\n> 2. MySQL\n\nLet me know.").groups[0]!.question, "Which database?");
  assert.equal(nextMove("> [!TIP]\n> 1. Merge now (recommended)\n> 2. Wait").groups[0]!.question, "");
  assert.equal(nextMove("> **Recommended:** 1\n> 1. Merge now\n> 2. Wait\n>\n> Reply **go** for all, or **go 1,3**.").groups[0]!.question, "");
});

test("a reply in the Donkey format offers each decision with its question", () => {
  const reply = [
    "**Goal:** Customers get one e-mail.",
    "",
    "**Blocked:** Two parts send the same e-mail.",
    "",
    "### The problem",
    "Two parts of the system both send it.",
    "",
    "### Example",
    "Anna reports a problem and gets two e-mails.",
    "",
    "### Next steps",
    "> [!TIP]",
    "> **Decision needed:** Which part should send it?",
    "> 1. The new one · simpler (recommended)",
    "> 2. The old one · no change for partners",
    ">",
    "> Reply with the number.",
    "",
    "> [!TIP]",
    "> **Decision needed:** Tell customers about the change?",
    "> 1. Yes · fewer questions",
    "> 2. No · nothing to write (recommended)",
    ">",
    "> Reply with the number.",
  ].join("\n");
  const { groups } = nextMove(reply);
  assert.deepEqual(groups.map((group) => [group.mode, group.question, group.options.length]), [
    ["choice", "Which part should send it?", 2],
    ["choice", "Tell customers about the change?", 2],
  ]);
});
