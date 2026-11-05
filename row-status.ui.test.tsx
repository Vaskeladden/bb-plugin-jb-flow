import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { rowStatus } from "./ui-extras";

const NOW = 10_000_000_000;
const idle = { id: "t", status: "idle", isUnread: false } as unknown as PluginSidebarThread;

describe("row status for a waiting agent", () => {
  it("an idle thread that promised to report back shows an hourglass, not the idle dot", () => {
    const status = rowStatus(idle, false, undefined, [], null, { kind: "promised", since: NOW - 60_000 }, NOW);
    expect(status.glyph).toBe("hourglass");
    expect(status.label).toBe("Waiting: the agent will report back");
  });

  it("the same promise turns orange once nothing has run for an hour", () => {
    const status = rowStatus(idle, false, undefined, [], null, { kind: "promised", since: NOW - 2 * 3_600_000 }, NOW);
    expect(status.tone).toBe("text-orange-500");
    expect(status.label).toMatch(/^Stalled/);
  });

  it("waiting on someone else is its own label", () => {
    expect(rowStatus(idle, false, undefined, [], null, { kind: "others", since: NOW }, NOW).label).toBe("Waiting on someone else");
  });

  it("a real watch and a running agent win over a promise", () => {
    const promise = { kind: "promised" as const, since: NOW };
    expect(rowStatus(idle, false, { kind: "ci", label: "Watching web-app · Deploy" }, [], null, promise, NOW).label).toBe("Watching web-app · Deploy");
    expect(rowStatus(idle, true, undefined, [], null, promise, NOW).glyph).toBe("spinner");
  });

  it("without a promise an idle thread stays idle", () => {
    expect(rowStatus(idle, false, undefined, [], null, undefined, NOW).label).toBe("Idle");
  });

  it("a question for you shows a question mark, amber until read", () => {
    const asks = { kind: "asks" as const, since: NOW };
    const unread = { ...idle, isUnread: true } as unknown as PluginSidebarThread;
    expect(rowStatus(unread, false, undefined, [], null, asks, NOW)).toMatchObject({ glyph: "question", tone: "text-amber-500" });
    expect(rowStatus(idle, false, undefined, [], null, asks, NOW)).toMatchObject({ glyph: "question", tone: "text-sky-500" });
    expect(rowStatus(idle, false, { kind: "ci", label: "Watching" }, [], null, asks, NOW).glyph).toBe("question");
  });
});
