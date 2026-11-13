// @vitest-environment node
import { expect, it } from "vitest";
import { CHILD_ROWS_MAX, childrenSection, DEFAULT_DONKEY_PROMPT, DEFAULT_REVISE_PROMPT, DEFAULT_STATUS_PROMPT, handBackInstructions, statusRequest, THREAD_REPLY_MAX, type ChildThread } from "./status-prompt";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  createThreadStatus,
  parseStatusReport,
  recordThreadStatus,
  reportsNothingPending,
} from "./thread-status";

const report = `**Goal:** Ship the UI.
**Done:** Built the monitor.
**Next:** Review it.
**Blocked:** Waiting for review.
### Progress
\`\`\`
[██████████] Build   done
[██████░░░░] Review   60% ← here
[░░░░░░░░░░] Ship
\`\`\`
### Next steps
- Check design.
`;
it("reads a status report template and reported milestone values without inventing overall progress", () => {
  expect(parseStatusReport(report, 10)).toEqual({
    goal: "Ship the UI.",
    done: "Built the monitor.",
    next: "Review it.",
    blocked: "Waiting for review.",
    // A bulleted "Next steps" can't be picked by number.
    stepGroups: [],
    capturedAt: 10,
    milestones: [
      { label: "Build", percent: 100 },
      { label: "Review", percent: 60 },
      { label: "Ship", percent: 0 },
    ],
  });
  expect(
    parseStatusReport("Ordinary reply with **Next:** incidental text", 10),
  ).toBeNull();
  expect(
    parseStatusReport(
      "**Done:** Ready.\n**Next:** Nothing pending.\n**Blocked:** N/A",
      10,
    )?.blocked,
  ).toBe("");
  expect(
    parseStatusReport(report.replace("60%", "125%"), 10)?.milestones,
  ).toHaveLength(2);
});
it("keeps the last report through ordinary replies, maintains its age, and clears resolved blockers on a fresh report", () => {
  const first = recordThreadStatus("t1", report, null, 10)!;
  expect(recordThreadStatus("t1", report, first, 20)).toBe(first);
  const next = recordThreadStatus("t1", "New reply", first, 30)!;
  expect(next.report).toEqual(first.report);
  expect(next.latestAt).toBe(30);
  expect(next.latest).toBe("New reply");
  expect(recordThreadStatus("t1", "", next, 40)).toBe(next);
  expect(
    recordThreadStatus(
      "t1",
      report.replace("**Blocked:** Waiting for review.\n", ""),
      next,
      50,
    )?.report?.blocked,
  ).toBe("");
});
it("captures idle reports durably, isolates threads, survives reload and fetch failures, and forgets deleted threads", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      threads: {
        output: async () => {
          throw new Error("offline");
        },
      },
    },
  });
  let monitor = createThreadStatus(bb, () => {});
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "t1" }),
    lastAssistantText: report,
  });
  const saved = await monitor.get("t1");
  expect(saved?.report?.goal).toBe("Ship the UI.");
  expect(await monitor.get("t2")).toBeNull();
  const reloaded = await harness.lifecycle.reload(async (nextBb) => {
    monitor = createThreadStatus(nextBb, () => {});
  });
  expect(await monitor.get("t1")).toEqual(saved);
  await reloaded.harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "t1" }),
  });
  expect(await monitor.get("t1")).toBeNull();
  await reloaded.harness.lifecycle.dispose();
});
it("serializes reads with idle updates so an old in-flight reply cannot overwrite the new report", async () => {
  let resolve!: (result: { output: string }) => void;
  const { bb, harness } = createFakePluginHost({
    sdk: {
      threads: {
        output: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    },
  });
  const monitor = createThreadStatus(bb, () => {});
  const reading = monitor.get("t1");
  await new Promise((done) => setTimeout(done, 0));
  const idle = harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "t1" }),
    lastAssistantText: report,
  });
  resolve({ output: "Older ordinary reply" });
  await reading;
  await idle;
  const stored = await bb.storage.kv.get<{ report: { goal: string } }>(
    "thread-status:t1",
  );
  expect(stored?.report.goal).toBe("Ship the UI.");
  await harness.lifecycle.dispose();
});

