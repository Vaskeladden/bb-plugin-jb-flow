// Which section a new thread belongs in. bb creates a thread without a
// section unless the caller names one, so a thread an agent spawns, a forked
// thread and an automation's run all land in Unassigned, away from the work
// they belong to. A new thread goes where the thread it came from is.

/** The fields of a thread this rule reads. */
export type PlacedThread = {
  id: string;
  sectionId: string | null;
  parentThreadId: string | null;
  sourceThreadId: string | null;
};

/** The fields of an automation this rule reads (`bb automation list --json`). */
export type AutomationOrigin = {
  id: string;
  createdByThreadId: string | null;
  lastRunThreadId: string | null;
};

/** The thread a thread came from: its parent, else the thread it was forked from. */
const cameFrom = (thread: PlacedThread): string | null => thread.parentThreadId ?? thread.sourceThreadId;

/**
 * The section for a thread that has none: the section of the thread it came
 * from (`origin` names that thread for one with no parent, such as an
 * automation's run). A thread in Snoozed counts as being in the section it
 * was snoozed from, and one without a section passes the question on to the
 * thread it came from itself. Null when nothing along the way has a section:
 * the thread stays in Unassigned.
 */
export function sectionForNewThread(
  thread: PlacedThread,
  origin: string | null,
  threads: ReadonlyMap<string, PlacedThread>,
  snoozedSectionId: string | null,
  snoozedFrom: (threadId: string) => string | null,
): string | null {
  if (thread.sectionId !== null) return null;
  const seen = new Set([thread.id]);
  for (let id = cameFrom(thread) ?? origin; id !== null && !seen.has(id); ) {
    seen.add(id);
    const from = threads.get(id);
    if (!from) return null;
    const section = snoozedSectionId !== null && from.sectionId === snoozedSectionId ? snoozedFrom(from.id) : from.sectionId;
    if (section !== null) return section;
    id = cameFrom(from);
  }
  return null;
}

/**
 * The thread that created the automation a run belongs to. The automation is
 * the one that names this thread as its last run, or the one whose id the
 * run's first message carries (`[bb automation due:<id>]`, which is all a run
 * has before the automation records it).
 */
export function automationCreator(threadId: string, firstMessage: string | null, automations: readonly AutomationOrigin[]): string | null {
  const named = /\[bb automation [a-z-]+:([\w-]+)\]/.exec(firstMessage ?? "")?.[1];
  const automation = automations.find((candidate) => candidate.lastRunThreadId === threadId) ?? automations.find((candidate) => candidate.id === named);
  return automation?.createdByThreadId ?? null;
}
