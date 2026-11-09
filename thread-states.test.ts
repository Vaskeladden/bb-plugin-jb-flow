import { describe, expect, it } from "vitest";
import { STALLED_AFTER_MS, THREAD_STATES, threadState, type ThreadStateFacts, type ThreadStateThread } from "./thread-states";
import { declaredState, flagsFor } from "./awaiting";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const thread = (overrides: Partial<ThreadStateThread> = {}): ThreadStateThread => ({
  id: "t",
  status: "idle",
  updatedAt: NOW - 10 * 60_000,
  hasPendingInteraction: false,
  indicator: null,
  ...overrides,
});
const pr = (attention: string, state: "open" | "draft" | "merged" | "closed" = "open", number = 7) => ({
  repo: "acme/web-app",
  number,
  state,
  attention: attention as never,
});
const facts = (overrides: Partial<ThreadStateFacts> = {}): ThreadStateFacts => ({
  awaiting: {},
  watching: {},
  promised: {},
  waitingOthers: {},
  threadPrs: {},
  ...overrides,
});
const ci = { kind: "ci" as const, label: "Watching web-app#7 (checks)" };
const stateOf = (t: ThreadStateThread, f: ThreadStateFacts) => threadState(t, f, NOW);

describe("threadState: one state per thread, by precedence", () => {
  it("lands every overlapping combination in exactly one state", () => {
    const busy = thread({ status: "active" });
    const idle = thread();
    const stale = thread({ updatedAt: NOW - 2 * HOUR });
    const cases: Array<[string, ThreadStateThread, ThreadStateFacts, string]> = [
      ["declared needs + busy", busy, facts({ awaiting: { t: NOW } }), "running"],
      ["busy + red PR", busy, facts({ threadPrs: { t: [pr("checks_failed")] } }), "running"],
      ["parked + asked you", idle, facts({ parked: { t: NOW }, awaiting: { t: NOW } }), "parked"],
      ["parked + red PR", idle, facts({ parked: { t: NOW }, threadPrs: { t: [pr("checks_failed")] } }), "parked"],
      ["parked + busy", busy, facts({ parked: { t: NOW } }), "running"],
      ["busy + watching", busy, facts({ watching: { t: ci } }), "running"],
      ["busy + green PR", busy, facts({ threadPrs: { t: [pr("ready_to_merge")] } }), "running"],
      ["prompt while busy", thread({ status: "active", hasPendingInteraction: true }), facts(), "needs"],
      ["error", thread({ status: "error" }), facts({ watching: { t: ci } }), "needs"],
      ["asks + watching", idle, facts({ awaiting: { t: NOW }, watching: { t: ci } }), "needs"],
      ["asks + green PR", idle, facts({ awaiting: { t: NOW }, threadPrs: { t: [pr("ready_to_merge")] } }), "needs"],
      ["red PR, nothing watching", idle, facts({ threadPrs: { t: [pr("conflicts")] } }), "needs"],
      ["red PR + waiting on others", idle, facts({ waitingOthers: { t: NOW }, threadPrs: { t: [pr("changes_requested")] } }), "needs"],
      ["stalled promise", stale, facts({ promised: { t: NOW - 2 * HOUR } }), "needs"],
      ["red PR + watching", idle, facts({ watching: { t: ci }, threadPrs: { t: [pr("checks_failed")] } }), "autopilot"],
      ["red PR + fresh promise", idle, facts({ promised: { t: NOW }, threadPrs: { t: [pr("checks_failed")] } }), "autopilot"],
      ["stale promise + watching", stale, facts({ promised: { t: NOW }, watching: { t: ci } }), "autopilot"],
      ["fresh promise", idle, facts({ promised: { t: NOW } }), "autopilot"],
      ["waiting on others", idle, facts({ waitingOthers: { t: NOW } }), "autopilot"],
      ["waiting on others + green PR", idle, facts({ waitingOthers: { t: NOW }, threadPrs: { t: [pr("ready_to_merge")] } }), "autopilot"],
      ["PRs waiting for review", idle, facts({ threadPrs: { t: [pr("review_requested")] } }), "autopilot"],
      ["green PR + watching", idle, facts({ watching: { t: ci }, threadPrs: { t: [pr("ready_to_merge")] } }), "autopilot"],
      ["green PR", idle, facts({ threadPrs: { t: [pr("ready_to_merge")] } }), "ready"],
      ["settled PRs", stale, facts({ threadPrs: { t: [pr("merged", "merged")] } }), "ready"],
      ["nothing", idle, facts(), "ready"],
      ["no facts at all", idle, null as never, "ready"],
    ];
    for (const [name, t, f, expected] of cases) {
      const result = threadState(t, f, NOW);
      expect(THREAD_STATES.filter((id) => id === result.state), name).toHaveLength(1);
      expect(result.state, name).toBe(expected);
    }
  });

  it("says why", () => {
    expect(stateOf(thread(), facts({ awaiting: { t: NOW } }))).toMatchObject({ state: "needs", reason: "asked you a question" });
    expect(stateOf(thread(), facts({ threadPrs: { t: [pr("checks_failed")] } })).reason).toBe("red PR web-app#7 (checks failed), nothing watching");
    expect(stateOf(thread({ updatedAt: NOW - 2 * HOUR }), facts({ promised: { t: NOW } })).reason).toBe("promised to report back, idle 2 h");
    expect(stateOf(thread(), facts({ watching: { t: ci } })).reason).toBe("Watching web-app#7 (checks)");
    expect(stateOf(thread(), facts({ waitingOthers: { t: NOW } })).reason).toBe("waiting on someone else");
    expect(stateOf(thread(), facts({ threadPrs: { t: [pr("ready_to_merge")] } })).reason).toBe("green PR web-app#7 ready to ship");
    expect(stateOf(thread(), facts()).reason).toBe("nothing pending");
    expect(stateOf(thread({ status: "error" }), facts()).reason).toBe("the last turn failed");
    expect(stateOf(thread({ status: "active" }), facts({ threadPrs: { t: [pr("conflicts")] } }))).toMatchObject({
      state: "running",
      reason: "agent working; red PR web-app#7 (conflicts)",
      badges: ["red PR"],
    });
  });

  it("turns a promise into Needs me only after an hour idle", () => {
    const promised = facts({ promised: { t: NOW } });
    expect(stateOf(thread({ updatedAt: NOW - STALLED_AFTER_MS + 60_000 }), promised).state).toBe("autopilot");
    expect(stateOf(thread({ updatedAt: NOW - STALLED_AFTER_MS - 60_000 }), promised).state).toBe("needs");
  });
});

describe("declared states", () => {
  it("maps the older names onto the new three", () => {
    expect(declaredState("will_report_back")).toBe("autopilot");
    expect(declaredState("waiting_on_others")).toBe("autopilot");
    expect(declaredState("done")).toBe("ready");
    expect(declaredState("needs_you")).toBe("needs_you");
  });

  it("sets one flag: autopilot waits on a person when its words say so", () => {
    expect(flagsFor("autopilot", "CI is running; a message arrives when it ends.")).toEqual({ asks: false, promised: true, waiting: false });
    expect(flagsFor("autopilot", "Waiting for Alex to approve the PR.")).toEqual({ asks: false, promised: false, waiting: true });
    expect(flagsFor("ready")).toEqual({ asks: false, promised: false, waiting: false });
    expect(flagsFor("needs_you")).toEqual({ asks: true, promised: false, waiting: false });
  });
});
