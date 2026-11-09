// The reply a turn really ended on. bb shows only a turn's last message in
// full and folds earlier ones into the work log. Agents sometimes write the
// report or question, call thread_state, then add a one-line sign-off
// ("I've stopped here and am waiting for your two answers."). Reading only
// that line loses the questions, so a short last message that holds no report
// is read together with the turn's latest message that does.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseStatusReport } from "./thread-status.ts";

type Message = { turnId: string | null; seq: number; text: string };

/** A message worth showing as the reply: a status report, a decision or a ui block. */
export function holdsReply(text: string): boolean {
  return parseStatusReport(text, 0) !== null || /\*\*(?:Decision needed|Path forward):\*\*|```ui\b/i.test(text);
}

/** Whether a last message is only a sign-off, so the turn's earlier reply should be read with it. */
export function isSignOff(text: string): boolean {
  return text.trim().length < 400 && !holdsReply(text);
}

/** The assistant messages anywhere in a timeline response, oldest first. */
export function assistantMessages(timeline: unknown): Message[] {
  const found = new Map<number, Message>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.role === "assistant" && typeof row.messageSeq === "number" && typeof row.text === "string") {
      found.set(row.messageSeq, { turnId: typeof row.turnId === "string" ? row.turnId : null, seq: row.messageSeq, text: row.text });
    }
    Object.values(row).forEach(walk);
  };
  walk(timeline);
  return [...found.values()].sort((a, b) => a.seq - b.seq);
}

/** The last message with the turn's earlier reply in front of it when the last one is only a sign-off. */
export function withEarlierReply(messages: readonly Message[], last: string): string {
  const final = messages.at(-1);
  if (!final || !isSignOff(last)) return last;
  const earlier = messages
    .filter((message) => message.turnId === final.turnId && message.seq < final.seq)
    .reverse()
    .find((message) => holdsReply(message.text));
  return earlier ? `${earlier.text}\n\n${last}` : last;
}

/** The thread's last reply as the user should read it. */
export async function turnReply(bb: BbPluginApi, threadId: string, last: string | null, signal?: AbortSignal): Promise<string | null> {
  if (last === null || !isSignOff(last)) return last;
  // A failed read (or a host without timelines) keeps the last message as it is.
  const timeline = await Promise.resolve()
    .then(() => bb.sdk.threads.timeline({ threadId, segmentLimit: "1", includeNestedRows: "true", deferContent: "false", signal }))
    .catch(() => null);
  return withEarlierReply(assistantMessages(timeline), last);
}

/** threads.output, read through turnReply. */
export async function lastReply(bb: BbPluginApi, threadId: string, signal?: AbortSignal): Promise<string | null> {
  const output = await bb.sdk.threads.output({ threadId, signal }).catch(() => null);
  return turnReply(bb, threadId, output?.output ?? null, signal);
}
