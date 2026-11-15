// Which section a snoozed thread came from, and where it goes when it wakes.
// The Snoozed section is only a parking place: a thread must come back to the
// section it was in, however many times it was snoozed again in between.

/**
 * The section to remember when a thread is snoozed. A thread snoozed again
 * keeps the section it first came from; one that already sits in Snoozed
 * without a record came from nowhere we know (null: Unassigned).
 */
export function sectionSnoozedFrom(remembered: string | null | undefined, current: string | null, snoozedSectionId: string): string | null {
  return remembered ?? (current === snoozedSectionId ? null : current);
}

/** Where a woken thread goes: the section it came from, or Unassigned (null) when that section is gone. */
export function sectionOnWake(fromSectionId: string | null, existingSectionIds: readonly string[]): string | null {
  return fromSectionId !== null && existingSectionIds.includes(fromSectionId) ? fromSectionId : null;
}