it("reads next steps to run with go, a numbered decision, and Doing now", () => {
  const head = "**Goal:** Ship it\n**Done:** Merged the fix\n**Next:** Release\n\n";
  const go = parseStatusReport(
    head + "### Next steps\n> [!TIP]\n> **Recommended:** 1\n> 1. Check the nightly run · first unattended run\n> 2. Try the staging app\n>\n> Reply **go** for all, or **go 1,3**.\n\n_2026-10-13 00:29 CEST_",
    1,
  );
  expect(go?.stepGroups).toEqual([
    {
      mode: "go",
      question: "",
      items: ["Check the nightly run · first unattended run", "Try the staging app"],
      recommended: [1],
    },
  ]);
  const choice = parseStatusReport(
    head + "### Next steps\n> [!TIP]\n> **Decision needed:** which rollout?\n> 1. 10% today (recommended)\n> 2. Everyone on Monday\n>\n> Reply with the number.",
    1,
  );
  expect(choice?.stepGroups).toMatchObject([{ mode: "choice", question: "which rollout?", items: ["10% today", "Everyone on Monday"], recommended: [1] }]);
  const doing = parseStatusReport(head + "### Next steps\n**Doing now:** opening the PR and waiting for CI.", 1);
  expect(doing?.doingNow).toBe("opening the PR and waiting for CI.");
  expect(doing?.stepGroups).toEqual([]);
});

it("reads a go-list under a **Path forward:** line without taking it for a recommendation", () => {
  const report = parseStatusReport(
    "**Goal:** Ship it\n**Done:** Merged the fix\n\n### Next steps\n> [!TIP]\n> **Path forward:** finish the menu, then the docs\n> 1. Add the item · one step instead of three\n> 2. Update the README · keep docs current\n>\n> Reply **go** for all, or **go 1,3**.\n\n_2026-10-23 12:13 CEST_",
    1,
  );
  expect(report?.stepGroups).toEqual([
    {
      mode: "go",
      question: "finish the menu, then the docs",
      items: ["Add the item · one step instead of three", "Update the README · keep docs current"],
      recommended: [],
    },
  ]);
});

it("reads steps and a decision in one report as two groups, not one list of five", () => {
  const report = parseStatusReport(
    "**Goal:** Ship it\n**Done:** Merged the fix\n\n### Next steps\n> [!TIP]\n> **Path forward:** tidy, then ship\n> 1. Fix the test · red on main\n> 2. Update the docs\n> 3. Merge · green\n>\n> Reply **go** for all, or **go 1,3**.\n\n> [!TIP]\n> **Decision needed:** which rollout?\n> 1. 10% today (recommended)\n> 2. Everyone on Monday\n>\n> Reply with the number.",
    1,
  );
  expect(report?.stepGroups?.map((group) => [group.mode, group.items.length])).toEqual([
    ["go", 3],
    ["choice", 2],
  ]);
  expect(report?.stepGroups?.[1]).toMatchObject({ question: "which rollout?", recommended: [1] });
});

it("reads three questions under one heading as three decisions, each with its own line", () => {
  const report = parseStatusReport(
    [
      "**Goal:** Clear the stuck jobs",
      "**Done:** Checked seven discounts",
      "",
      "### Next steps",
      "> [!TIP]",
      "> **Decision needed:** Three quick questions.",
      ">",
      "> **A. A retry now fails every night. Should I fix that?**",
      "> 1. Yes, build the fix · stops it happening again (recommended)",
      "> 2. Wait · the money stays right",
      ">",
      "> **B. Six June discounts were worked out two ways. Which one counts?**",
      "> 1. What the customer was billed (recommended)",
      "> 2. Our system's sum",
      ">",
      "> **C. One June job was never billed. What should we do?**",
      "> 1. Let it go (recommended)",
      "> 2. Bill it now",
      ">",
      "> Reply with three numbers, like **1 1 1**.",
    ].join("\n"),
    1,
  );
  expect(report?.stepGroups?.map((group) => [group.mode, group.question, group.items.length, group.recommended])).toEqual([
    ["choice", "A retry now fails every night. Should I fix that?", 2, [1]],
    ["choice", "Six June discounts were worked out two ways. Which one counts?", 2, [1]],
    ["choice", "One June job was never billed. What should we do?", 2, [1]],
  ]);
});

