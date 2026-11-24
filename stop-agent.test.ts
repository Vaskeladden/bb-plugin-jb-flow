import assert from "node:assert/strict";
import test from "node:test";
import { STOP_AGENT_SHORTCUT, isRunningStatus, runningThreadIds, stopAgentCommand } from "./stop-agent.ts";

function harness(running: string[]) {
  const stopped: string[] = [];
  const command = stopAgentCommand({
    isRunning: (threadId) => running.includes(threadId),
    stop: async (threadId) => {
      stopped.push(threadId);
    },
  });
  return { command, stopped };
}

test("the default key is ⌘⇧⌫ (Ctrl+Shift+Backspace off macOS)", () => {
  assert.deepEqual(STOP_AGENT_SHORTCUT, { key: "Backspace", mod: true, shift: true });
  assert.equal(harness([]).command.defaultShortcut, STOP_AGENT_SHORTCUT);
});

test("running means a turn is starting or under way, as bb's stop button", () => {
  assert.equal(isRunningStatus("active"), true);
  assert.equal(isRunningStatus("starting"), true);
  for (const status of ["idle", "error", "pending", "stopping", null, undefined]) assert.equal(isRunningStatus(status), false);
  const ids = runningThreadIds([
    { id: "a", status: "active" },
    { id: "b", status: "idle" },
    { id: "c", status: "starting" },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "c"]);
});

test("available only in a thread whose agent is running", () => {
  const { command } = harness(["busy"]);
  assert.equal(command.isAvailable({ threadId: "busy" }), true);
  assert.equal(command.isAvailable({ threadId: "quiet" }), false);
  assert.equal(command.isAvailable({ threadId: null }), false);
});

test("stops the thread in view and nothing else", async () => {
  const { command, stopped } = harness(["busy", "other"]);
  await command.run({ threadId: "busy" });
  await command.run({ threadId: "quiet" });
  await command.run({ threadId: null });
  assert.deepEqual(stopped, ["busy"]);
});
