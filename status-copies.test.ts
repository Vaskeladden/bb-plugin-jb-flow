import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { copyAnswerPrefix, createStatusCopies } from "./status-copies";
import { createThreadStatus } from "./thread-status";

const report = ["**Goal:** Ship the UI.", "**Done:** The page.", "**Next:** Merge it.", "**Blocked:** Nothing.", "", "### Progress", "- [x] Page"].join("\n");

it("runs a status in a background copy and records its report as the thread's own", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "jb-flow" });
  harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, copyId: "thr_copy01" }));
  const monitor = createThreadStatus(bb, () => {});
  const copies = createStatusCopies(bb, (sourceId, reply) => monitor.record(sourceId, reply));

  expect(await copies.start("thr_main", "Status please", "status")).toBe(true);
  expect(harness.sdk.callsTo("plugins.callRpc").at(-1)?.[0]).toMatchObject({
    pluginId: "genui",
    method: "copy_run",
    input: { threadId: "thr_main", text: "Status please", purpose: "status" },
  });
  expect(await copies.latest("thr_main")).toBeNull();

  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_copy01" }), lastAssistantText: report });
  expect((await monitor.get("thr_main", false))?.report?.goal).toBe("Ship the UI.");
  expect(await copies.latest("thr_main")).toMatchObject({ copyId: "thr_copy01", reply: report });

  // The thread's own agent replies: its reply is the latest again.
  await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_main" }), lastAssistantText: "Merged." });
  expect(await copies.latest("thr_main")).toBeNull();
});

it("leaves the status to the thread itself when no copy can be made", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "jb-flow" });
  const copies = createStatusCopies(bb, async () => {});
  harness.sdk.stub("plugins.callRpc", async () => ({ ok: false, message: "provider does not support fork" }));
  expect(await copies.start("thr_main", "Status please", "ultra")).toBe(false);
  harness.sdk.stub("plugins.callRpc", async () => {
    throw new Error("plugin genui is not installed");
  });
  expect(await copies.start("thr_main", "Status please", "ultra")).toBe(false);
});

it("tells the agent where to read a report it never saw before an answer to it", () => {
  const prefix = copyAnswerPrefix({ copyId: "thr_copy01", at: Date.UTC(2026, 10, 23, 14, 5) });
  expect(prefix).toContain("14:05 UTC");
  expect(prefix).toContain("`bb thread output thr_copy01`");
});
