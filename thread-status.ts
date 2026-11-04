import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const statusReportSchema = z.object({
  goal: z.string().max(1000),
  done: z.string().max(1000),
  next: z.string().max(1000),
  blocked: z.string().max(1000),
  milestones: z
    .array(
      z.object({
        label: z.string().max(160),
        percent: z.number().min(0).max(100),
      }),
    )
    .max(12),
  /**
   * The report's "Next steps", one group per **Path forward:** or **Decision
   * needed:** block: steps to run with "go" (all, or "go 1,3"), or a decision
   * answered with a number. A report can hold both. Optional: older saved
   * reports lack it.
   */
  stepGroups: z
    .array(
      z.object({
        mode: z.enum(["go", "choice"]),
        question: z.string().max(300),
        items: z.array(z.string().max(300)).max(9),
        recommended: z.array(z.number()).max(9),
      }),
    )
    .max(9)
    .optional(),
  /** "Doing now: …": the agent is already carrying on, nothing to pick. */
  doingNow: z.string().max(500).optional(),
  capturedAt: z.number(),
});
export const threadStatusSchema = z.object({
  threadId: z.string(),
  report: statusReportSchema.nullable(),
  latest: z.string().max(1000),
  latestAt: z.number(),
  replyHash: z.string(),
});
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export type StatusReport = z.infer<typeof statusReportSchema>;
const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Read a status report (Goal/Done/Next/Blocked/Progress). Never infer a global completion percentage. */
export function parseStatusReport(
  reply: string,
  capturedAt: number,
): StatusReport | null {
  const field = (name: string) => {
    const match = new RegExp(
      `^\\s*(?:[-*]\\s+)?\\*\\*${name}:\\*\\*\\s*(.*)$`,
      "im",
    ).exec(reply);
    const value = plain(match?.[1] ?? "").slice(0, 1000);
    return /^(?:n\/?a|none|not applicable)[.!]?$/i.test(value) ? "" : value;
  };
  const fields = {
    goal: field("Goal"),
    done: field("Done"),
    next: field("Next"),
    blocked: field("Blocked"),
  };
  // Require a report-shaped response; an incidental **Next:** isn't a status report.
  if (Object.values(fields).filter(Boolean).length < 2) return null;
  const section =
    /(?:^|\n)###\s+Progress\s*\r?\n([\s\S]*?)(?=\n###\s|$)/i.exec(reply)?.[1] ??
    "";
  const milestones: StatusReport["milestones"] = [];
  for (const line of section.split("\n")) {
    const match = /^\s*\[([█░]+)\]\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const percentText = /\b(\d{1,3}(?:\.\d+)?)%/.exec(match[2]!);
    const percent = percentText
      ? Number(percentText[1])
      : /\bdone\b/i.test(match[2]!)
        ? 100
        : (Array.from(match[1]!).filter((char) => char === "█").length /
            match[1]!.length) *
          100;
    if (percent < 0 || percent > 100) continue;
    const label = plain(
      match[2]!
        .replace(/\s*\d+(?:\.\d+)?%.*$/, "")
        .replace(/\s+done\s*$/i, "")
        .replace(/\s*←.*$/, ""),
    ).slice(0, 160);
    if (label) milestones.push({ label, percent });
    if (milestones.length === 12) break;
  }
  return { ...fields, milestones, ...parseNextSteps(reply), capturedAt };
}

export type StepGroup = NonNullable<StatusReport["stepGroups"]>[number];

const NUMBERED = /^\s*(\d+)[.)]\s+(.+)$/;
const GROUP_HEADING = /\*\*(Path forward|Decision needed):\*\*/i;
const MAX_STEP_GROUPS = 9;

/** The line that introduces a group: the last text before its list, without its label or "A." prefix. */
function questionOf(lines: readonly string[]): string {
  const first = lines.findIndex((line) => NUMBERED.test(line));
  const intro = lines.slice(0, first).filter((line) => line.trim() !== "" && !/\*\*Recommended|^\s*\[!\w+\]/i.test(line));
  const text = (intro[intro.length - 1] ?? "").replace(/\*\*(Decision needed|Path forward):\*\*/i, "");
  return plain(text).replace(/^[A-Z][.)]\s+/, "").slice(0, 300);
}

