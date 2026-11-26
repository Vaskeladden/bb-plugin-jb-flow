// @vitest-environment node
import { expect, it } from "vitest";
import {
  CHILD_ROWS_MAX,
  childrenSection,
  DEFAULT_DONKEY_PROMPT,
  defaultRevisePrompt,
  revisePrompt,
  reviseReviewer,
  DEFAULT_STATUS_PROMPT,
  DEFAULT_ULTRASTATUS_PROMPT,
  handBackInstructions,
  statusRequest,
  THREAD_REPLY_MAX,
  ULTRA_CHILD_ROWS_MAX,
  ultrastatusRequest,
  type ChildThread,
} from "./status-prompt";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  createThreadStatus,
  parseStatusReport,
  uiStepGroups,
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
  for (const reviewer of ["codex", "fable"] as const) expect(defaultRevisePrompt(reviewer).length).toBeLessThan(THREAD_REPLY_MAX);
});

it("Revise asks the other family: Codex for a Claude thread, Fable for any other", () => {
  expect(reviseReviewer("claude-code")).toBe("codex");
  for (const provider of ["codex", "acp-grok", "antigravity-acp", null]) expect(reviseReviewer(provider)).toBe("fable");
  const fromClaude = revisePrompt("", "claude-code");
  expect(fromClaude).toContain("/second-opinion");
  expect(fromClaude).not.toContain("claude-fable-5-2");
  const fromCodex = revisePrompt(undefined, "codex");
  expect(fromCodex).toContain("claude-fable-5-2");
  expect(fromCodex).not.toContain("/second-opinion");
  expect(revisePrompt("My own prompt", "codex")).toBe("My own prompt");
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

it("asks to bring the status board up to date as an update when the thread has one", () => {
  const text = statusRequest("", "thr_parent", [], 0, "Launch");
  expect(text.startsWith(`${DEFAULT_STATUS_PROMPT}\n\n---\n\nThis thread has a status board in my side panel («Launch»)`)).toBe(true);
  expect(text).toContain('`mode: \"update\"` and `kind: \"update\"`');
  expect(text).toContain("the five «In plain words» lines first");
  expect(text).toContain("never call it an Ultrastatus");
  // Without a board the request is the plain report, as before.
  expect(statusRequest("", "thr_parent", [], 0, null)).toBe(DEFAULT_STATUS_PROMPT);
  // With children too: the children first, then the board.
  const both = statusRequest("", "thr_parent", [child({})], 0, "Launch");
  expect(both.indexOf("This thread has child threads")).toBeLessThan(both.indexOf("This thread has a status board"));
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

it("asks Ultrastatus for a checked, visual report the monitor can still read", () => {
  expect(ultrastatusRequest("", "thr_parent", [])).toBe(DEFAULT_ULTRASTATUS_PROMPT);
  // Tools that tell a button's message from the user's own words match on this opening.
  expect(DEFAULT_ULTRASTATUS_PROMPT.startsWith("Ultrastatus: give me a thorough, checked status report")).toBe(true);
  for (const part of ["Check each piece against its source", "**Matrix.**", "```ui", "**claimed**", "--include-archived", "### Progress", "Plan([", "Button("]) {
    expect(DEFAULT_ULTRASTATUS_PROMPT).toContain(part);
  }
  // A reply in that shape: pictures first, then the fields the monitor reads.
  const report = parseStatusReport(
    [
      "We are two thirds there. The import is the risk.",
      "",
      "```ui",
      'Card("Matrix", [Acceptance([{name: "Export", cells: {Built: "passed", Live: "claimed"}}], ["Built", "Live"])])',
      "```",
      "",
      "**Goal:** Every invoice reaches the accountant",
      "",
      "**Done:** Export is merged and checked",
      "",
      "**Next:** Finish the import",
      "",
      "### Progress",
      "```",
      "[██████████] Export   done",
      "[███░░░░░░░] Import   30%  ← here",
      "```",
      "",
      "### Next steps",
      "```ui",
      'Card("Path forward: Finish the import", [Plan([{title: "Fix the date format", detail: "the last failing check"}])])',
      "```",
    ].join("\n"),
    1,
  );
  expect(report?.goal).toBe("Every invoice reaches the accountant");
  expect(report?.milestones).toEqual([
    { label: "Export", percent: 100 },
    { label: "Import", percent: 30 },
  ]);
  expect(report?.stepGroups).toEqual([{ mode: "go", question: "Path forward: Finish the import", items: ["Fix the date format"], recommended: [] }]);
});

it("reads the questions of ```ui blocks: a Plan is a go-list, Buttons a decision, a Form a decision without items", () => {
  const ask = (code: string) => `**Goal:** Ship\n\n**Done:** Built\n\n### Next steps\n\`\`\`ui\n${code}\n\`\`\``;
  expect(parseStatusReport(ask('Card("Ship it?", [Button("shipit · review, then merge", variant: "primary"), Button("polish · review only")])'), 1)?.stepGroups).toEqual([
    { mode: "choice", question: "Ship it?", items: ["shipit · review, then merge", "polish · review only"], recommended: [1] },
  ]);
  expect(parseStatusReport(ask('Card("Two questions", [Form([Radio($a, ["x", "y"]), Toggle($b, "Now")])])'), 1)?.stepGroups).toEqual([
    { mode: "choice", question: "Two questions", items: [], recommended: [] },
  ]);
  // A button that does something is not a question.
  expect(parseStatusReport(ask('Card("Links", [Button("Open", OpenUrl("https://x.dev"))])'), 1)?.stepGroups).toEqual([]);
  expect(uiStepGroups('Pick one:\n\n```ui\nCard("Cache", [Button("Memory (recommended)"), Button("Redis")])\n```')).toEqual([
    { mode: "choice", question: "Cache", items: ["Memory", "Redis"], recommended: [1] },
  ]);
});

it("has Ultrastatus read every child and check the finished ones", () => {
  const now = 10 * 60 * 60_000;
  const text = ultrastatusRequest(
    "",
    "thr_parent",
    [
      child({ id: "thr_done", title: "Old import", state: "done", reason: "nothing pending" }),
      child({ id: "thr_ask", title: "Billing export", state: "needs", reason: "asked you a question", goal: "Export every invoice", heardAt: now }),
    ],
    now,
  );
  expect(text.startsWith(`${DEFAULT_ULTRASTATUS_PROMPT}\n\n---`)).toBe(true);
  expect(text).toContain("2 child threads: 1 Needs me · 1 Done.");
  expect(text.split("\n").filter((line) => line.startsWith("- thr_"))).toHaveLength(2);
  expect(text).toContain("Read every child that is not done");
  expect(text).toContain("A finished child is a claim like any other");
  expect(text).toContain("Do not message a child to write this report");
  // The short report's own section is not asked for here: the matrix holds the children.
  expect(text).not.toContain("### Children");
  expect(ultrastatusRequest("Tell me everything.", "thr_parent", [child({})]).startsWith("Tell me everything.\n\n---")).toBe(true);
});

it("sends an Ultrastatus report to the status board, as an update or a new board", () => {
  const update = ultrastatusRequest("", "thr_parent", [], 0, "update");
  // The opening the other tools match on is untouched; the board section follows the prompt.
  expect(update.startsWith(`${DEFAULT_ULTRASTATUS_PROMPT}\n\n---\n\nPut the report on this thread's status board`)).toBe(true);
  expect(update).toContain('`mode: "update"`');
  // Only this run counts as an Ultrastatus on the board; the agent's own updates in between don't.
  expect(update).toContain('`kind: "ultrastatus"`');
  expect(update).toContain("`bb genui show-board '$BB_THREAD_STORAGE/board.md' --ultrastatus`");
  expect(update).toContain("Read it first with `bb genui board`");
  // The board is where the user goes on: its next steps and decisions are controls, in both modes.
  expect(update).toContain("put one card named «Next»");
  expect(update).toContain("I send it from the board");
  expect(update).toContain("«What changed since last time» compares with the board's last version");
  // One layout for every board, owned by the board plugin: plain-words lines first, then the visuals under plain questions.
  expect(update).toContain("Lay the board out as the status board layout says");
  expect(update).toContain("`bb genui show-board --help` prints it");
  // On a bug thread the layout's bug tracker takes the bar's place; the prompt hands it to the layout instead of asking for a bar.
  expect(update).toContain("then come the bar (on a bug thread, the layout's bug tracker instead) and the «Next» card");
  expect(update).toContain("Right after the bar or the bug tracker, put one card named «Next»");
  expect(DEFAULT_ULTRASTATUS_PROMPT).toContain("On a bug thread, the bug tracker of the status board layout takes the bar's place");
  // The tracker owns the fix's stages and proof, so the matrix does not repeat them; without the layout the bar stays.
  expect(DEFAULT_ULTRASTATUS_PROMPT).toContain("with neither, keep the bar");
  expect(DEFAULT_ULTRASTATUS_PROMPT).toContain("On a bug thread the tracker already shows the fix's stages and their proof: the matrix holds only other work");
  // Keeping an old board's title and rows does not hold a bug board's title or its old bar rows.
  expect(update).toContain("on a bug thread the layout's tracker rules on the title and on older bar rows come first");
  // Without the board the report still arrives, in the reply.
  expect(update).toContain("put the report in your reply as step 3 says");
  // The fields the monitor reads and the decisions stay in the chat.
  expect(update).toContain("then the closing fields, `### Progress` and `### Next steps`");

  const fresh = ultrastatusRequest("", "thr_parent", [], 0, "new");
  expect(fresh).toContain('`mode: "new"`');
  expect(fresh).toContain("`bb genui show-board '$BB_THREAD_STORAGE/board.md' --new --ultrastatus`");
  expect(fresh).toContain("build it from scratch");
  expect(fresh).not.toContain("Read it first with `bb genui board`");
  expect(fresh).toContain("put one card named «Next»");

  // With children: the prompt, where the report goes, then the children.
  const withChild = ultrastatusRequest("Tell me everything.", "thr_parent", [child({})], 0, "update");
  expect(withChild.startsWith("Tell me everything.\n\n---\n\nPut the report on this thread's status board")).toBe(true);
  expect(withChild.indexOf("This thread has child threads")).toBeGreaterThan(withChild.indexOf("status board"));
});

it("lists more children for Ultrastatus than for Status", () => {
  const many = Array.from({ length: ULTRA_CHILD_ROWS_MAX + 3 }, (_, index) => child({ id: `thr_done${index}`, state: "done" }));
  const rows = (text: string) => text.split("\n").filter((line) => line.startsWith("- thr_"));
  expect(rows(statusRequest("", "thr_parent", many))).toHaveLength(CHILD_ROWS_MAX);
  const ultra = ultrastatusRequest("", "thr_parent", many);
  expect(rows(ultra)).toHaveLength(ULTRA_CHILD_ROWS_MAX);
  expect(ultra).toContain("- 3 more not listed");
});
