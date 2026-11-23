// Status and Ultrastatus in a background copy of the thread.
//
// The genui plugin forks the thread (its `copy_run` RPC): a hidden copy with
// the conversation up to the last finished turn answers the report prompt and
// puts it on the thread's status board, while the thread's own agent keeps
// working. When the copy goes idle, its reply is recorded as the thread's
// status (the card shows it) and kept as the thread's latest report until the
// thread's own agent replies again, so the card's answer buttons act on it and
// an answer tells the agent where to read it. Without genui, or for an agent
// bb can't fork, the caller asks the thread itself as before.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const COPY_PLUGIN = "genui";
export const COPY_METHOD = "copy_run";
/** The longest copy reply kept for the answer buttons; a report is far shorter. */
export const COPY_REPLY_MAX = 40_000;

const pendingSchema = z.object({ sourceId: z.string(), at: z.number() });
const latestSchema = z.object({ copyId: z.string(), at: z.number(), reply: z.string() });
export type CopyReport = z.infer<typeof latestSchema>;

const copyResult = z.union([z.object({ ok: z.literal(true), copyId: z.string() }), z.object({ ok: z.literal(false), message: z.string() })]);

/**
 * The line put before an answer to a report a copy wrote: the thread's own
 * agent never saw that report, so it reads it first.
 */
export function copyAnswerPrefix(report: Pick<CopyReport, "copyId" | "at">): string {
  const at = new Date(report.at).toISOString().slice(11, 16);
  return `[This answers the status report a background copy of you wrote at ${at} UTC, which is not in your history. Read it first: \`bb thread output ${report.copyId}\`]`;
}

export function createStatusCopies(bb: BbPluginApi, record: (sourceId: string, reply: string) => Promise<unknown>) {
  const pendingKey = (copyId: string) => `statusCopy:${copyId}`;
  const latestKey = (sourceId: string) => `statusCopyLatest:${sourceId}`;

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const pending = pendingSchema.safeParse(await bb.storage.kv.get(pendingKey(thread.id)));
    if (!pending.success) {
      // The thread's own agent replied: its reply is the latest again.
      await bb.storage.kv.delete(latestKey(thread.id));
      return;
    }
    const reply = (lastAssistantText ?? "").trim();
    if (reply === "") return;
    const { sourceId } = pending.data;
    await bb.storage.kv.delete(pendingKey(thread.id));
    await bb.storage.kv.set(latestKey(sourceId), { copyId: thread.id, at: Date.now(), reply: reply.slice(0, COPY_REPLY_MAX) });
    await record(sourceId, reply);
  });

  return {
    /** Runs the report in a copy; false when no copy could be made, so the caller asks the thread itself. */
    async start(sourceId: string, text: string, purpose: "status" | "ultra"): Promise<boolean> {
      let result: z.infer<typeof copyResult>;
      try {
        result = await bb.sdk.plugins.callRpc({
          pluginId: COPY_PLUGIN,
          method: COPY_METHOD,
          input: { threadId: sourceId, text, purpose },
          outputSchema: copyResult,
        });
      } catch (cause) {
        bb.log.warn(`status: no background copy for ${sourceId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
      if (!result.ok) return false;
      await bb.storage.kv.set(pendingKey(result.copyId), { sourceId, at: Date.now() });
      return true;
    },
    /** The report a copy wrote for this thread, while the thread's own agent has not replied since. */
    async latest(sourceId: string): Promise<CopyReport | null> {
      const parsed = latestSchema.safeParse(await bb.storage.kv.get(latestKey(sourceId)));
      return parsed.success ? parsed.data : null;
    },
  };
}
