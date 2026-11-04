// @vitest-environment node
import { expect, it } from "vitest";
import { DEFAULT_STATUS_PROMPT, handBackInstructions } from "./status-prompt";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  createThreadStatus,
  parseStatusReport,
  recordThreadStatus,
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
      question: "",
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
