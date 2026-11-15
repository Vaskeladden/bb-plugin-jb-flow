// Tracks which thread the user is looking at, so external controllers (a
// Stream Deck, scripts) can act on "the focused thread" through the CLI
// instead of synthesizing keystrokes. Every BB window reports its focused pane
// over RPC. The window you last physically used (click, key, pointer) wins: with
// BB open on two Macs, both windows can have OS focus on their own machine.
import { everyThread } from "./all-threads";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const focusReportSchema = z.object({
  clientId: z.string().min(1).max(64),
  threadId: z.string().nullable(),
  windowFocused: z.boolean(),
  /** Last click, key press or pointer movement in that window (ms). */
  interactedAt: z.number().optional(),
  /** Where the window runs, for `bb jb-flow focus-clients`. */
  origin: z.string().max(200).optional(),
  userAgent: z.string().max(300).optional(),
});
type FocusReport = z.infer<typeof focusReportSchema> & { at: number };

/** Reports older than this are ignored (a closed window stops reporting). */
const STALE_MS = 15 * 60_000;

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/**
 * Failed, blocked on a prompt, or idle with a last message that asks you
 * something (`awaiting`). The next action decides, not read state: reading a
 * question doesn't answer it, and bold already shows unread.
 */
export function needsAttention(thread: Thread, awaiting: Record<string, number>): boolean {
  return (
    thread.status === "error" ||
    thread.hasPendingInteraction ||
    (thread.status === "idle" && awaiting[thread.id] !== undefined)
  );
}

export function createFocus(
  bb: BbPluginApi,
  getAwaiting: () => Promise<Record<string, number>>,
  getSnoozedSectionId: () => Promise<string | null>,
) {
  const reports = new Map<string, FocusReport>();

  // Last known focus survives plugin reloads and quiet windows, so a deck key
  // pressed while another app is in front still reaches the thread you left.
  let lastFocused: string | null = null;
  void bb.storage.kv.get<string>("lastFocused").then((value) => {
    lastFocused ??= value ?? null;
  });

  function report(input: z.infer<typeof focusReportSchema>) {
    reports.set(input.clientId, { ...input, at: Date.now() });
    const current = focusedThreadId();
    if (current !== null && current !== lastFocused) {
      lastFocused = current;
      void bb.storage.kv.set("lastFocused", current);
    }
  }

  function focusedThreadId(): string | null {
    const fresh = [...reports.values()].filter((entry) => Date.now() - entry.at < STALE_MS && entry.threadId !== null);
    // Most recently used window first. Without recent use, a window on this
    // machine (where the deck is plugged in) beats a remote one, then OS focus.
    const local = (entry: FocusReport) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(entry.origin ?? "");
    fresh.sort(
      (a, b) =>
        (b.interactedAt ?? 0) - (a.interactedAt ?? 0) ||
        Number(local(b)) - Number(local(a)) ||
        Number(b.windowFocused) - Number(a.windowFocused) ||
        b.at - a.at,
    );
    return fresh[0]?.threadId ?? lastFocused;
  }

  /** Debug view of the windows reporting focus. */
  function clients() {
    return [...reports.values()].sort((a, b) => (b.interactedAt ?? 0) - (a.interactedAt ?? 0));
  }

  async function requireFocused(): Promise<string> {
    const threadId = focusedThreadId();
    if (threadId === null) {
      throw new Error("No focused thread. Open a thread in BB (the window must have reported focus).");
    }
    return threadId;
  }

  /** Threads that need the user, oldest attention first (inbox order). */
  async function needsMe() {
    const threads: Thread[] = await everyThread((page) => bb.sdk.threads.list(page));
    const awaiting = await getAwaiting();
    // Snoozed threads stay hidden until they wake, as in the sidebar.
    const snoozedSectionId = await getSnoozedSectionId();
    return threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.visibility === "visible" &&
          thread.parentThreadId === null &&
          (snoozedSectionId === null || thread.sectionId !== snoozedSectionId) &&
          needsAttention(thread, awaiting),
      )
      .sort((a, b) => (a.latestAttentionAt ?? 0) - (b.latestAttentionAt ?? 0));
  }

  return { report, focusedThreadId, requireFocused, needsMe, clients };
}