it("keeps one list written as 1. 1. 1. together", () => {
  const report = parseStatusReport("**Goal:** Go\n**Done:** Went\n\n### Next steps\n**Decision needed:** Which?\n1. A\n   why A\n1. B\n\n1. C", 1);
  expect(report?.stepGroups?.map((group) => group.items)).toEqual([["A", "B", "C"]]);
});

it("keeps more than three questions", () => {
  const ask = (n: number) => `> **Decision needed:** question ${n}?\n> 1. Yes\n> 2. No\n\n`;
  const report = parseStatusReport(`**Goal:** Go\n**Done:** Went\n\n### Next steps\n${[1, 2, 3, 4].map(ask).join("")}`, 1);
  expect(report?.stepGroups?.map((group) => group.question)).toEqual(["question 1?", "question 2?", "question 3?", "question 4?"]);
});

it("hands back with the status prompt the user set, or the built-in one", () => {
  expect(handBackInstructions("")).toContain(DEFAULT_STATUS_PROMPT);
  expect(handBackInstructions("**Goal:** <x>")).toContain("**Goal:** <x>");
  // bb truncates thread instructions at 4096 characters.
  expect(handBackInstructions("").length).toBeLessThan(4096);
});

it("asks for the branch's health and simpler steps first, and still reads the report", () => {
  expect(DEFAULT_STATUS_PROMPT).toContain("**Health:**");
  expect(DEFAULT_STATUS_PROMPT).toContain("check the whole feature and simplify");
  const report = parseStatusReport(
    [
      "**Goal:** Every bug shows Bob's status",
      "",
      "**Done:** Bob counts every post",
      "",
      "**Health:** Entropy −1: one source instead of two · Performance 0 · Vision: supports",
      "",
      "### Next steps",
      "> [!TIP]",
      "> **Path forward:** Simplify first",
      "> 1. Remove the old fallback · Bob covers every post (simpler)",
      "> 2. Add a filter · nice to have (adds)",
    ].join("\n"),
    1,
  );
  expect(report?.goal).toBe("Every bug shows Bob's status");
  expect(report?.stepGroups?.[0]?.items).toHaveLength(2);
});

it("sends the built-in prompts within the thread_reply limit", () => {
  // A longer default made every Update status press fail its input check.
  expect(DEFAULT_STATUS_PROMPT.length).toBeLessThan(THREAD_REPLY_MAX);
  expect(DEFAULT_DONKEY_PROMPT.length).toBeLessThan(THREAD_REPLY_MAX);
  expect(DEFAULT_REVISE_PROMPT.length).toBeLessThan(THREAD_REPLY_MAX);
  expect(DEFAULT_REVISE_PROMPT).toContain("claude-fable-5-2");
});

it("a report with nothing pending is done, not Needs me, unless it asks a decision", () => {
  const done = parseStatusReport("**Goal:** Ship it\n\n**Done:** Shipped\n\n**Next:** Nothing pending.", 1);
  expect(reportsNothingPending(done)).toBe(true);
  const norsk = parseStatusReport("**Goal:** Fiks\n\n**Done:** Fikset\n\n**Next:** Ingenting igjen å gjøre.", 1);
  expect(reportsNothingPending(norsk)).toBe(true);
  const asks = parseStatusReport(
    "**Goal:** Ship\n\n**Done:** Built\n\n**Next:** Nothing pending.\n\n### Next steps\n> **Decision needed:** Ship now?\n> 1. Yes\n> 2. No",
    1,
  );
  expect(reportsNothingPending(asks)).toBe(false);
  const offers = parseStatusReport("**Goal:** Ship\n\n**Done:** Built\n\n**Next:** Nothing pending.\n\n### Next steps\n> **Path forward:** Optional\n> 1. Tidy up · nice", 1);
  expect(reportsNothingPending(offers)).toBe(true);
  expect(reportsNothingPending(parseStatusReport("**Goal:** A\n\n**Done:** B\n\n**Next:** Merge the PR", 1))).toBe(false);
  expect(reportsNothingPending(null)).toBe(false);
});