/** One block of numbered lines: a go-list, or a decision when it asks one. */
function stepGroup(lines: readonly string[], decision: boolean): StepGroup | null {
  const text = lines.join("\n");
  const items: string[] = [];
  const recommended: number[] = [];
  for (const line of lines) {
    const match = NUMBERED.exec(line);
    if (!match) continue;
    if (/\(recommended\)/i.test(match[2]!)) recommended.push(items.length + 1);
    items.push(plain(match[2]!.replace(/\s*\(recommended\)\s*/i, " ")).slice(0, 300));
    if (items.length === 9) break;
  }
  if (!items.length) return null;
  // "**Recommended:** 1" or "1,3" names steps by number.
  const named = /\*\*Recommended:?\*\*:?\s*([\d,\s]+)(?:$|\n)/i.exec(text)?.[1];
  for (const n of named?.match(/\d+/g) ?? []) if (Number(n) <= items.length && !recommended.includes(Number(n))) recommended.push(Number(n));
  return { mode: decision ? "choice" : "go", question: questionOf(lines), items, recommended };
}

/**
 * The "### Next steps" section: go-lists and numbered decisions, one group per
 * **Path forward:** or **Decision needed:** block, or "Doing now". Agents also
 * ask several questions under one heading, each list numbered from 1 under its
 * own line, so a list that restarts at 1 is a new group too.
 */
export function parseNextSteps(reply: string): Pick<StatusReport, "stepGroups" | "doingNow"> {
  const section =
    /(?:^|\n)#{2,4}\s+Next steps?\s*\r?\n([\s\S]*?)(?=\n#{1,4}\s|$)/i.exec(reply)?.[1] ?? "";
  if (!section.trim()) return {};
  const lines = section.split("\n").map((line) => line.replace(/^\s*(?:>\s?)+/, ""));
  const doing = /\*\*Doing now:\*\*\s*(.+)/i.exec(lines.join("\n"))?.[1];
  const blocks: { lines: string[]; decision: boolean }[] = [{ lines: [], decision: false }];
  for (const line of lines) {
    const current = blocks[blocks.length - 1]!;
    const hasList = current.lines.some((candidate) => NUMBERED.test(candidate));
    if (GROUP_HEADING.test(line) && hasList) {
      blocks.push({ lines: [line], decision: /Decision needed/i.test(line) });
      continue;
    }
    if (NUMBERED.exec(line)?.[1] === "1" && hasList) {
      // The new question's own line sits after the last list and moves with it.
      // Without such a line this is one list written as 1. 1. 1., or an item's indented detail.
      const lastItem = current.lines.reduce((last, candidate, index) => (NUMBERED.test(candidate) ? index : last), -1);
      if (current.lines.slice(lastItem + 1).some((candidate) => /^\S/.test(candidate))) {
        blocks.push({ lines: [...current.lines.splice(lastItem + 1), line], decision: current.decision });
        continue;
      }
    }
    if (/\*\*Decision needed:\*\*/i.test(line)) current.decision = true;
    current.lines.push(line);
  }
  const stepGroups = blocks
    .map((block) => stepGroup(block.lines, block.decision))
    .filter((group): group is StepGroup => group !== null)
    .slice(0, MAX_STEP_GROUPS);
  return { stepGroups, ...(doing ? { doingNow: plain(doing).slice(0, 500) } : {}) };
}

export function recordThreadStatus(
  threadId: string,
  reply: string,
  previous: ThreadStatus | null,
  now: number,
): ThreadStatus | null {
  if (!reply.trim()) return previous;
  const replyHash = createHash("sha256").update(reply).digest("hex");
  if (previous?.replyHash === replyHash) return previous;
  return {
    threadId,
    report: parseStatusReport(reply, now) ?? previous?.report ?? null,
    latest: plain(reply).slice(0, 1000),
    latestAt: now,
    replyHash,
  };
}

/** One bounded durable record per thread, shared by every BB window and device. */
export function createThreadStatus(bb: BbPluginApi, changed: () => void) {
  const pending = new Map<string, Promise<unknown>>();
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
  });
  const key = (id: string) => `thread-status:${id}`;
  const read = async (id: string) => {
    const parsed = threadStatusSchema.safeParse(
      await bb.storage.kv.get(key(id)),
    );
    return parsed.success && parsed.data.threadId === id ? parsed.data : null;
  };
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const result = (pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };
  const capture = (id: string, supplied?: string | null) =>
    serial(id, async () => {
      if (disposed) return null;
      const previous = await read(id);
      const reply =
        supplied === undefined
          ? await bb.sdk.threads.output({ threadId: id }).then(
              (result) => result.output,
              () => null,
            )
          : supplied;
      if (disposed) return previous;
      const next = recordThreadStatus(id, reply ?? "", previous, Date.now());
      if (next && next !== previous) {
        await bb.storage.kv.set(key(id), next);
        changed();
      }
      return next;
    });
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    capture(thread.id, lastAssistantText).then(() => {}),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    serial(thread.id, async () => {
      if (!disposed) await bb.storage.kv.delete(key(thread.id));
    }),
  );
  return {
    get: (id: string, refresh = true) =>
      refresh
        ? capture(id)
        : serial(id, () => (disposed ? Promise.resolve(null) : read(id))),
  };
}