const child = (over: Partial<ChildThread>): ChildThread => ({
  id: "thr_a",
  title: "Billing export",
  under: null,
  state: "ready",
  reason: "nothing pending",
  goal: "",
  next: "",
  blocked: "",
  latest: "",
  heardAt: null,
  ...over,
});

it("asks a thread without children for the plain report", () => {
  expect(statusRequest("", "thr_parent", [])).toBe(DEFAULT_STATUS_PROMPT);
  expect(childrenSection("thr_parent", [])).toBe("");
});

it("adds each child's state and last report when the thread has children", () => {
  const now = 10 * 60 * 60_000;
  const text = statusRequest(
    "",
    "thr_parent",
    [
      child({ id: "thr_done", title: "Old import", state: "done", reason: "nothing pending", goal: "Import runs", heardAt: now }),
      child({
        id: "thr_ask",
        title: "Billing   export",
        state: "needs",
        reason: "asked you a question",
        goal: "Export every invoice",
        next: "Wait for your answer",
        blocked: "Which date format?",
        heardAt: now - 2 * 60 * 60_000,
      }),
      child({ id: "thr_deep", title: "", under: "thr_ask", state: "running", reason: "agent working", latest: "Reading the schema now." }),
    ],
    now,
  );
  // The report format still leads, so whatever reads the request recognises it.
  expect(text.startsWith(DEFAULT_STATUS_PROMPT)).toBe(true);
  expect(text).toContain("3 child threads: 1 Needs me · 1 Running · 1 Done.");
  const rows = text.split("\n").filter((line) => line.startsWith("- thr_"));
  // Those that wait for the user come first, finished ones last and without their old report.
  expect(rows).toEqual([
    '- thr_ask "Billing export" · Needs me (asked you a question) · Goal: Export every invoice · Next: Wait for your answer · Blocked: Which date format? · heard 2 h ago',
    '- thr_deep "Untitled" · Running (agent working) · started from thr_ask · Last said: Reading the schema now. · no reply yet',
    '- thr_done "Old import" · Done (nothing pending)',
  ]);
  expect(text).toContain("### Children");
  expect(text).toContain("bb thread tell <id>");
});

it("keeps a custom status prompt and still adds the children", () => {
  const text = statusRequest("Just say where we are.", "thr_parent", [child({})]);
  expect(text.startsWith("Just say where we are.\n\n---")).toBe(true);
  expect(text).toContain("1 child thread: 1 Ready.");
});

it("lists the most urgent children and counts the rest", () => {
  const many = [
    ...Array.from({ length: CHILD_ROWS_MAX + 4 }, (_, index) => child({ id: `thr_done${index}`, state: "done" })),
    child({ id: "thr_ask", state: "needs", reason: "asked you a question" }),
  ];
  const text = childrenSection("thr_parent", many);
  const rows = text.split("\n").filter((line) => line.startsWith("- thr_"));
  expect(rows).toHaveLength(CHILD_ROWS_MAX);
  expect(rows[0]).toContain("thr_ask");
  expect(text).toContain("- 5 more not listed, the least urgent ones. `bb thread list --parent-thread thr_parent` lists them all.");
  expect(text).toContain(`${CHILD_ROWS_MAX + 5} child threads: 1 Needs me · ${CHILD_ROWS_MAX + 4} Done.`);
});
